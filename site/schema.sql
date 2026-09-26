-- Все изменения применяются атомарно, включая политики доступа.
begin;

-- ==========================================================================
-- СХЕМА БАЗЫ ДАННЫХ (Supabase / Postgres)
-- Выполните целиком в Supabase: SQL Editor → New query → Run (для НОВОЙ базы).
-- Если база уже создана ранее — используйте migrate.sql (идемпотентный).
-- ==========================================================================

-- 1) Профили участников (привязаны к аккаунтам из auth.users)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null unique,
  initials   text not null default '',
  avatar_url text,                              -- аватар (URL или data-URI)
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_read"   on public.profiles for select using (auth.role() = 'authenticated');
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update" on public.profiles for update using (auth.uid() = id);


-- 2) Релизы: альбомы и синглы в одной таблице (kind различает тип).
--    Сингл — такая же строка, отличаются только поля kind / parent_album_id
--    и способ оценки (см. пункт 3c). Макси-сингл — сингл с флагом is_maxi,
--    у которого до 3 треков, оценивается как альбом (по трекам).
create table if not exists public.albums (
  id              uuid primary key default gen_random_uuid(),
  artist          text not null,
  title           text not null,
  year            integer not null,
  cover_url       text,                          -- ссылка на обложку (URL или путь в storage)
  genius_song_id  bigint,                        -- ID песни Genius для текста сингла (null — не выбран)
  tracks_locked   boolean not null default false, -- количество треков зафиксировано (админ)
  cohesion        smallint,                        -- целостность/концептуальность (1..5, финально)
  album_type      text,                            -- 'album' | 'ep' | 'compilation' (финально)
  kind            text not null default 'album'    -- 'album' | 'single'
                  check (kind in ('album', 'single')),
  parent_album_id uuid references public.albums(id) on delete set null,
                                                   -- для сингла: альбом, к которому он относится
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  is_maxi         boolean not null default false   -- макси-сингл (только для kind='single')
);

-- Несколько альбомов одного сингла. Массив хранит порядок выбора;
-- parent_album_id остаётся первым альбомом для совместимости со старым клиентом.
alter table public.albums add column if not exists parent_album_ids uuid[];
alter table public.albums add column if not exists is_maxi boolean not null default false;
update public.albums
set parent_album_ids = case when parent_album_id is null then '{}'::uuid[] else array[parent_album_id] end
where parent_album_ids is null;

-- Макси может быть только синглом
do $$ begin
  alter table public.albums add constraint albums_maxi_kind_check check (is_maxi = false or kind = 'single');
exception when duplicate_object then null; end $$;

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

-- защита от дубликатов на уровне БД (артист + название + тип релиза,
-- без учёта регистра): сингл и альбом могут носить одно и то же название
create unique index if not exists albums_unique_kind
  on public.albums (lower(artist), lower(title), kind);

-- устаревший индекс без учёта типа релиза (если база создавалась раньше)
drop index if exists public.albums_unique;

alter table public.albums enable row level security;

create policy "albums_read"   on public.albums for select using (auth.role() = 'authenticated');
create policy "albums_insert" on public.albums for insert with check (auth.role() = 'authenticated');
create policy "albums_update" on public.albums for update using (auth.role() = 'authenticated');
create policy "albums_delete" on public.albums for delete using (auth.role() = 'authenticated');

-- финальность целостности и типа релиза (изменить выбранное нельзя)
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

-- флаг макси-сингла может быть только у сингла
create or replace function public.guard_maxi_flag()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.is_maxi and new.kind <> 'single' then
    raise exception 'Макси может быть только синглом';
  end if;
  return new;
end $$;

drop trigger if exists guard_maxi_flag on public.albums;
create trigger guard_maxi_flag before insert or update of is_maxi, kind on public.albums
for each row execute function public.guard_maxi_flag();


-- 3) Треки альбомов и макси-синглов (с порядком и блокировкой)
create table if not exists public.tracks (
  id          uuid primary key default gen_random_uuid(),
  album_id    uuid not null references public.albums(id) on delete cascade,
  title       text not null,
  position    integer not null default 0,
  locked      boolean not null default false,   -- название трека зафиксировано (админ)
  genius_song_id bigint,                        -- ID песни Genius для текста трека (null — не выбран)
  feat_artist text,                             -- артист на фите (ft./feat./&), необязательно
  single_id   uuid references public.albums(id) on delete set null,
                                                -- трек помечен как сингл → карточка сингла
  is_skipped  boolean not null default false,   -- пропущен админом, не оценивается
  skip_reason text,                             -- причина пропуска (ремикс, интро и т.д.)
  created_at  timestamptz not null default now()
);

