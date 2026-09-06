// Verificación local (sin red) de los access tokens de Supabase.
// HS256 + exp contra SUPABASE_JWT_SECRET. Devuelve el `sub` (id del usuario).

import { jwtVerify } from 'jose';
import { config } from './config.ts';

const secret = new TextEncoder().encode(config.jwtSecret);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifiedUser {
  sub: string;
}

/**
 * Devuelve el usuario verificado, o null si el header falta / el token es
 * inválido / expiró / no es un usuario `authenticated`.
 */
export async function verifyUser(authHeader: string | undefined): Promise<VerifiedUser | null> {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1]!, secret, { algorithms: ['HS256'] });
    if (payload.role != null && payload.role !== 'authenticated') return null;
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!UUID_RE.test(sub)) return null;
    return { sub };
  } catch {
    return null;
  }
}
