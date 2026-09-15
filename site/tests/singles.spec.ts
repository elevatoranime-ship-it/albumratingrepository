import { expect, test, type Page } from '@playwright/test';

/* Тесты раздела «синглы». Настоящая база не используется: все запросы к Supabase
   подменяются тестовым ответом (как в tests/realtime.spec.ts). */

const ORIGIN = 'https://ratings-singles-test.supabase.co';
const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'first@demo.local', username: 'Первый', initials: 'П', avatar_url: null };
const PEER = { id: '22222222-2222-4222-8222-222222222222', email: 'second@demo.local', username: 'Второй', initials: 'В', avatar_url: null };

const ALBUM = { id: 'album-one', title: 'Общий альбом', artist: 'Артист', year: 2025, cover_url: '', tracks_locked: false, cohesion: null, album_type: 'album', kind: 'album', parent_album_id: null, created_at: '2025-01-01' };
const SINGLE = { id: 'single-one', title: 'Первый сингл', artist: 'Артист', year: 2025, cover_url: '', tracks_locked: false, cohesion: null, album_type: null, kind: 'single', parent_album_id: ALBUM.id, created_at: '2025-02-01' };
const SOLO = { id: 'single-two', title: 'Отдельный сингл', artist: 'Другой артист', year: 2024, cover_url: '', tracks_locked: false, cohesion: null, album_type: null, kind: 'single', parent_album_id: null, created_at: '2025-03-01' };
const TRACK = { id: 'track-one', album_id: ALBUM.id, title: 'Первый трек', position: 0, locked: false, feat_artist: null, single_id: SINGLE.id };
const TRACK_TWO = { id: 'track-two', album_id: ALBUM.id, title: 'Второй трек', position: 1, locked: false, feat_artist: null, single_id: null };

type SingleRow = { album_id: string; profile_id: string; score: number; confirmed: boolean };
const pageErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(pageErrors.get(page) ?? []).toEqual([]); });

