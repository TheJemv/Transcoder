import { config } from '../config.ts';
import { log } from '../logger.ts';
import { removePrefix } from '../storage.ts';
import type { Job } from './types.ts';

export async function handleCleanup(job: Job): Promise<void> {
  const bucket = job.source_bucket ?? config.hlsBucket;
  const prefix =
    job.source_path ??
    (job.user_id && job.target_id ? `${job.user_id}/${job.target_id}/` : null);
  if (!prefix) throw new Error('cleanup job sin source_path ni user_id/target_id');

  const removed = await removePrefix(bucket, prefix);
  log.info('cleanup.done', { jobId: job.id, bucket, prefix, removed });
}
