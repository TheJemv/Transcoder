import type pg from 'pg';

// UN query indexado: el usuario ($2) puede ver el post ($1) si es suyo o es
// amigo del dueño (friends es bidireccional), y no hay bloqueo en ningún sentido.
const ACCESS_SQL = `
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

export interface AccessResult {
  allowed: boolean;
  owner?: string;
}

export async function checkPostAccess(
  db: pg.Pool,
  postId: string,
  uid: string,
): Promise<AccessResult> {
  const { rows } = await db.query<{ owner: string }>(ACCESS_SQL, [postId, uid]);
  const row = rows[0];
  if (!row) return { allowed: false };
  return { allowed: true, owner: row.owner };
}