function backend() {
  const state = {
    albums: [structuredClone(ALBUM), structuredClone(SINGLE), structuredClone(SOLO)],
    tracks: [structuredClone(TRACK), structuredClone(TRACK_TWO)],
    ratings: [{ track_id: TRACK.id, profile_id: ME.id, score: 7, confirmed: true }],
    singleRatings: [
      { album_id: SINGLE.id, profile_id: ME.id, score: 8, confirmed: true },
      { album_id: SINGLE.id, profile_id: PEER.id, score: 6, confirmed: false },
    ] as SingleRow[],
    writes: [] as Array<{ method: string; path: string; body: unknown }>,
  };
  const install = async (page: Page) => {
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === 'http://127.0.0.1:8080') return route.continue();
      return route.abort();
    });
    await page.route('**/config.js', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: `window.APP_CONFIG = ${JSON.stringify({
        supabaseUrl: ORIGIN,
        supabaseAnonKey: 'sb_publishable_mock-only',
        allowedUsers: [ME, PEER].map((u) => ({ ...u, admin: false })),
      })};`,
    }));
    // Молчаливый Realtime: приложение продолжит работать и на фоновой сверке.
    await page.routeWebSocket(`wss://${new URL(ORIGIN).host}/**`, (route) => {
      route.onMessage((raw) => {
        const [joinRef, ref, topic] = JSON.parse(String(raw)) as [number, number, string];
        route.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }]));
      });
    });
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
      const json = (body: unknown, status = 200) => route.fulfill({ headers, status, contentType: 'application/json', body: JSON.stringify(body) });
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.pathname === '/auth/v1/logout') return json({});
      if (url.pathname === '/auth/v1/token') {
        const account = [ME, PEER].find((u) => u.email === request.postDataJSON().email) ?? ME;
        const user = { ...account, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2025-01-01T00:00:00Z' };
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const jwt = [
          Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
          Buffer.from(JSON.stringify({ sub: user.id, exp, role: 'authenticated' })).toString('base64url'),
          'test-signature',
        ].join('.');
        return json({ access_token: jwt, refresh_token: 'test-refresh', token_type: 'bearer', expires_at: exp, expires_in: 3600, user });
      }

      const table = url.pathname.split('/').pop();
      const one = (value: string | null) => (value ? value.slice(3) : null);
      const id = one(url.searchParams.get('id'));
      const body = request.postDataJSON?.() ?? null;
      const wantsOne = String(request.headers()['accept'] ?? '').includes('vnd.pgrst.object');

      if (request.method() === 'GET') {
        if (table === 'profiles') return json(url.searchParams.has('id') ? [ME, PEER].filter((u) => `eq.${u.id}` === url.searchParams.get('id')) : [ME, PEER]);
        if (table === 'albums') return json(state.albums);
        if (table === 'tracks') return json(state.tracks);
        if (table === 'ratings') return json(state.ratings);
        if (table === 'single_ratings') return json(state.singleRatings);
      }

      if (request.method() === 'POST') {
        state.writes.push({ method: 'POST', path: url.pathname + url.search, body });
        if (table === 'single_ratings') {
          const row = body as SingleRow;
          state.singleRatings = state.singleRatings.filter((r) => !(r.album_id === row.album_id && r.profile_id === row.profile_id));
          state.singleRatings.push(row);
          return json(null, 201);
        }
        if (table === 'albums') {
          const row = { ...(body as Record<string, unknown>), id: 'created-single', cover_url: (body as { cover_url?: string | null }).cover_url ?? '', created_at: '2025-04-01' };
          state.albums.push(row as typeof ALBUM);
          if (String(request.headers()['prefer'] ?? '').includes('return=representation')) {
            return json(wantsOne ? { id: row.id } : [row], 201);
          }
          return json(null, 201);
        }
        if (table === 'tracks') return json(null, 201);
      }

      if (request.method() === 'PATCH') {
        state.writes.push({ method: 'PATCH', path: url.pathname + url.search, body });
        if (table === 'single_ratings') {
          const albumId = one(url.searchParams.get('album_id'));
          const profileId = one(url.searchParams.get('profile_id'));
          for (const row of state.singleRatings) {
            if (row.album_id === albumId && row.profile_id === profileId) Object.assign(row, body);
          }
          return json(null, 204);
        }
        if (table === 'albums') {
          const row = state.albums.find((a) => a.id === id);
          if (row) Object.assign(row, body);
          return json(null, 204);
        }
        if (table === 'tracks') {
          const row = state.tracks.find((t) => t.id === id);
          if (row) Object.assign(row, body);
          return json(null, 204);
        }
      }

      if (request.method() === 'DELETE') {
        state.writes.push({ method: 'DELETE', path: url.pathname + url.search, body: null });
        if (table === 'single_ratings') {
          const albumId = one(url.searchParams.get('album_id'));
          const profileId = one(url.searchParams.get('profile_id'));
          state.singleRatings = state.singleRatings.filter((r) => !(r.album_id === albumId && r.profile_id === profileId));
          return json(null, 204);
        }
        if (table === 'albums') {
          state.albums = state.albums.filter((a) => a.id !== id);
          // как внешний ключ tracks.single_id → albums on delete set null
          state.tracks = state.tracks.map((t) => (t.single_id === id ? { ...t, single_id: null } : t));
          return json(null, 204);
        }
      }
      throw new Error(`Unexpected mock request: ${request.method()} ${url.pathname}`);
    });
    return { state, errors };
  };
  return { state, install };
}

async function login(page: Page, email = ME.email) {
  await page.goto('/');
  await page.locator('#email-input').fill(email);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}

const cards = (page: Page) => page.locator('#albums .album');
const cardByTitle = (page: Page, title: string) => cards(page).filter({ has: page.locator('.album__title', { hasText: title }) });

test('главная: переключатель разделов, карточки и кнопка рейтинга', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);

  await expect(cards(page)).toHaveCount(2); // альбом + плитка добавления
  await expect(page.locator('#home-hdr-title')).toHaveText('Альбомы');
  await expect(page.locator('#rank-btn-label')).toHaveText('рейтинг артистов');

  await page.locator('#seg-singles').click();
  await expect(page.locator('#home-hdr-title')).toHaveText('Синглы');
  await expect(cards(page)).toHaveCount(3); // два сингла + плитка
  await expect(page.locator('.album__badge')).toHaveCount(2);
  await expect(page.locator('#rank-btn-label')).toHaveText('рейтинг синглов');
  await expect(page.locator('#albums .album--add')).toContainText('добавить сингл');
  await expect(cardByTitle(page, 'Первый сингл')).toContainText('к альбому «Общий альбом»');
  // карточка показывает среднее по всем оценкам релиза, как у альбомов: (8 + 6) / 2 = 7,
  // и подпись про неподтверждённую оценку второго участника
  await expect(cardByTitle(page, 'Первый сингл').locator('.album__avg-num')).toHaveText('7');
  await expect(cardByTitle(page, 'Первый сингл')).toContainText('без подтверждения');
  // у сингла вне альбома на карточке нет строки «вне альбома»
  await expect(cardByTitle(page, 'Отдельный сингл').locator('.album__parent')).toHaveCount(0);

  // выбор раздела запоминается
  await page.reload();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await expect(page.locator('#home-hdr-title')).toHaveText('Синглы');
});