alter table public.tracks enable row level security;

create policy "tracks_read"   on public.tracks for select using (auth.role() = 'authenticated');
create policy "tracks_insert" on public.tracks for insert with check (auth.role() = 'authenticated');
create policy "tracks_update" on public.tracks for update using (auth.role() = 'authenticated');
create policy "tracks_delete" on public.tracks for delete using (auth.role() = 'authenticated');


-- 3b) Оценки ТРЕКОВ (одна запись на пару трек+участник)
--     Балл альбома = среднее арифметическое оценок его треков (без пропущенных).
create table if not exists public.ratings (
  track_id   uuid not null references public.tracks(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  score      numeric(4,2) not null check (score >= 0 and score <= 10),
  confirmed  boolean not null default false,  -- оценка подтверждена участником (финальная)
  updated_at timestamptz not null default now(),
  primary key (track_id, profile_id)
);

alter table public.ratings enable row level security;

create policy "ratings_read"   on public.ratings for select using (auth.role() = 'authenticated');
create policy "ratings_insert" on public.ratings for insert with check (auth.uid() = profile_id);
create policy "ratings_update" on public.ratings for update using (auth.uid() = profile_id);
create policy "ratings_delete" on public.ratings for delete using (auth.uid() = profile_id);


-- 3c) Оценки СИНГЛОВ (одна оценка на релиз, а не на трек).
--     Таблица хранит только оценки строк с kind = 'single' и is_maxi = false.
create table if not exists public.single_ratings (
  album_id   uuid not null references public.albums(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  score      numeric(4,2) not null check (score >= 0 and score <= 10),
  confirmed  boolean not null default false,   -- подтверждена участником (финальная)
  updated_at timestamptz not null default now(),
  primary key (album_id, profile_id)
);

alter table public.single_ratings enable row level security;

create policy "single_ratings_read"   on public.single_ratings for select using (auth.role() = 'authenticated');
create policy "single_ratings_insert" on public.single_ratings for insert with check (auth.uid() = profile_id);
create policy "single_ratings_update" on public.single_ratings for update using (auth.uid() = profile_id);
create policy "single_ratings_delete" on public.single_ratings for delete using (auth.uid() = profile_id);


-- 4) Права для роли authenticated (важно: иначе таблицы не будут читаться)
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.albums   to authenticated;
grant select, insert, update, delete on public.ratings   to authenticated;
grant select, insert, update, delete on public.tracks    to authenticated;
grant select, insert, update, delete on public.single_ratings to authenticated;


-- 5) Хранилище обложек
--    (идёт ДО realtime: если realtime упадёт по правам, это не помешает
--     создать бакет и политики хранения)
insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do update set public = true;

-- чтение метаданных бакета (иначе API отвечает "Bucket not found")
drop policy if exists "buckets_read" on storage.buckets;
create policy "buckets_read" on storage.buckets
  for select
  to anon, authenticated
  using (true);

create policy "covers_read"   on storage.objects for select using (bucket_id = 'covers');
create policy "covers_insert" on storage.objects for insert with check (bucket_id = 'covers' and auth.role() = 'authenticated');
create policy "covers_update" on storage.objects for update using (bucket_id = 'covers' and auth.role() = 'authenticated');
create policy "covers_delete" on storage.objects for delete using (bucket_id = 'covers' and auth.role() = 'authenticated');


-- 6) Realtime — включаем таблицы в публикацию (для живой синхронизации).
--    Ловим ЛЮБУЮ ошибку: если у роли нет прав на alter publication —
--    таблицы/данные это не ломает, просто не будет live-синхронизации,
--    и её можно включить в Dashboard → Database → Replication.
do $$
begin
  alter publication supabase_realtime add table public.albums;
exception when others then
  raise notice 'realtime albums skipped: %', SQLERRM;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.ratings;
exception when others then
  raise notice 'realtime ratings skipped: %', SQLERRM;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.tracks;
exception when others then
  raise notice 'realtime tracks skipped: %', SQLERRM;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception when others then
  raise notice 'realtime profiles skipped: %', SQLERRM;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.single_ratings;
exception when others then
  raise notice 'realtime single_ratings skipped: %', SQLERRM;
end $$;

-- 8) Персональное оценивание. NULL сохраняет прежнее совместное поведение.
-- RESTRICT: удаление профиля не должно превращать персональный релиз в общий.
alter table public.albums add column if not exists evaluator_id uuid
  references public.profiles(id) on delete restrict;

