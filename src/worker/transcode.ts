import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { query } from '../db.ts';
import { log } from '../logger.ts';
import { downloadToFile, uploadFile } from '../storage.ts';
import { buildFfmpegArgs, probe, runFfmpeg, tailLines, type FilterMode } from './ffmpeg.ts';
import type { Job } from './types.ts';

const SEGMENT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export async function handleTranscode(job: Job): Promise<void> {
  if (!job.target_id || !job.user_id) throw new Error('transcode job sin target_id/user_id');
  if (!job.source_path) throw new Error('transcode job sin source_path');

  const jobDir = join(config.workDir, job.id);
  const srcPath = join(jobDir, 'input');
  const outDir = join(jobDir, 'out');

  try {
    await rm(jobDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const sourceBucket = job.source_bucket ?? config.sourceBucket;
    log.info('transcode.download', { jobId: job.id, bucket: sourceBucket, targetId: job.target_id });
    await downloadToFile(sourceBucket, job.source_path, srcPath);

    let info;
    try {
      info = await probe(srcPath);
    } catch (err) {
      log.warn('transcode.probe_failed', { jobId: job.id, err: String(err) });
      info = { isHdr: false, hasAudio: true } as Awaited<ReturnType<typeof probe>>;
    }

    let mode: FilterMode = info.isHdr ? 'tonemap' : 'basic';
    log.info('transcode.ffmpeg_start', { jobId: job.id, mode, isHdr: info.isHdr, transfer: info.transfer });

    let res = await runFfmpeg(buildFfmpegArgs(srcPath, outDir, mode));
    if (res.code !== 0 && mode === 'tonemap') {
      // El build de ffmpeg puede no traer libzimg, o el filtro tonemap puede
      // fallar. Reintentamos con el filtro básico (scale + format).
      log.warn('transcode.tonemap_failed_fallback', {
        jobId: job.id,
        code: res.code,
        stderr: tailLines(res.stderr),
      });
      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });
      mode = 'basic';
      res = await runFfmpeg(buildFfmpegArgs(srcPath, outDir, mode));
    }
    if (res.code !== 0) {
      throw new Error(`ffmpeg exit ${res.code} (mode=${mode}): ${tailLines(res.stderr)}`);
    }

    const segments = (await readdir(outDir)).filter((f) => f.endsWith('.ts')).sort();
    if (segments.length === 0) throw new Error('ffmpeg no generó segmentos');

    const base = `${job.user_id}/${job.target_id}`;
    log.info('transcode.upload', { jobId: job.id, segments: segments.length, mode });

    // Segmentos primero...
    for (const name of segments) {
      await uploadFile(config.hlsBucket, `${base}/${name}`, join(outDir, name), {
        contentType: 'video/mp2t',
        cacheControl: SEGMENT_CACHE_CONTROL,
        upsert: true,
      });
    }
    // ...el playlist AL FINAL (nunca referencia un segmento que no esté ya arriba).
    await uploadFile(config.hlsBucket, `${base}/index.m3u8`, join(outDir, 'index.m3u8'), {
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'no-cache',
      upsert: true,
    });

    const hlsPath = `${base}/index.m3u8`;
    const table = job.kind === 'story' ? 'stories' : 'posts';
    await query(
      `update public.${table} set hls_path = $1, playback_status = 'ready' where id = $2`,
      [hlsPath, job.target_id],
    );

    log.info('transcode.done', { jobId: job.id, hlsPath, mode, segments: segments.length });
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
