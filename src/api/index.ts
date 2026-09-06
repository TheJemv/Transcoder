// Media API (Fastify). Entrega el playlist HLS autenticado.
//
//   GET /health
//   GET /media/:userId/:postId/index.m3u8   -> playlist con signed URLs
//   GET /media/:userId/:postId/:segment     -> solo si SEGMENT_PROXY=true

import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { config } from '../config.ts';
import { pool } from '../db.ts';
import { verifyUser } from '../jwt.ts';
import { log } from '../logger.ts';
import { checkPostAccess } from './permissions.ts';
import { downloadText, fetchObject, signUrls } from '../storage.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_RE = /^seg_\d{3,}\.ts$/;

const app = Fastify({ logger: false, disableRequestLogging: true, trustProxy: true });

app.get('/health', async () => ({ status: 'ok' }));

interface MediaParams {
  userId: string;
  postId: string;
}

app.get<{ Params: MediaParams }>('/media/:userId/:postId/index.m3u8', async (req, reply) => {
  const t0 = Date.now();
  const { userId, postId } = req.params;

  if (!UUID_RE.test(userId) || !UUID_RE.test(postId)) {
    return reply.code(400).send({ error: 'bad_request' });
  }

  const user = await verifyUser(req.headers.authorization);
  if (!user) {
    log.info('playlist.unauthorized', { postId, ms: Date.now() - t0 });
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const access = await checkPostAccess(pool, postId, user.sub);
  if (!access.allowed) {
    log.info('playlist.forbidden', { uid: user.sub, postId, ms: Date.now() - t0 });
    return reply.code(403).send({ error: 'forbidden' });
  }
  const owner = access.owner ?? userId;

  const playlist = await downloadText(config.hlsBucket, `${owner}/${postId}/index.m3u8`);
  if (playlist == null) {
    log.info('playlist.not_found', { uid: user.sub, postId, ms: Date.now() - t0 });
    return reply.code(404).send({ error: 'not_found' });
  }

  // Con SEGMENT_PROXY los segmentos quedan relativos y los resuelve el cliente
  // contra la URL del playlist (-> caen en la ruta :segment de abajo).
  const body = config.segmentProxy ? playlist : await rewritePlaylist(playlist, owner, postId);

  log.info('playlist.ok', {
    uid: user.sub,
    postId,
    proxy: config.segmentProxy,
    ms: Date.now() - t0,
  });

  return reply
    .header('Content-Type', 'application/vnd.apple.mpegurl')
    .header('Cache-Control', 'private, no-store')
    .send(body);
});

async function rewritePlaylist(text: string, owner: string, postId: string): Promise<string> {
  const lines = text.split('\n');
  const idx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l !== '' && !l.startsWith('#') && l.endsWith('.ts')) idx.push(i);
  }
  if (idx.length === 0) return text;

  const paths = idx.map((i) => `${owner}/${postId}/${lines[i]!.trim()}`);
  const signed = await signUrls(config.hlsBucket, paths, config.signedUrlTtl);

  for (let k = 0; k < idx.length; k++) {
    const url = signed.get(paths[k]!);
    if (!url) throw new Error(`signed url faltante para ${paths[k]}`);
    lines[idx[k]!] = url;
  }
  return lines.join('\n');
}

// ── Segment proxy (opcional) ────────────────────────────────────────────────
interface SegmentParams extends MediaParams {
  segment: string;
}

if (config.segmentProxy) {
  app.get<{ Params: SegmentParams }>('/media/:userId/:postId/:segment', async (req, reply) => {
    const { userId, postId, segment } = req.params;
    if (!UUID_RE.test(userId) || !UUID_RE.test(postId) || !SEGMENT_RE.test(segment)) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    // Solo firma + exp del JWT (sin BD).
    const user = await verifyUser(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const upstream = await fetchObject(config.hlsBucket, `${userId}/${postId}/${segment}`);
    if (upstream.status === 404) return reply.code(404).send({ error: 'not_found' });
    if (!upstream.ok || !upstream.body) return reply.code(502).send({ error: 'upstream' });

    const len = upstream.headers.get('content-length');
    reply
      .header('Content-Type', 'video/mp2t')
      .header('Cache-Control', 'public, max-age=31536000, immutable');
    if (len) reply.header('Content-Length', len);
    return reply.send(Readable.fromWeb(upstream.body as never));
  });
} else {
  app.get('/media/:userId/:postId/:segment', async (_req, reply) =>
    reply.code(404).send({ error: 'not_found' }),
  );
}

// ── arranque ────────────────────────────────────────────────────────────────
app
  .listen({ host: '0.0.0.0', port: config.apiPort })
  .then(() =>
    log.info('api.listening', { port: config.apiPort, segmentProxy: config.segmentProxy }),
  )
  .catch((e) => {
    log.error('api.fatal', { err: e instanceof Error ? e.stack ?? e.message : String(e) });
    process.exit(1);
  });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log.info('api.shutdown', { sig });
    void app.close().then(() => pool.end()).catch(() => undefined).finally(() => process.exit(0));
  });
}