test('страница сингла: чужая неподтверждённая оценка скрыта, своя подтверждается', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await cardByTitle(page, 'Первый сингл').locator('.album__title').click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);

  await expect(page.locator('#sv-title')).toHaveText('Первый сингл');
  await expect(page.locator('#sv-mine')).toContainText('8');
  await expect(page.locator('#sv-peer')).toHaveText('');      // 6 у второго участника ещё не подтверждена
  await expect(page.locator('#sv-parent-label')).toContainText('Общий альбом');
  await expect(page.locator('#sv-slider')).toBeDisabled();    // подтверждённую оценку нельзя двигать
  await expect(page.locator('#sv-confirm-btn')).toHaveAttribute('aria-label', 'Изменить оценку');

  await page.locator('#sv-confirm-btn').click();
  await expect(page.locator('#sv-slider')).toBeEnabled();
  await expect(page.locator('#sv-confirm-state')).toContainText('не подтверждён');
  await expect(page.locator('.toast')).toHaveText('Оценку можно менять — сингл пока не в рейтинге');
  await page.locator('#sv-num').fill('9');
  await expect(page.locator('#sv-avg')).toHaveText('7.5');    // (9 + 6) / 2 — черновик виден на странице
  // Регресс: раньше балл вводили в поле и сразу жали ✓ — синхронизация на blur пересоздавала
  // иконку кнопки (внутренний svg), узел под курсором исчезал между mousedown и mouseup,
  // и браузер вообще не присылал click. Теперь иконка меняется только вместе с состоянием.
  await page.evaluate(() => {
    const nodes: { down: Element | null; up: Element | null } = { down: null, up: null };
    (window as unknown as { __clickNodes: typeof nodes }).__clickNodes = nodes;
    const btn = document.querySelector('#sv-confirm-btn');
    btn?.addEventListener('pointerdown', () => { nodes.down = document.querySelector('#sv-confirm-btn svg'); }, true);
    btn?.addEventListener('pointerup', () => { nodes.up = document.querySelector('#sv-confirm-btn svg'); }, true);
  });
  await page.locator('#sv-confirm-btn').click();
  expect(await page.evaluate(() => {
    const nodes = (window as unknown as { __clickNodes?: { down: Element | null; up: Element | null } }).__clickNodes;
    return Boolean(nodes?.down) && nodes?.down === nodes?.up;
  })).toBe(true);
  await expect(page.locator('#sv-confirm-btn')).toHaveAttribute('aria-label', 'Изменить оценку');
  await expect(page.locator('#sv-slider')).toBeDisabled();
  // второй участник ещё не подтвердил — релиз пока вне рейтинга, и уведомление об этом честное
  await expect(page.locator('.toast')).toHaveText('Оценка подтверждена — ждём подтверждения второго участника');

  const upserts = cloud.state.writes.filter((w) => w.method === 'POST' && w.path.startsWith('/rest/v1/single_ratings'));
  expect(upserts.length).toBeGreaterThan(0);
  expect(upserts[upserts.length - 1].body).toMatchObject({ album_id: SINGLE.id, profile_id: ME.id, score: 9, confirmed: true });
});

test('рейтинг синглов: только релизы, подтверждённые всеми участниками', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await page.locator('#artists-btn').click();
  await expect(page.locator('#view-srank')).toHaveClass(/is-visible/);

  const rows = page.locator('#single-rank-list .rank');
  await expect(rows).toHaveCount(2);
  // Оба сингла пока вне рейтинга, поэтому порядок — как в рейтинге артистов, по алфавиту:
  // «Отдельный сингл» (без оценок) идёт первым, «Первый сингл» — следом.
  await expect(rows.nth(0)).toContainText('Отдельный сингл');
  await expect(rows.nth(0)).toContainText('оценок пока нет');
  await expect(rows.nth(0).locator('.rank__score')).toHaveText('—');
  // у «Первого сингла» второй участник не подтвердил оценку — релиз вне рейтинга
  await expect(rows.nth(1)).toContainText('Первый сингл');
  await expect(rows.nth(1).locator('.rank__score')).toHaveText('—');
  await expect(rows.nth(1)).toContainText('ждём подтверждения всех оценок');

  // как только оценки подтвердили оба участника, релиз попадает в рейтинг
  await page.locator('#srank-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await cardByTitle(page, 'Первый сингл').locator('.album__title').click();
  cloud.state.singleRatings.find((r) => r.profile_id === PEER.id).confirmed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#sv-confirm-state')).toContainText('подтверждён');
  await page.locator('#single-back').click();
  await page.locator('#artists-btn').click();
  await expect(page.locator('#single-rank-list .rank').first().locator('.rank__score')).toHaveText('7');   // (8 + 6) / 2
  await expect(page.locator('#single-rank-list .rank').first()).toContainText('Первый сингл');
});

