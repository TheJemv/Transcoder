// Encola manualmente un job de transcode para un post que YA existe.
//   npm run enqueue-test -- <post_id>
//
// Lee DATABASE_URL del entorno (o del .env si lo exportas antes).

import pg from 'pg';

const url = process.env.DATABASE_URL;
const postId = process.argv[2] ?? process.env.POST_ID;

if (!url) {
  console.error('Falta DATABASE_URL en el entorno.');
  process.exit(1);
}
if (!postId) {
  console.error('Uso: npm run enqueue-test -- <post_id>');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows } = await client.query<{ id: string; user_id: string; media_url: string | null }>(
    'select id, user_id, media_url from posts where id = $1',
    [postId],
  );
  const post = rows[0];
  if (!post) {
    console.error(`No existe el post ${postId}`);
    process.exit(1);
  }
  if (!post.media_url) {
    console.error(`El post ${postId} no tiene media_url`);
    process.exit(1);
  }

  const job = await client.query<{ id: string }>(
    `insert into transcode_jobs (op, kind, target_id, user_id, source_bucket, source_path)
     values ('transcode', 'post', $1, $2, 'media', $3)
     returning id`,
    [post.id, post.user_id, post.media_url],
  );
  await client.query(`select pg_notify('transcode_job', $1)`, [post.id]);

  console.log(
    JSON.stringify({
      enqueued_job: job.rows[0]!.id,
      post_id: post.id,
      user_id: post.user_id,
      source_path: post.media_url,
    }, null, 2),
  );
} finally {
  await client.end();
}
