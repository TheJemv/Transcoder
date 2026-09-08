import { spawn } from 'node:child_process';
import { config } from '../config.ts';

export interface ProbeResult {
  transfer?: string;
  primaries?: string;
  hasAudio: boolean;
  isHdr: boolean;
}

export type FilterMode = 'tonemap' | 'basic';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 1_000_000;

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_CAPTURE) stdout = stdout.slice(-MAX_CAPTURE / 2);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_CAPTURE) stderr = stderr.slice(-MAX_CAPTURE / 2);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(config.ffprobePath, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    file,
  ]);
  let parsed: { streams?: Array<Record<string, unknown>> } = {};
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    /* dejamos parsed vacío -> se asume SDR con audio */
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s['codec_type'] === 'video');
  const hasAudio = streams.some((s) => s['codec_type'] === 'audio');
  const transfer = video?.['color_transfer'] as string | undefined;
  const primaries = video?.['color_primaries'] as string | undefined;
  const isHdr =
    transfer === 'smpte2084' ||
    transfer === 'arib-std-b67' ||
    primaries === 'bt2020';
  return { transfer, primaries, hasAudio, isHdr };
}

function buildVideoFilter(mode: FilterMode): string {
  const s = config.targetShortEdge;
  // Limita el lado CORTO a `s` (para vertical eso es el ancho; para horizontal,
  // el alto), preservando el aspecto, sin upscale y con dimensiones pares.
  // Antes se limitaba SOLO el alto -> un video vertical 1080x1920 terminaba en
  // 608x1080 (medía la mitad de resolución). Ahora queda 1080x1920 completo.
  const k = `min(1,${s}/min(iw,ih))`; // factor <= 1: nunca agranda
  const scale = `scale=w='trunc(iw*${k}/2)*2':h='trunc(ih*${k}/2)*2'`;
  if (mode === 'tonemap') {
    return [
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
      scale,
    ].join(',');
  }
  return `${scale},format=yuv420p`;
}

function doubleRate(rate: string): string {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/.exec(rate.trim());
  if (!m) return rate;
  return `${Number(m[1]) * 2}${m[2] ?? ''}`;
}

export function buildFfmpegArgs(input: string, outDir: string, mode: FilterMode): string[] {
  const seg = config.hlsSegmentSeconds;
  return [
    '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0?',            // audio opcional (posts sin audio no rompen)
    '-vf', buildVideoFilter(mode),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', config.x264Preset,
    // `high` es el perfil correcto para 1080p (8x8 transform -> ~5% más
    // eficiente que `main`). Todos los reproductores de los últimos 15 años
    // lo soportan; iOS/Android nativo sin problema.
    '-profile:v', 'high',
    '-crf', String(config.x264Crf),
    '-maxrate', config.videoBitrate,
    '-bufsize', doubleRate(config.videoBitrate),
    '-force_key_frames', `expr:gte(t,n_forced*${seg})`,
    '-c:a', 'aac',
    '-b:a', config.audioBitrate,
    '-ac', '2',
    '-max_muxing_queue_size', '1024',
    '-hls_time', String(seg),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${outDir}/seg_%03d.ts`,
    `${outDir}/index.m3u8`,
  ];
}

export async function runFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  const r = await run(config.ffmpegPath, args);
  return { code: r.code, stderr: r.stderr };
}

export function tailLines(text: string, n = 12): string {
  return text.trim().split('\n').slice(-n).join('\n');
}
