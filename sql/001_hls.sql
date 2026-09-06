-- ════════════════════════════════════════════════════════════════════════════
-- 001_hls.sql — HLS VOD para posts de Nimly
-- Idempotente. Correr como `postgres` (superuser) contra la BD de Supabase.
--   psql "$DATABASE_URL" -f sql/001_hls.sql
-- ════════════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Cola de jobs
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.transcode_jobs (
  id            uuid primary key default gen_random_uuid(),
  op            text not null default 'transcode' check (op in ('transcode','cleanup')),
  kind          text not null default 'post'      check (kind in ('post','story')),
  target_id     uuid,
  user_id       uuid,
  source_bucket text,
  source_path   text,
  status        text not null default 'pending'
                  check (status in ('pending','processing','done','error')),
  attempts      int  not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Índice para el claim del worker (solo filas vivas).
create index if not exists transcode_jobs_active_idx
  on public.transcode_jobs (created_at)
  where status in ('pending','processing');

-- Solo service_role / postgres tocan esta tabla.
alter table public.transcode_jobs enable row level security;
-- (sin policies a propósito: service_role y el owner bypassan RLS)

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Columnas de playback en posts (y stories, para después)
-- ────────────────────────────────────────────────────────────────────────────
alter table public.posts
  add column if not exists hls_path        text,
  add column if not exists playback_status text not null default 'raw';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'posts_playback_status_check') then
    alter table public.posts
      add constraint posts_playback_status_check
      check (playback_status in ('raw','ready','error'));
  end if;
end $$;

-- stories: mismas columnas (el trigger de stories queda comentado más abajo).
do $$
begin
  if to_regclass('public.stories') is not null then
    alter table public.stories add column if not exists hls_path text;
    alter table public.stories add column if not exists playback_status text not null default 'raw';
    if not exists (select 1 from pg_constraint where conname = 'stories_playback_status_check') then
      alter table public.stories
        add constraint stories_playback_status_check
        check (playback_status in ('raw','ready','error'));
    end if;
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Bucket privado para el HLS
-- ────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('media-hls', 'media-hls', false)
on conflict (id) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Helper: ¿el path apunta a un video?
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public._is_video_path(p text)
returns boolean
language sql
immutable
as $$ select p ~* '\.(mp4|mov|m4v|webm|avi)$' $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Trigger: encolar transcode al insertar un post con video
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.enqueue_post_transcode()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.media_url is not null and public._is_video_path(new.media_url) then
    insert into public.transcode_jobs (op, kind, target_id, user_id, source_bucket, source_path)
    values ('transcode', 'post', new.id, new.user_id, 'media', new.media_url);
    perform pg_notify('transcode_job', new.id::text);
  end if;
  return new;
end $$;

drop trigger if exists trg_enqueue_post_transcode on public.posts;
create trigger trg_enqueue_post_transcode
  after insert on public.posts
  for each row execute function public.enqueue_post_transcode();

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Trigger: encolar limpieza del HLS al borrar un post
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.cleanup_post_hls()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.hls_path is not null then
    insert into public.transcode_jobs (op, kind, target_id, user_id, source_bucket, source_path)
    values ('cleanup', 'post', old.id, old.user_id, 'media-hls',
            old.user_id::text || '/' || old.id::text || '/');
    perform pg_notify('transcode_job', old.id::text);
  end if;
  return old;
end $$;

drop trigger if exists trg_cleanup_post_hls on public.posts;
create trigger trg_cleanup_post_hls
  after delete on public.posts
  for each row execute function public.cleanup_post_hls();

