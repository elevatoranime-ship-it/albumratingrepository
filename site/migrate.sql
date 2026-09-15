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

-- 9) Несколько альбомов сингла
-- Несколько альбомов одного сингла. Массив хранит порядок выбора;
-- parent_album_id остаётся первым альбомом для совместимости со старым клиентом.
alter table public.albums add column if not exists parent_album_ids uuid[];
update public.albums
set parent_album_ids = case when parent_album_id is null then '{}'::uuid[] else array[parent_album_id] end
where parent_album_ids is null;

create or replace function public.normalize_single_albums()
returns trigger language plpgsql set search_path = public as $$
declare
  ids uuid[];
begin
  ids := new.parent_album_ids;
  if TG_OP = 'UPDATE' then
    -- Старый клиент меняет только одиночную привязку.
    if new.parent_album_ids is not distinct from old.parent_album_ids
       and new.parent_album_id is distinct from old.parent_album_id then
      ids := case when new.parent_album_id is null then '{}'::uuid[] else array[new.parent_album_id] end;
    end if;
  end if;
  ids := coalesce(ids, case when new.parent_album_id is null then '{}'::uuid[] else array[new.parent_album_id] end);
  if new.kind <> 'single' and cardinality(ids) > 0 then
    raise exception 'Только сингл может быть привязан к альбомам';
  end if;
  if exists (
    select 1 from unnest(ids) as p(id)
    where p.id is null or p.id = new.id
      or not exists (select 1 from public.albums a where a.id = p.id and a.kind = 'album')
  ) then
    raise exception 'Привязка должна указывать на существующий альбом';
  end if;
  select coalesce(array_agg(p.id order by p.first_pos), '{}'::uuid[]) into new.parent_album_ids
  from (select id, min(pos) as first_pos from unnest(ids) with ordinality as u(id, pos) group by id) p;
  new.parent_album_id := new.parent_album_ids[1];
  return new;
end $$;

drop trigger if exists normalize_single_albums on public.albums;
create trigger normalize_single_albums
before insert or update of parent_album_ids, parent_album_id, kind on public.albums
for each row execute function public.normalize_single_albums();

-- Удаление альбома убирает только его связь. Остальные связи и сингл сохраняются.
-- BEFORE DELETE обновляет также одиночный FK до его ON DELETE SET NULL.
create or replace function public.unlink_deleted_single_album()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.albums
  set parent_album_ids = array_remove(parent_album_ids, old.id)
  where id <> old.id and old.id = any(parent_album_ids);
  return old;
end $$;
revoke all on function public.unlink_deleted_single_album() from public;
revoke all on function public.normalize_single_albums() from public;

drop trigger if exists unlink_deleted_single_album on public.albums;
create trigger unlink_deleted_single_album before delete on public.albums
for each row execute function public.unlink_deleted_single_album();

-- 10) Проверка результата: новые поля релизов и таблица оценок синглов
select table_name, column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and (
    table_name = 'ratings'
    or (table_name = 'albums' and column_name in ('kind', 'parent_album_id', 'parent_album_ids'))
    or (table_name = 'tracks' and column_name = 'single_id')
    or table_name = 'single_ratings'
  )
order by table_name, ordinal_position;
