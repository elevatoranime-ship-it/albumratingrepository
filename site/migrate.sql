-- ==========================================================================
-- MIGRATE — приведение СУЩЕСТВУЮЩЕЙ базы к актуальной схеме
-- Выполните в Supabase: SQL Editor → New query → Run.
-- Идемпотентно: можно запускать многократно (безопасно).
-- Для новой базы используйте schema.sql — этот файл тогда не нужен.
-- ==========================================================================

-- 1) Хранилище обложек (публичное чтение)
insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do update set public = true;

drop policy if exists "buckets_read" on storage.buckets;
create policy "buckets_read" on storage.buckets
  for select to anon, authenticated using (true);

drop policy if exists "covers_read"   on storage.objects;
drop policy if exists "covers_insert" on storage.objects;
drop policy if exists "covers_update" on storage.objects;
drop policy if exists "covers_delete" on storage.objects;
create policy "covers_read"   on storage.objects for select using (bucket_id = 'covers');
create policy "covers_insert" on storage.objects for insert with check (bucket_id = 'covers' and auth.role() = 'authenticated');
create policy "covers_update" on storage.objects for update using (bucket_id = 'covers' and auth.role() = 'authenticated');
create policy "covers_delete" on storage.objects for delete using (bucket_id = 'covers' and auth.role() = 'authenticated');

-- 2) Профили: аватар
alter table public.profiles
  add column if not exists avatar_url text;

-- 3) Альбомы: фиксация количества треков, целостность, тип релиза
alter table public.albums
  add column if not exists tracks_locked boolean not null default false;
alter table public.albums
  add column if not exists cohesion smallint check (cohesion between 1 and 5);
alter table public.albums
  add column if not exists album_type text check (album_type in ('album','ep','compilation'));

-- финальность: зафиксированную целостность/тип релиза изменить нельзя
create or replace function public.prevent_album_meta_change()
returns trigger as $$
begin
  if old.cohesion is not null and new.cohesion is distinct from old.cohesion then
    raise exception 'cohesion is final and cannot be changed';
  end if;
  if old.album_type is not null and new.album_type is distinct from old.album_type then
    raise exception 'album_type is final and cannot be changed';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_album_meta_final on public.albums;
create trigger trg_album_meta_final
  before update on public.albums
  for each row execute function public.prevent_album_meta_change();

-- 4) Треки (создать, если нет; добавить недостающие колонки)
create table if not exists public.tracks (
  id          uuid primary key default gen_random_uuid(),
  album_id    uuid not null references public.albums(id) on delete cascade,
  title       text not null,
  position    integer not null default 0,
  locked      boolean not null default false,
  feat_artist text,
  created_at  timestamptz not null default now()
);

alter table public.tracks
  add column if not exists locked boolean not null default false;
alter table public.tracks
  add column if not exists feat_artist text;

alter table public.tracks enable row level security;
drop policy if exists "tracks_read"   on public.tracks;
drop policy if exists "tracks_insert" on public.tracks;
drop policy if exists "tracks_update" on public.tracks;
drop policy if exists "tracks_delete" on public.tracks;
create policy "tracks_read"   on public.tracks for select using (auth.role() = 'authenticated');
create policy "tracks_insert" on public.tracks for insert with check (auth.role() = 'authenticated');
create policy "tracks_update" on public.tracks for update using (auth.role() = 'authenticated');
create policy "tracks_delete" on public.tracks for delete using (auth.role() = 'authenticated');

-- 5) Оценки: если таблица ещё старая (альбомная) — пересоздаём под треки.
--    Старые альбомные оценки при этом удаляются (функция была заменена).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ratings' and column_name = 'track_id'
  ) then
    drop table if exists public.ratings;
    create table public.ratings (
      track_id   uuid not null references public.tracks(id) on delete cascade,
      profile_id uuid not null references public.profiles(id) on delete cascade,
      score      numeric(4,2) not null check (score >= 0 and score <= 10),
      updated_at timestamptz not null default now(),
      primary key (track_id, profile_id)
    );
  end if;
end $$;