-- ────────────────────────────────────────────────────────────────────────────
-- 6b. Stories — PARA DESPUÉS. Descomentar cuando se active.
-- ────────────────────────────────────────────────────────────────────────────
-- create or replace function public.enqueue_story_transcode()
-- returns trigger
-- language plpgsql
-- security definer
-- set search_path = public
-- as $$
-- begin
--   if new.media_url is not null and public._is_video_path(new.media_url) then
--     insert into public.transcode_jobs (op, kind, target_id, user_id, source_bucket, source_path)
--     values ('transcode', 'story', new.id, new.user_id, 'stories', new.media_url);
--     perform pg_notify('transcode_job', new.id::text);
--   end if;
--   return new;
-- end $$;
--
-- drop trigger if exists trg_enqueue_story_transcode on public.stories;
-- create trigger trg_enqueue_story_transcode
--   after insert on public.stories
--   for each row execute function public.enqueue_story_transcode();
--
-- create or replace function public.cleanup_story_hls()
-- returns trigger language plpgsql security definer set search_path = public
-- as $$
-- begin
--   if old.hls_path is not null then
--     insert into public.transcode_jobs (op, kind, target_id, user_id, source_bucket, source_path)
--     values ('cleanup', 'story', old.id, old.user_id, 'media-hls',
--             old.user_id::text || '/' || old.id::text || '/');
--     perform pg_notify('transcode_job', old.id::text);
--   end if;
--   return old;
-- end $$;
--
-- drop trigger if exists trg_cleanup_story_hls on public.stories;
-- create trigger trg_cleanup_story_hls
--   after delete on public.stories
--   for each row execute function public.cleanup_story_hls();

-- ────────────────────────────────────────────────────────────────────────────
-- 7. View posts_with_stats + get_friends_posts
--    Se agregan p.hls_path y p.playback_status justo después de p.created_at.
--    CREATE OR REPLACE VIEW no permite insertar columnas en el medio, así que
--    hay que DROP + recrear. get_friends_posts depende de la view -> se dropea
--    y se recrea con su cuerpo EXACTO (sin cambios de lógica).
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists public.get_friends_posts(uuid);
drop view if exists public.posts_with_stats;

create view public.posts_with_stats as
  select p.id, p.user_id, p.type, p.content, p.media_url, p.created_at,
    p.hls_path, p.playback_status,
    pr.username, pr.avatar_config,
    coalesce(l.likes_count, 0::bigint)    as likes_count,
    coalesce(c.comments_count, 0::bigint) as comments_count,
    (exists ( select 1 from likes lk
              where lk.post_id = p.id and lk.user_id = uid())) as is_liked_by_me
  from posts p
    left join profiles pr on p.user_id = pr.id
    left join ( select likes.post_id, count(*) as likes_count
                from likes group by likes.post_id) l on p.id = l.post_id
    left join ( select comments.post_id, count(*) as comments_count
                from comments group by comments.post_id) c on p.id = c.post_id;

create or replace function public.get_friends_posts(requesting_user_id uuid)
returns setof posts_with_stats language sql stable as $$
  select p.* from posts_with_stats p
  where p.user_id in (
    select case when f.user_id = requesting_user_id then f.friend_id else f.user_id end
    from friends f
    where f.user_id = requesting_user_id or f.friend_id = requesting_user_id
    union select requesting_user_id)
  order by p.created_at desc limit 15;
$$;

-- Grants (Supabase). Ajusta si tu view/función tenían grants distintos.
grant select  on public.posts_with_stats           to anon, authenticated, service_role;
grant execute on function public.get_friends_posts(uuid) to anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Índices de apoyo para el chequeo de permiso de la Media API.
--    Si ya existen bajo otro nombre, estos `if not exists` no crean nada útil
--    y puedes borrarlos; son redundantes, no rompen nada.
-- ────────────────────────────────────────────────────────────────────────────
create index if not exists friends_user_id_idx        on public.friends (user_id);
create index if not exists friends_friend_id_idx      on public.friends (friend_id);
create index if not exists blocked_users_blocker_idx  on public.blocked_users (blocker_id);
create index if not exists blocked_users_blocked_idx  on public.blocked_users (blocked_id);

commit;