test('метка трека: бейдж, модалка перехода и снятие метки', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await cardByTitle(page, 'Общий альбом').locator('.album__title').click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);

  const first = page.locator('#track-list .track').first();
  await expect(first.locator('.track__single')).toHaveCount(1);
  await expect(page.locator('#av-singles-section')).toBeVisible();
  await expect(page.locator('#av-singles')).toContainText('Первый сингл');

  // клик по бейджу — сразу на страницу сингла, без модалки перехода
  await first.locator('.track__single').click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);
  await expect(page.locator('#confirm-modal')).toBeHidden();
  await expect(page.locator('#sv-origin')).toContainText('трека');
  await page.locator('#single-back').click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);

  // клик по строке трека — вопрос с «да» и «назад»
  await first.locator('.track__title').click();
  const modal = page.locator('#confirm-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText('Перейти на страницу сингла?');
  await expect(page.locator('#confirm-ok')).toHaveText('да');
  await expect(page.locator('#confirm-cancel')).toHaveText('назад');
  await page.locator('#confirm-cancel').click();
  await expect(page.locator('#confirm-ok')).toHaveText('да');   // подписи не мигают при закрытии
  await expect(modal).toBeHidden();
  await expect(page.locator('#confirm-ok')).toHaveText('подтвердить');
  await expect(page.locator('#confirm-cancel')).toHaveText('отмена');
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);

  // снятие метки не удаляет сингл
  await page.locator('[data-act="unsingle"]').first().click();
  await expect(page.locator('#confirm-title')).toHaveText('Снять метку «сингл»?');
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#track-list .track').first().locator('.track__single')).toHaveCount(0);
  await expect(page.locator('#av-singles')).toContainText('Первый сингл');
  const untouched = cloud.state.writes.filter((w) => w.method === 'DELETE' && w.path.startsWith('/rest/v1/albums'));
  expect(untouched).toEqual([]);
});

test('сингл с привязкой становится треком альбома (совместка «&») и его открывает плашка', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album--add').click();
  await expect(page.locator('#view-add')).toHaveClass(/is-visible/);
  await page.locator('#artist-input').fill('Другой артист');
  await page.locator('#title-input').fill('Второй трек');   // трек с таким названием уже есть в альбоме
  await page.locator('#year-input').fill('2025');
  await page.locator('#parent-input').fill('Общий');
  await page.locator('#parent-list .combo__item').first().click();
  await page.locator('#add-submit').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);

  // дубля нет: существующий трек просто помечен синглом
  const inserts = cloud.state.writes.filter((w) => w.method === 'POST' && w.path.startsWith('/rest/v1/tracks'));
  expect(inserts).toEqual([]);
  const patch = cloud.state.writes.filter((w) => w.method === 'PATCH' && w.path.startsWith('/rest/v1/tracks')).pop();
  expect(patch?.body).toMatchObject({ single_id: 'created-single' });
  await expect(page.locator('#albums .album--add')).toBeVisible();
});
test('новый сингл создаётся из трека и привязывается к альбому', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await cardByTitle(page, 'Общий альбом').locator('.album__title').click();

  await page.locator('#track-list .track').nth(1).locator('[data-act="single"]').click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);
  await expect(page.locator('#sv-title')).toHaveText('Второй трек');

  const inserts = cloud.state.writes.filter((w) => w.method === 'POST' && w.path.startsWith('/rest/v1/albums'));
  expect(inserts).toHaveLength(1);
  expect(inserts[0].body).toMatchObject({ artist: 'Артист', title: 'Второй трек', year: 2025, kind: 'single', parent_album_id: ALBUM.id });
  const trackPatch = cloud.state.writes.filter((w) => w.method === 'PATCH' && w.path.startsWith('/rest/v1/tracks'));
  expect(trackPatch[trackPatch.length - 1].body).toMatchObject({ single_id: 'created-single' });
});