-- Серверный список админов. Меняется ТОЛЬКО владельцем БД через SQL Editor.
-- Клиентский config.js и user_metadata не являются источниками полномочий.
create table if not exists public.release_admins (
  email text primary key check (email = lower(email))
);
alter table public.release_admins enable row level security;
revoke all on public.release_admins from public, anon, authenticated;
insert into public.release_admins(email) values ('sportgamergd@gmail.com') on conflict do nothing;

create or replace function public.is_release_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u join public.release_admins a on a.email = lower(u.email)
    where u.id = auth.uid()
  );
$$;
revoke all on function public.is_release_admin() from public;
grant execute on function public.is_release_admin() to authenticated;

create or replace function public.can_rate_release(release_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.albums a where a.id = release_id
      and (a.evaluator_id is null or a.evaluator_id = auth.uid())
  );
$$;
revoke all on function public.can_rate_release(uuid) from public;
grant execute on function public.can_rate_release(uuid) to authenticated;

create or replace function public.guard_release_evaluator()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    if new.evaluator_id is distinct from old.evaluator_id then
      raise exception 'Оценивающего можно выбрать только при создании релиза';
    end if;
    if new.cohesion is distinct from old.cohesion
       and new.evaluator_id is not null
       and new.evaluator_id is distinct from auth.uid() then
      raise exception 'Целостность выбирает только назначенный участник';
    end if;
  else
    if new.evaluator_id is not null and not public.is_release_admin() then
      -- Создание сингла из трека не назначает новые права: наследует родителя.
      -- Все родители дополнительно проверяются ниже.
      if new.kind <> 'single' or not exists (
        select 1 from public.albums a where a.id = new.parent_album_id
          and a.kind = 'album' and a.evaluator_id = new.evaluator_id
      ) then
        raise exception 'Назначать оценивающего может только админ';
      end if;
    end if;
    if new.cohesion is not null and new.evaluator_id is not null
       and new.evaluator_id is distinct from auth.uid() then
      raise exception 'Целостность выбирает только назначенный участник';
    end if;
  end if;

  if exists (
    select 1 from public.albums a
    where a.id = any(new.parent_album_ids)
      and a.evaluator_id is distinct from new.evaluator_id
  ) then
    raise exception 'У сингла и альбома должны совпадать оценивающие участники';
  end if;
  return new;
end $$;
revoke all on function public.guard_release_evaluator() from public;
-- Имя обеспечивает выполнение ПОСЛЕ normalize_single_albums (нормализация старого FK).
drop trigger if exists zz_guard_release_evaluator on public.albums;
create trigger zz_guard_release_evaluator before insert or update on public.albums
for each row execute function public.guard_release_evaluator();

-- Треки могут принадлежать альбому или макси-синглу, с проверкой оценивающих
create or replace function public.guard_track_evaluator()
returns trigger language plpgsql set search_path = '' as $$
declare
  target_evaluator uuid;
  target_kind text;
  target_is_maxi boolean;
begin
  select a.evaluator_id, a.kind, coalesce(a.is_maxi,false)
    into target_evaluator, target_kind, target_is_maxi
  from public.albums a where a.id = new.album_id;
  if not found then raise exception 'Трек должен принадлежать альбому или макси-синглу'; end if;
  if target_kind = 'album' then
    -- ok
  elsif target_kind = 'single' and target_is_maxi then
    -- ok
  else
    raise exception 'Трек может принадлежать только альбому или макси-синглу';
  end if;
  if TG_OP = 'UPDATE' and new.album_id is distinct from old.album_id then
    declare
      old_evaluator uuid;
    begin
      select a.evaluator_id into old_evaluator from public.albums a where a.id = old.album_id;
      if old_evaluator is distinct from target_evaluator then
        raise exception 'Нельзя переносить трек между разными режимами оценивания';
      end if;
    end;
  end if;
  if new.single_id is not null then
    if target_kind = 'single' and target_is_maxi then
      raise exception 'Трек макси-сингла нельзя помечать как сингл';
    end if;
    if not exists (
      select 1 from public.albums s where s.id = new.single_id and s.kind = 'single'
        and s.evaluator_id is not distinct from target_evaluator
        and coalesce(s.is_maxi,false) = false
    ) then
      raise exception 'У сингла и альбома должны совпадать оценивающие участники';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_track_evaluator() from public;
drop trigger if exists guard_track_evaluator on public.tracks;
create trigger guard_track_evaluator before insert or update of album_id, single_id on public.tracks
for each row execute function public.guard_track_evaluator();

-- Лимит треков в макси-сингле — до 3
create or replace function public.guard_maxi_track_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  cnt int;
  _is_maxi boolean;
  k text;