alter table public.ratings alter column score type numeric(4,2);
alter table public.ratings
  add column if not exists confirmed boolean not null default false;

alter table public.ratings enable row level security;
drop policy if exists "ratings_read"   on public.ratings;
drop policy if exists "ratings_insert" on public.ratings;
drop policy if exists "ratings_update" on public.ratings;
drop policy if exists "ratings_delete" on public.ratings;
create policy "ratings_read"   on public.ratings for select using (auth.role() = 'authenticated');
create policy "ratings_insert" on public.ratings for insert with check (auth.uid() = profile_id);
create policy "ratings_update" on public.ratings for update using (auth.uid() = profile_id);
create policy "ratings_delete" on public.ratings for delete using (auth.uid() = profile_id);

-- 6) Права для роли authenticated
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.albums   to authenticated;
grant select, insert, update, delete on public.ratings   to authenticated;
grant select, insert, update, delete on public.tracks    to authenticated;

-- 7) Realtime (живая синхронизация). Ошибки не роняем — если прав нет,
--    включите таблицы в Dashboard → Database → Replication → supabase_realtime.
do $$ begin
  alter publication supabase_realtime add table public.albums;
exception when others then raise notice 'realtime albums skipped: %', SQLERRM; end $$;
do $$ begin
  alter publication supabase_realtime add table public.tracks;
exception when others then raise notice 'realtime tracks skipped: %', SQLERRM; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ratings;
exception when others then raise notice 'realtime ratings skipped: %', SQLERRM; end $$;
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when others then raise notice 'realtime profiles skipped: %', SQLERRM; end $$;

-- 8) СИНГЛЫ: тип релиза, привязка к альбому, метка трека и оценки синглов.
--    Синглы живут в той же таблице albums (kind = 'single').

alter table public.albums
  add column if not exists kind text not null default 'album';
alter table public.albums
  add column if not exists parent_album_id uuid references public.albums(id) on delete set null;

do $$ begin
  alter table public.albums
    add constraint albums_kind_check check (kind in ('album', 'single'));
exception when duplicate_object then null; end $$;

-- метка «трек — сингл» (ссылка на карточку сингла)
alter table public.tracks
  add column if not exists single_id uuid references public.albums(id) on delete set null;

-- уникальность теперь с учётом типа релиза: одноимённые альбом и сингл возможны
drop index if exists public.albums_unique;
create unique index if not exists albums_unique_kind
  on public.albums (lower(artist), lower(title), kind);

-- оценки синглов (одна оценка на релиз)
create table if not exists public.single_ratings (
  album_id   uuid not null references public.albums(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  score      numeric(4,2) not null check (score >= 0 and score <= 10),
  confirmed  boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (album_id, profile_id)
);

alter table public.single_ratings enable row level security;
drop policy if exists "single_ratings_read"   on public.single_ratings;
drop policy if exists "single_ratings_insert" on public.single_ratings;
drop policy if exists "single_ratings_update" on public.single_ratings;
drop policy if exists "single_ratings_delete" on public.single_ratings;
create policy "single_ratings_read"   on public.single_ratings for select using (auth.role() = 'authenticated');
create policy "single_ratings_insert" on public.single_ratings for insert with check (auth.uid() = profile_id);
create policy "single_ratings_update" on public.single_ratings for update using (auth.uid() = profile_id);
create policy "single_ratings_delete" on public.single_ratings for delete using (auth.uid() = profile_id);

grant select, insert, update, delete on public.single_ratings to authenticated;

-- Realtime: оценки синглов приходят так же, как оценки треков.
do $$ begin
  alter publication supabase_realtime add table public.single_ratings;
exception when others then raise notice 'realtime single_ratings skipped: %', SQLERRM; end $$;

-- 9) Проверка результата: новые поля релизов и таблица оценок синглов
select table_name, column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and (
    table_name = 'ratings'
    or (table_name = 'albums' and column_name in ('kind', 'parent_album_id'))
    or (table_name = 'tracks' and column_name = 'single_id')
    or table_name = 'single_ratings'
  )
order by table_name, ordinal_position;