test('привязка к альбому меняется и снимается, сингл удаляется отдельно', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await cardByTitle(page, 'Отдельный сингл').locator('.album__title').click();
  await expect(page.locator('#sv-parent-label')).toHaveText('сингл вне альбома');

  await page.locator('#sv-parent-edit').click();
  await expect(page.locator('#single-link-dialog')).toBeVisible();
  await page.locator('#single-link-input').fill('Общий');
  await page.locator('#single-link-list .combo__item').first().click();
  await page.locator('#single-link-save').click();
  await expect(page.locator('#sv-parent-label')).toContainText('Общий альбом');
  const linkPatch = cloud.state.writes.filter((w) => w.method === 'PATCH' && w.path.includes('id=eq.single-two'));
  expect(linkPatch[0].body).toMatchObject({ parent_album_id: ALBUM.id });

  await page.locator('#sv-parent-edit').click();
  await page.locator('#single-link-unlink').click();
  await expect(page.locator('#sv-parent-label')).toHaveText('сингл вне альбома');

  await page.locator('#single-delete-btn').click();
  await expect(page.locator('#confirm-title')).toHaveText('Удалить сингл?');
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await expect(page.locator('#home-hdr-title')).toHaveText('Синглы');
  await expect(cardByTitle(page, 'Отдельный сингл')).toHaveCount(0);
  expect(cloud.state.writes.some((w) => w.method === 'DELETE' && w.path.includes('id=eq.single-two'))).toBe(true);
});

test('экран добавления сингла: привязка к альбому и запись kind=single', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album--add').click();
  await expect(page.locator('#view-add')).toHaveClass(/is-visible/);
  await expect(page.locator('#add-title')).toHaveText('Новый сингл');
  await expect(page.locator('#title-label')).toHaveText('Название сингла *');
  await expect(page.locator('#add-submit-label')).toHaveText('Добавить сингл');
  await expect(page.locator('#parent-field')).toBeVisible();

  await page.locator('#artist-input').fill('Новый артист');
  await page.locator('#title-input').fill('Свежий сингл');
  await page.locator('#year-input').fill('2025');
  await page.locator('#parent-input').fill('Общий');
  await page.locator('#parent-list .combo__item').first().click();
  await page.locator('#add-submit').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await expect(page.locator('#home-hdr-title')).toHaveText('Синглы');
  await expect(cardByTitle(page, 'Свежий сингл')).toContainText('к альбому «Общий альбом»');

  const insert = cloud.state.writes.filter((w) => w.method === 'POST' && w.path.startsWith('/rest/v1/albums')).pop();
  expect(insert?.body).toMatchObject({ artist: 'Новый артист', title: 'Свежий сингл', kind: 'single', parent_album_id: ALBUM.id });
});

test('если миграция не выполнена, раздел синглов честно сообщает об этом', async ({ page }) => {
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === 'http://127.0.0.1:8080' ? route.continue() : route.abort()));
  await page.route('**/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.APP_CONFIG = ${JSON.stringify({
      supabaseUrl: ORIGIN, supabaseAnonKey: 'sb_publishable_mock-only', allowedUsers: [ME, PEER].map((u) => ({ ...u, admin: false })),
    })};`,
  }));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,DELETE,PATCH,OPTIONS' };
    const json = (body: unknown, status = 200) => route.fulfill({ headers, status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/auth/v1/logout') return json({});
    if (url.pathname === '/auth/v1/token') {
      const user = { ...ME, aud: 'authenticated', role: 'authenticated', created_at: '2025-01-01T00:00:00Z' };
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const jwt = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: user.id, exp, role: 'authenticated' })).toString('base64url'),
        'test-signature',
      ].join('.');
      return json({ access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_at: exp, expires_in: 3600, user });
    }
    const table = url.pathname.split('/').pop();
    if (table === 'profiles') return json(url.searchParams.has('id') ? [ME] : [ME, PEER]);
    if (table === 'albums') return json([ALBUM]);
    if (table === 'tracks') return json([TRACK_TWO]);
    if (table === 'ratings') return json([]);
    if (table === 'single_ratings') return json({ message: 'relation "public.single_ratings" does not exist', code: '42P01' }, 404);
    throw new Error(`Unexpected mock request: ${request.method()} ${url.pathname}`);
  });

  await login(page);
  await page.locator('#seg-singles').click();
  await expect(page.locator('.home__notice')).toContainText('migrate.sql');
  await expect(page.locator('#home-meta')).toHaveText('синглы недоступны');
  await page.locator('#seg-albums').click();
  await expect(cards(page)).toHaveCount(2); // альбомы продолжают работать
});
