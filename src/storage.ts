// Acceso al Storage de Supabase con service_role, vía REST directo (fetch).
// No usamos @supabase/supabase-js: su cliente instancia Realtime en el
// constructor y en Node 20 (sin WebSocket global) revienta. La superficie que
// necesitamos es chica y estable.

import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.ts';

const BASE = `${config.supabaseUrl}/storage/v1`;
const PUBLIC_BASE = `${config.publicSupabaseUrl}/storage/v1`;

const authHeaders = {
  Authorization: `Bearer ${config.serviceRoleKey}`,
  apikey: config.serviceRoleKey,
};

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Baja un objeto privado directo a disco (streaming, no carga el MP4 en RAM). */
export async function downloadToFile(bucket: string, path: string, dest: string): Promise<void> {
  const res = await fetch(`${BASE}/object/${bucket}/${encodePath(path)}`, { headers: authHeaders });
  if (!res.ok || !res.body) {
    throw new Error(`storage download failed ${res.status} for ${bucket}/${path}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

/** Baja un objeto de texto (playlist). Devuelve null si es 404. */
export async function downloadText(bucket: string, path: string): Promise<string | null> {
  const res = await fetch(`${BASE}/object/${bucket}/${encodePath(path)}`, { headers: authHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`storage download failed ${res.status} for ${bucket}/${path}`);
  return res.text();
}

/** Respuesta cruda de un objeto, para hacer proxy/stream de segmentos. */
export function fetchObject(bucket: string, path: string): Promise<Response> {
  return fetch(`${BASE}/object/${bucket}/${encodePath(path)}`, { headers: authHeaders });
}

export interface UploadOpts {
  contentType: string;
  cacheControl?: string; // valor completo del header, ej 'public, max-age=31536000, immutable'
  upsert?: boolean;
}

export async function uploadFile(
  bucket: string,
  path: string,
  localPath: string,
  opts: UploadOpts,
): Promise<void> {
  const body = await readFile(localPath);
  const res = await fetch(`${BASE}/object/${bucket}/${encodePath(path)}`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': opts.contentType,
      'Cache-Control': opts.cacheControl ?? 'max-age=3600',
      'x-upsert': String(opts.upsert ?? true),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`storage upload failed ${res.status} ${bucket}/${path}: ${await safeText(res)}`);
  }
}

interface SignRow {
  error: string | null;
  path: string | null;
  signedURL: string;
}

/**
 * Firma un batch de paths. Devuelve un Map path -> signed URL ABSOLUTO,
 * armado contra PUBLIC_SUPABASE_URL (lo que consume el teléfono).
 */
export async function signUrls(
  bucket: string,
  paths: string[],
  ttlSeconds: number,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (paths.length === 0) return map;

  const res = await fetch(`${BASE}/object/sign/${bucket}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: ttlSeconds, paths }),
  });
  if (!res.ok) throw new Error(`createSignedUrls failed ${res.status}: ${await safeText(res)}`);

  const rows = (await res.json()) as SignRow[];
  for (const row of rows) {
    if (row.error || !row.signedURL || !row.path) {
      throw new Error(`sign failed for ${row.path}: ${row.error ?? 'no url'}`);
    }
    // signedURL viene relativo: "/object/sign/<bucket>/<path>?token=..."
    map.set(row.path, `${PUBLIC_BASE}${row.signedURL}`);
  }
  return map;
}

interface ListEntry {
  name: string;
  id: string | null; // null = "carpeta"
}

/** Lista objetos bajo un prefijo (nuestro árbol HLS es plano: user/post/*). */
export async function listPrefix(bucket: string, prefix: string): Promise<string[]> {
  const dir = prefix.replace(/\/+$/, '');
  const res = await fetch(`${BASE}/object/list/${bucket}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: dir, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error(`storage list failed ${res.status} ${bucket}/${dir}: ${await safeText(res)}`);
  const entries = (await res.json()) as ListEntry[];
  return entries.filter((e) => e.id !== null).map((e) => `${dir}/${e.name}`);
}

/** Borra todo lo que cuelga de un prefijo. Devuelve cuántos objetos borró. */
export async function removePrefix(bucket: string, prefix: string): Promise<number> {
  const files = await listPrefix(bucket, prefix);
  if (files.length === 0) return 0;
  const res = await fetch(`${BASE}/object/${bucket}`, {
    method: 'DELETE',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: files }),
  });
  if (!res.ok) throw new Error(`storage remove failed ${res.status} ${bucket}/${prefix}: ${await safeText(res)}`);
  return files.length;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
