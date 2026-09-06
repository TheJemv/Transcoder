import type pg from 'pg';

// ── Posts ──────────────────────────────────────────────────────────────────
// El usuario ($2) puede ver el post ($1) si es suyo o es amigo del dueño
// (friends es bidireccional), y no hay bloqueo en ningún sentido.
const POST_ACCESS_SQL = `
  select p.user_id as owner
  from posts p
  where p.id = $1
    and ( p.user_id = $2 or exists (
          select 1 from friends f
          where (f.user_id = p.user_id and f.friend_id = $2)
             or (f.user_id = $2 and f.friend_id = p.user_id)))
    and not exists (
          select 1 from blocked_users b
          where (b.blocker_id = p.user_id and b.blocked_id = $2)
             or (b.blocker_id = $2 and b.blocked_id = p.user_id))
  limit 1
`;

// ── Stories ────────────────────────────────────────────────────────────────
// Espeja la RLS policy "Ver historias activas o archivo propio":
//   uid = user_id  OR  (are_friends(uid, user_id) AND created_at >= now() - 24h)
const STORY_ACCESS_SQL = `
  select s.user_id as owner
  from stories s
  where s.id = $1
    and ( s.user_id = $2
          or ( are_friends($2, s.user_id)
               and s.created_at >= now() - interval '24 hours' ) )
  limit 1
`;

export interface AccessResult {
  allowed: boolean;
  owner?: string;
  kind?: 'post' | 'story';
}

/**
 * Chequea acceso al media `id` (post o story) para el usuario `uid`.
 * Prueba post primero; si no matchea, story. Sin match -> no permitido.
 * El path en Storage es `{owner}/{id}/…` sin importar el tipo.
 */
export async function checkMediaAccess(
  db: pg.Pool,
  id: string,
  uid: string,
): Promise<AccessResult> {
  const post = await db.query<{ owner: string }>(POST_ACCESS_SQL, [id, uid]);
  if (post.rows[0]) return { allowed: true, owner: post.rows[0].owner, kind: 'post' };

  const story = await db.query<{ owner: string }>(STORY_ACCESS_SQL, [id, uid]);
  if (story.rows[0]) return { allowed: true, owner: story.rows[0].owner, kind: 'story' };

  return { allowed: false };
}
