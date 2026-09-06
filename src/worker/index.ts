// Worker: LISTEN transcode_job + poll de respaldo cada POLL_MS.
// Reclama 1 job a la vez con FOR UPDATE SKIP LOCKED (re-toma 'processing'
// colgados hace > STALE_PROCESSING_MINUTES).

import pg from 'pg';
import { config } from '../config.ts';
import { pool, query } from '../db.ts';
import { log } from '../logger.ts';
import { handleCleanup } from './cleanup.ts';
import { handleTranscode } from './transcode.ts';
import type { Job } from './types.ts';

let draining = false;
let stopping = false;
let listenClient: pg.Client | null = null;

const JOB_COLUMNS =
  'id, op, kind, target_id, user_id, source_bucket, source_path, status, attempts';

async function claim(): Promise<Job | null> {
  const { rows } = await query<Job>(
    `update public.transcode_jobs j
        set status = 'processing',
            attempts = j.attempts + 1,
            updated_at = now()
      where j.id = (
        select id from public.transcode_jobs
         where status = 'pending'
            or (status = 'processing'
                and updated_at < now() - (($1 || ' minutes')::interval))
         order by created_at
         for update skip locked
         limit 1
      )
      returning ${JOB_COLUMNS}`,
    [String(config.staleProcessingMinutes)],
  );
  return rows[0] ?? null;
}

async function finish(job: Job, ok: boolean, errorMsg?: string): Promise<void> {
  if (ok) {
    await query(
      `update public.transcode_jobs set status = 'done', error = null, updated_at = now() where id = $1`,
      [job.id],
    );
    return;
  }

  const exhausted = job.attempts >= config.maxAttempts;
  await query(
    `update public.transcode_jobs set status = $2, error = $3, updated_at = now() where id = $1`,
    [job.id, exhausted ? 'error' : 'pending', (errorMsg ?? 'unknown').slice(0, 4000)],
  );

  // Un transcode fallido de forma definitiva marca el post/story como 'error'
  // (el cliente sigue con el MP4 crudo; nunca se rompe un post por esto).
  if (exhausted && job.op === 'transcode' && job.target_id) {
    const table = job.kind === 'story' ? 'stories' : 'posts';
    await query(
      `update public.${table} set playback_status = 'error' where id = $1 and playback_status <> 'ready'`,
      [job.target_id],
    ).catch((e) => log.error('finish.mark_error_failed', { jobId: job.id, err: String(e) }));
  }
}

async function drain(): Promise<void> {
  if (draining || stopping) return;
  draining = true;
  try {
    for (;;) {
      if (stopping) break;

      let job: Job | null;
      try {
        job = await claim();
      } catch (e) {
        log.error('claim.failed', { err: String(e) });
        break;
      }
      if (!job) break;

      const startedAt = Date.now();
      log.info('job.start', {
        jobId: job.id,
        op: job.op,
        kind: job.kind,
        targetId: job.target_id,
        attempts: job.attempts,
      });

      try {
        if (job.op === 'cleanup') await handleCleanup(job);
        else await handleTranscode(job);
        await finish(job, true);
        log.info('job.ok', { jobId: job.id, op: job.op, ms: Date.now() - startedAt });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const exhausted = job.attempts >= config.maxAttempts;
        log.error('job.fail', {
          jobId: job.id,
          op: job.op,
          attempts: job.attempts,
          maxAttempts: config.maxAttempts,
          willRetry: !exhausted,
          ms: Date.now() - startedAt,
          err: msg,
        });
        await finish(job, false, msg).catch((fe) =>
          log.error('finish.failed', { jobId: job.id, err: String(fe) }),
        );
        // Si va a reintentar, no lo re-tomamos en este mismo barrido: dejamos
        // que el próximo poll (POLL_MS) lo agarre, así hay algo de espaciado.
        if (!exhausted) break;
      }
    }
  } finally {
    draining = false;
  }
}

async function startListener(): Promise<void> {
  if (stopping) return;

  const client = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10_000 });
  listenClient = client;

  client.on('error', (e) => log.error('listen.error', { err: String(e) }));
  client.on('notification', (msg) => {
    log.debug('listen.notify', { channel: msg.channel });
    void drain();
  });
  client.on('end', () => {
    listenClient = null;
    if (!stopping) {
      log.warn('listen.ended_reconnecting', {});
      setTimeout(() => void startListener(), 2000);
    }
  });

  try {
    await client.connect();
    await client.query('LISTEN transcode_job');
    log.info('listen.ready', {});
    void drain(); // barrer lo que quedó pendiente
  } catch (e) {
    listenClient = null;
    log.error('listen.connect_failed', { err: String(e) });
    if (!stopping) setTimeout(() => void startListener(), 3000);
  }
}

async function main(): Promise<void> {
  log.info('worker.start', {
    pollMs: config.pollMs,
    maxAttempts: config.maxAttempts,
    staleMinutes: config.staleProcessingMinutes,
    workDir: config.workDir,
    hlsBucket: config.hlsBucket,
  });

  await startListener();
  const timer = setInterval(() => void drain(), config.pollMs);

  const shutdown = async (sig: string): Promise<void> => {
    log.info('worker.shutdown', { sig });
    stopping = true;
    clearInterval(timer);
    const deadline = Date.now() + 60_000;
    while (draining && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    try { await listenClient?.end(); } catch { /* noop */ }
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('worker.fatal', { err: e instanceof Error ? e.stack ?? e.message : String(e) });
  process.exit(1);
});
