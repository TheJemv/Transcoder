// Toda la configuración viene de variables de entorno (env_file: .env).
// Nada de hostnames hardcodeados: el mismo binario corre en tu Mac (apuntando
// al Supabase público) y en el server (apuntando a kong/db en la red interna).

function req(name: string): string {
  const v = process.env[name];
  if (v == null || v.trim() === '') throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

function opt(name: string, def: string): string {
  const v = process.env[name];
  return v != null && v.trim() !== '' ? v.trim() : def;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`);
  return n;
}

/** Primera de varias env vars que esté puesta, o el default. Para renombres. */
function numAny(names: string[], def: number): number {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && v.trim() !== '') return num(name, def);
  }
  return def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null || v.trim() === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, '');

const supabaseUrl = stripTrailingSlash(req('SUPABASE_URL'));

export const config = {
  databaseUrl: req('DATABASE_URL'),

  // API interna que usan worker + API para hablar con Storage.
  supabaseUrl,
  // URL pública — solo para armar los signed URLs que van dentro del playlist.
  publicSupabaseUrl: stripTrailingSlash(opt('PUBLIC_SUPABASE_URL', supabaseUrl)),

  serviceRoleKey: req('SERVICE_ROLE_KEY'),
  jwtSecret: req('SUPABASE_JWT_SECRET'),

  sourceBucket: opt('SOURCE_BUCKET', 'media'),
  hlsBucket: opt('HLS_BUCKET', 'media-hls'),

  apiPort: num('MEDIA_API_PORT', 8787),
  signedUrlTtl: num('SIGNED_URL_TTL', 21600),
  segmentProxy: bool('SEGMENT_PROXY', false),

  // Tope del lado CORTO del video (vertical -> ancho; horizontal -> alto).
  // `TARGET_HEIGHT` se mantiene como alias por compatibilidad con .env viejos.
  targetShortEdge: numAny(['TARGET_SHORT_EDGE', 'TARGET_HEIGHT'], 1080),
  videoBitrate: opt('VIDEO_BITRATE', '6M'),
  audioBitrate: opt('AUDIO_BITRATE', '128k'),
  x264Preset: opt('X264_PRESET', 'faster'),
  x264Crf: num('X264_CRF', 21),
  hlsSegmentSeconds: num('HLS_SEGMENT_SECONDS', 4),

  maxAttempts: num('MAX_ATTEMPTS', 3),
  pollMs: num('POLL_MS', 15000),
  staleProcessingMinutes: num('STALE_PROCESSING_MINUTES', 15),

  workDir: opt('WORK_DIR', '/tmp/work'),
  logLevel: opt('LOG_LEVEL', 'info'),

  ffmpegPath: opt('FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: opt('FFPROBE_PATH', 'ffprobe'),
} as const;

export type Config = typeof config;
