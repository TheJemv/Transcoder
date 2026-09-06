export interface Job {
  id: string;
  op: 'transcode' | 'cleanup';
  kind: 'post' | 'story';
  target_id: string | null;
  user_id: string | null;
  source_bucket: string | null;
  source_path: string | null;
  status: string;
  attempts: number;
}
