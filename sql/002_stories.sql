-- ════════════════════════════════════════════════════════════════════════════
-- 002_stories.sql — activa el transcode HLS para stories de video
-- Idempotente. Correr como `supabase_admin`.
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < sql/002_stories.sql
--
-- Requiere que 001_hls.sql ya esté aplicado.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Columnas (por si 001 corrió cuando `stories` no existía todavía).
alter table public.stories add column if not exists hls_path text;
alter table public.stories add column if not exists playback_status text not null default 'raw';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stories_playback_status_check') then
    alter table public.stories
      add constraint stories_playback_status_check
      check (playback_status in ('raw','ready','error'));
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Encolar transcode al insertar una story de video
-- (media_type = 'video' y el path termina en extensión de video)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.enqueue_story_transcode()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.media_type = 'video'
     and new.media_url is not null
     and public._is_video_path(new.media_url) then
    insert into public.transcode_jobs (op, kind, target_id, user_id, source_bucket, source_path)
    values ('transcode', 'story', new.id, new.user_id, 'stories', new.media_url);
    perform pg_notify('transcode_job', new.id::text);
  end if;
  return new;
end $$;

drop trigger if exists trg_enqueue_story_transcode on public.stories;
create trigger trg_enqueue_story_transcode
  after insert on public.stories
  for each row execute function public.enqueue_story_transcode();

-- ────────────────────────────────────────────────────────────────────────────
-- Limpiar el HLS al borrar la story (incluye el borrado automático a las 24h)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.cleanup_story_hls()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.hls_path is not null then
    insert into public.transcode_jobs (op, kind, target_id, user_id, source_bucket, source_path)
    values ('cleanup', 'story', old.id, old.user_id, 'media-hls',
            old.user_id::text || '/' || old.id::text || '/');
    perform pg_notify('transcode_job', old.id::text);
  end if;
  return old;
end $$;

drop trigger if exists trg_cleanup_story_hls on public.stories;
create trigger trg_cleanup_story_hls
  after delete on public.stories
  for each row execute function public.cleanup_story_hls();

commit;