begin
  select coalesce(a.is_maxi,false), a.kind into _is_maxi, k from public.albums a where a.id = new.album_id;
  if k = 'single' and _is_maxi then
    select count(*) into cnt from public.tracks where album_id = new.album_id and (TG_OP = 'INSERT' or id <> new.id);
    if cnt >= 3 then
      raise exception 'В макси-сингле не может быть больше 3 треков';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_maxi_track_limit on public.tracks;
create trigger guard_maxi_track_limit before insert or update of album_id on public.tracks
for each row execute function public.guard_maxi_track_limit();

-- Пропускать треки может только админ, при снятии пропуска очищаем причину
create or replace function public.guard_track_skip()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if new.is_skipped and not public.is_release_admin() then
      raise exception 'Пропускать треки может только админ';
    end if;
  else
    if (new.is_skipped is distinct from old.is_skipped or new.skip_reason is distinct from old.skip_reason) then
      if not public.is_release_admin() then
        raise exception 'Пропускать треки может только админ';
      end if;
    end if;
  end if;
  if not new.is_skipped then
    new.skip_reason := null;
  end if;
  return new;
end $$;
revoke all on function public.guard_track_skip() from public;
drop trigger if exists guard_track_skip on public.tracks;
create trigger guard_track_skip before insert or update of is_skipped, skip_reason on public.tracks
for each row execute function public.guard_track_skip();

-- При пропуске трека удаляем его оценки (по требованию: удалять)
create or replace function public.cleanup_skipped_ratings()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.is_skipped and (TG_OP = 'INSERT' or old.is_skipped = false) then
    delete from public.ratings where track_id = new.id;
  end if;
  return new;
end $$;
revoke all on function public.cleanup_skipped_ratings() from public;
drop trigger if exists cleanup_skipped_ratings on public.tracks;
create trigger cleanup_skipped_ratings after insert or update of is_skipped on public.tracks
for each row execute function public.cleanup_skipped_ratings();

-- Макси-сингл нельзя оценивать целиком через single_ratings
create or replace function public.guard_single_rating_maxi()
returns trigger language plpgsql set search_path = '' as $$
declare
  _is_maxi boolean;
begin
  select coalesce(a.is_maxi,false) into _is_maxi from public.albums a where a.id = new.album_id and a.kind = 'single';
  if _is_maxi then
    raise exception 'Макси-сингл оценивается по трекам, а не целиком';
  end if;
  return new;
end $$;
revoke all on function public.guard_single_rating_maxi() from public;
drop trigger if exists guard_single_rating_maxi on public.single_ratings;
create trigger guard_single_rating_maxi before insert or update on public.single_ratings
for each row execute function public.guard_single_rating_maxi();

-- SELECT остаётся общим: результаты видны обоим. Проверяем и старую, и новую
-- строку UPDATE, чтобы нельзя было обойти ограничения заменой track_id/album_id.
drop policy if exists ratings_insert on public.ratings;
drop policy if exists ratings_update on public.ratings;
drop policy if exists ratings_delete on public.ratings;
create policy ratings_insert on public.ratings for insert to authenticated
with check (auth.uid() = profile_id and exists (
  select 1 from public.tracks t where t.id = track_id and public.can_rate_release(t.album_id)
));
create policy ratings_update on public.ratings for update to authenticated
using (auth.uid() = profile_id and exists (
  select 1 from public.tracks t where t.id = track_id and public.can_rate_release(t.album_id)
)) with check (auth.uid() = profile_id and exists (
  select 1 from public.tracks t where t.id = track_id and public.can_rate_release(t.album_id)
));
create policy ratings_delete on public.ratings for delete to authenticated
using (auth.uid() = profile_id and exists (
  select 1 from public.tracks t where t.id = track_id and public.can_rate_release(t.album_id)
));

drop policy if exists single_ratings_insert on public.single_ratings;
drop policy if exists single_ratings_update on public.single_ratings;
drop policy if exists single_ratings_delete on public.single_ratings;
create policy single_ratings_insert on public.single_ratings for insert to authenticated
with check (auth.uid() = profile_id and public.can_rate_release(album_id)
  and exists (select 1 from public.albums a where a.id = album_id and a.kind = 'single' and coalesce(a.is_maxi,false) = false));
create policy single_ratings_update on public.single_ratings for update to authenticated
using (auth.uid() = profile_id and public.can_rate_release(album_id))
with check (auth.uid() = profile_id and public.can_rate_release(album_id)
  and exists (select 1 from public.albums a where a.id = album_id and a.kind = 'single' and coalesce(a.is_maxi,false) = false));
create policy single_ratings_delete on public.single_ratings for delete to authenticated
using (auth.uid() = profile_id and public.can_rate_release(album_id));

commit;
