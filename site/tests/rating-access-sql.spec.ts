import { expect, test } from '@playwright/test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Настоящий PostgreSQL в WASM: проверяем триггеры и RLS, а не моки ответов API.
// Supabase auth/storage заменены минимальными схемами; облачная база не используется.
const admin = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const album = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shared = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const single = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const track = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const otherTrack = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const sqlFile = (name: string) => readFileSync(path.resolve(__dirname, '..', name), 'utf8');

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;
    grant usage on schema auth to authenticated;
    grant execute on all functions in schema auth to authenticated;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean);
    create table storage.objects(id uuid primary key, bucket_id text);
    insert into auth.users values ('${admin}', 'sportgamergd@gmail.com'), ('${peer}', 'peer@example.com');
  `);
  await db.exec(sqlFile('schema.sql'));
  await db.exec(`insert into public.profiles(id, username) values ('${admin}', 'Admin'), ('${peer}', 'Peer')`);
  await db.exec(sqlFile('migrate.sql'));
  await db.exec(sqlFile('migrate.sql')); // идемпотентность
  return db;
}

async function login(db: PGlite, id: string) {
  await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false)`);
}

async function fixtures(db: PGlite) {
  await login(db, admin);
  await db.exec(`
    insert into albums(id, artist, title, year, evaluator_id) values ('${album}', 'Artist', 'Personal', 2025, '${peer}');
    insert into albums(id, artist, title, year) values ('${shared}', 'Artist', 'Shared', 2025);
    insert into albums(id, artist, title, year, kind, evaluator_id, parent_album_id)
      values ('${single}', 'Artist', 'Single', 2025, 'single', '${peer}', '${album}');
    insert into tracks(id, album_id, title, single_id) values ('${track}', '${album}', 'Track', '${single}');
    insert into tracks(id, album_id, title) values ('${otherTrack}', '${shared}', 'Shared track');
  `);
}

test('SQL: назначение только при создании, защита ролей, совместимость связей и целостность', async () => {
  test.setTimeout(60000);
  const db = await setup();
  try {
    await fixtures(db);
    await expect(db.exec(`update albums set evaluator_id = '${admin}' where id = '${album}'`)).rejects.toThrow(/только при создании/);
    await expect(db.exec(`update albums set cohesion = 3 where id = '${album}'`)).rejects.toThrow(/только назначенный/);
    await expect(db.exec(`update albums set parent_album_ids = array['${shared}'::uuid] where id = '${single}'`)).rejects.toThrow(/должны совпадать/);
    await expect(db.exec(`update tracks set single_id = '${single}' where id = '${otherTrack}'`)).rejects.toThrow(/должны совпадать/);
    await expect(db.exec(`update tracks set album_id = '${shared}' where id = '${track}'`)).rejects.toThrow(/Нельзя переносить/);
    // Тип релиза и остальные метаданные не являются частью запрета.
    await db.exec(`update albums set album_type = 'ep', cover_url = 'cover.jpg' where id = '${album}'`);
    await login(db, peer);
    await expect(db.exec(`insert into release_admins values ('peer@example.com')`)).rejects.toThrow(/permission denied/);
    await expect(db.exec(`insert into albums(artist,title,year,evaluator_id) values ('Artist','Forbidden',2025,'${peer}')`)).rejects.toThrow(/только админ/);
    await db.exec(`update albums set cohesion = 3 where id = '${album}'`);
    // Обычный участник может сделать сингл из персонального трека, наследуя права.
    await db.exec(`insert into albums(artist,title,year,kind,evaluator_id,parent_album_id)
      values ('Artist','Inherited',2025,'single','${peer}','${album}')`);
    await expect(db.exec(`update albums set cohesion = 4 where id = '${album}'`)).rejects.toThrow(/final/);
    await login(db, admin);
    // Удаление родителя оставляет сингл персональным и убирает только связь.
    await db.exec(`delete from albums where id = '${album}'`);
    const result = await db.query(`select evaluator_id, parent_album_ids from albums where id = '${single}'`);
    expect(result.rows).toEqual([{ evaluator_id: peer, parent_album_ids: [] }]);
  } finally { await db.close(); }
});

test('SQL RLS: админ-наблюдатель не оценивает; чтение общее, запись только своя и разрешённая', async () => {
  test.setTimeout(60000);
  const db = await setup();
  try {
    await fixtures(db);
    await expect(db.exec(`insert into ratings(track_id, profile_id, score) values ('${track}','${admin}',8)`)).rejects.toThrow(/row-level security/);
    await expect(db.exec(`insert into single_ratings(album_id, profile_id, score) values ('${single}','${admin}',8)`)).rejects.toThrow(/row-level security/);
    await db.exec(`insert into ratings(track_id, profile_id, score) values ('${otherTrack}','${admin}',7)`);
    await expect(db.exec(`update ratings set track_id = '${track}' where track_id = '${otherTrack}'`)).rejects.toThrow(/row-level security/);
    await login(db, peer);
    await db.exec(`insert into ratings(track_id, profile_id, score, confirmed) values ('${track}','${peer}',9,true)`);
    await db.exec(`insert into single_ratings(album_id, profile_id, score, confirmed) values ('${single}','${peer}',9,true)`);
    await expect(db.exec(`insert into ratings(track_id, profile_id, score) values ('${track}','${admin}',8)`)).rejects.toThrow(/row-level security/);
    await login(db, admin);
    expect((await db.query(`select * from ratings where track_id = '${track}'`)).rows).toHaveLength(1);
    expect((await db.query(`select * from single_ratings`)).rows).toHaveLength(1);
    expect((await db.query(`update ratings set score = 1 where track_id = '${track}' returning *`)).rows).toEqual([]);
    expect((await db.query(`delete from single_ratings where album_id = '${single}' returning *`)).rows).toEqual([]);
    await login(db, peer);
    await db.exec(`update ratings set score = 10 where track_id = '${track}'; delete from single_ratings where album_id = '${single}'`);
    // Повторная миграция не сбрасывает назначение, оценки или права.
    await db.exec('reset role');
    await db.exec(sqlFile('migrate.sql'));
    expect((await db.query(`select evaluator_id from albums where id = '${album}'`)).rows).toEqual([{ evaluator_id: peer }]);
    await login(db, admin);
    await expect(db.exec(`insert into single_ratings(album_id, profile_id, score) values ('${single}','${admin}',8)`)).rejects.toThrow(/row-level security/);
  } finally { await db.close(); }
});
