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
        if (table === 'ratings') {
          const row = body as { track_id: string; profile_id: string; score: number; confirmed: boolean };
          state.ratings = state.ratings.filter((r) => !(r.track_id === row.track_id && r.profile_id === row.profile_id));
          state.ratings.push(row);
          return json(null, 201);
        }
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
        if (table === 'tracks') {
          state.tracks.push({ ...body, id: `created-track-${state.tracks.length}` });
          return json(null, 201);
        }
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
        if (table === 'ratings') {
          state.ratings = state.ratings.filter((r) => !(r.track_id === one(url.searchParams.get('track_id')) && r.profile_id === one(url.searchParams.get('profile_id'))));
          return json(null, 204);
        }
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

test('фит из названия сингла показывается в блоке артиста, а не в названии', async ({ page }) => {
  const cloud = backend();
  cloud.state.albums.push(
    { ...SOLO, id: 'single-collab', title: 'Мегахит & Гость', artist: 'Основной', year: 2025 },
    { ...SOLO, id: 'single-feat', title: 'Антология (ft. Гость)', artist: 'Основной', year: 2025 },
  );
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();

  // карточки на главной: название чистое, гостя показывает строка артиста
  const collab = cardByTitle(page, 'Мегахит');
  await expect(collab.locator('.album__title')).toHaveText('Мегахит');
  await expect(collab.locator('.album__artist')).toHaveText('Основной & Гость');
  const feat = cardByTitle(page, 'Антология');
  await expect(feat.locator('.album__title')).toHaveText('Антология');
  await expect(feat.locator('.album__artist')).toHaveText('Основной (feat. Гость)');

  // страница сингла: «&» остаётся «&», оба имени — ссылки на профили
  await collab.locator('.album__title').click();
  await expect(page.locator('#sv-title')).toHaveText('Мегахит');
  await expect(page.locator('#sv-artist')).toHaveText('Основной & Гость');
  const guest = page.locator('#sv-artist a').nth(1);
  await expect(guest).toHaveAttribute('data-artist', 'Гость');
  await guest.click();
  await expect(page.locator('#view-artist')).toHaveClass(/is-visible/);
  await expect(page.locator('#artist-name')).toHaveText('Гость');
  // гость видит совместный сингл в разделе «при участии» — с чистым названием
  await expect(page.locator('#artist-feat')).toContainText('Мегахит');

  // «ft.» в названии на экране сингла автоматически показывается как «feat.»
  await page.locator('#artist-back').click();   // со страницы артиста — назад, на страницу сингла
  await page.locator('#single-back').click();   // и на главную, где лежат карточки
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await feat.locator('.album__title').click();
  await expect(page.locator('#sv-title')).toHaveText('Антология');
  await expect(page.locator('#sv-artist')).toHaveText('Основной (feat. Гость)');

  // привязка совместки к чужому альбому: трек создаётся от чистого названия,
  // без двойного «& Гость & Артист»
  await page.locator('#single-back').click();
  await collab.locator('.album__title').click();
  await page.locator('#sv-parent-edit').click();
  await expect(page.locator('#single-link-name')).toHaveText('Основной & Гость — Мегахит');
  await page.locator('#single-link-input').fill('Общий');
  await page.locator('#single-link-list .combo__item').first().click();
  await page.locator('#single-link-save').click();
  await expect(page.locator('#single-link-dialog')).not.toBeVisible();
  const trackInsert = cloud.state.writes.filter((w) => w.method === 'POST' && w.path.startsWith('/rest/v1/tracks')).pop();
  expect(trackInsert?.body).toMatchObject({ album_id: ALBUM.id, title: 'Мегахит & Основной', feat_artist: 'Основной', single_id: 'single-collab' });

  // рейтинг синглов: чистые названия, полный состав исполнителей — в подписи
  await page.locator('#single-back').click();
  await page.locator('#artists-btn').click();
  await expect(page.locator('#view-srank')).toHaveClass(/is-visible/);
  const row = page.locator('#single-rank-list .rank').filter({ hasText: 'Мегахит' });
  await expect(row.locator('.rank__name')).toHaveText('Мегахит');
  await expect(row.locator('.rank__meta')).toContainText('Основной & Гость');
});

test('глаз у привязки: удержание показывает миниатюру альбома', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await cardByTitle(page, 'Первый сингл').locator('.album__title').click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);

  const peek = page.locator('#sv-parent-peek');
  await expect(peek).toBeVisible();
  // глаз стоит после «изменить» с тем же отступом, что и остальные кнопки ряда
  // (замер на широком экране — как в тесте равных отступов, без переносов)
  await page.setViewportSize({ width: 1600, height: 1000 });
  const gap = await page.evaluate(() => {
    const edit = document.querySelector('#sv-parent-edit')!.getBoundingClientRect();
    const eye = document.querySelector('#sv-parent-peek')!.getBoundingClientRect();
    return eye.left - edit.right;
  });
  expect(gap).toBeCloseTo(12, 0);
  const box = (await peek.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();                          // зажали — миниатюра видна
  await expect(page.locator('#sv-peek-card')).toBeVisible();
  await expect(page.locator('#sv-peek-title')).toHaveText('Общий альбом');
  await expect(page.locator('#sv-peek-artist')).toHaveText('Артист');
  await page.mouse.up();                            // отпустили — скрылась
  await expect(page.locator('#sv-peek-card')).toBeHidden();

  // у сингла вне альбома глаза нет
  await page.locator('#single-back').click();
  await cardByTitle(page, 'Отдельный сингл').locator('.album__title').click();
  await expect(page.locator('#sv-parent-peek')).toBeHidden();
  await expect(page.locator('#sv-peek-card')).toBeHidden();
});

test('трек-сингл и релиз делят оценку: подтверждение на альбоме видно на сингле', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await cardByTitle(page, 'Общий альбом').click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);

  // оценка, поставленная синглу, уже видна на его треке в альбоме и зафиксирована
  const row = page.locator('#track-list .track[data-id="track-one"]');
  await expect(row.locator('.track__numinput')).toHaveValue('8');
  await expect(row.locator('.track__numinput')).toBeDisabled();

  // меняем балл и подтверждаем прямо на альбоме
  await row.locator('.track__confirm-btn').click();
  await expect(row.locator('.track__numinput')).toBeEnabled();
  await row.locator('.track__numinput').fill('9.5');
  await row.locator('.track__confirm-btn').click();
  await expect(row.locator('.track__numinput')).toBeDisabled();

  // то же самое уехало в оценки сингла
  await expect.poll(() => cloud.state.singleRatings.find((r) => r.profile_id === ME.id))
    .toMatchObject({ album_id: SINGLE.id, score: 9.5, confirmed: true });

  // и на странице сингла — тот же балл с подтверждением
  await row.locator('.track__single').click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);
  await expect(page.locator('#sv-mine')).toHaveText('9.5');
  await expect(page.locator('#sv-confirm-state')).toContainText('подтверждён');
  await expect(page.locator('#sv-slider')).toBeDisabled();
});

test('оценка сингла уезжает на его трек в альбоме и фиксирует его', async ({ page }) => {
  const cloud = backend();
  cloud.state.ratings.length = 0;   // оценка стоит только у сингла
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await cardByTitle(page, 'Первый сингл').locator('.album__title').click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);

  await page.locator('#sv-confirm-btn').click();      // снять подтверждение
  await expect(page.locator('#sv-slider')).toBeEnabled();
  await page.locator('#sv-num').fill('9');
  await page.locator('#sv-confirm-btn').click();      // подтвердить заново
  await expect(page.locator('#sv-confirm-state')).toContainText('подтверждён');

  // балл и подтверждение записались и в оценки трека альбома
  await expect.poll(() => cloud.state.ratings.find((r) => r.profile_id === ME.id))
    .toMatchObject({ track_id: TRACK.id, score: 9, confirmed: true });

  // на альбоме трек показывает тот же балл, зафиксирован, и балл учтён в среднем альбома
  await page.locator('#single-back').click();
  await page.locator('#seg-albums').click();
  await cardByTitle(page, 'Общий альбом').click();
  const row = page.locator('#track-list .track[data-id="track-one"]');
  await expect(row.locator('.track__numinput')).toHaveValue('9');
  await expect(row.locator('.track__numinput')).toBeDisabled();
  // среднее альбома считает все оценки (9 — моя подтверждённая, 6 — второго участника у сингла): (9 + 6) / 2
  await expect(cardByTitle(page, 'Общий альбом').locator('.album__avg-num')).toHaveText('7.5');
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
  await expect(page.locator('#sv-origin')).toHaveText('Отмечен синглом в 1 альбоме');
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

test('подсказки появляются с анимацией, фон замирает при прокрутке', async ({ page }) => {
  const cloud = backend();
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album--add').click();
  await expect(page.locator('#view-add')).toHaveClass(/is-visible/);

  // подсказки артистов плавно появляются (анимация задана видимому списку)
  await page.locator('#artist-input').fill('Друг');
  const list = page.locator('#artist-list');
  await expect(list).toBeVisible();
  await expect(list.locator('.combo__item').first()).toContainText('Другой артист');
  expect(await list.evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');

  // пока идёт прокрутка, декоративный фон приостанавливает «дыхание»,
  // а после остановки продолжает — класс снимается сам
  await page.evaluate(() => document.querySelector('#view-add')!.dispatchEvent(new Event('scroll')));
  await expect(page.locator('.bg')).toHaveClass(/is-scrolling/);
  await expect.poll(() => page.locator('.bg').getAttribute('class')).not.toContain('is-scrolling');
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


const SECOND_ALBUM = { ...ALBUM, id: 'album-second', title: 'MUSIC' };

test('несколько альбомов: ввод через запятую, подсказка, ссылки и треки на каждом альбоме', async ({ page }) => {
  const cloud = backend();
  cloud.state.albums.push(SECOND_ALBUM);
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album--add').click();
  await page.locator('#artist-input').fill('Артист');
  await page.locator('#title-input').fill('Мульти-сингл');
  await page.locator('#year-input').fill('2025');
  await page.locator('#parent-input').fill('  Общий альбом , MUS');
  await page.locator('#parent-list .combo__item').click();
  await expect(page.locator('#parent-input')).toHaveValue('Общий альбом, MUSIC');
  await page.locator('#parent-input').fill(' Общий альбом, MUSIC, общий альбом, ');
  await page.locator('#add-submit').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  const card = cardByTitle(page, 'Мульти-сингл');
  await expect(page.locator('#albums .parent-more')).toHaveCount(0);
  await expect(card.locator('.parent-list')).toHaveCount(0);
  await card.locator('.album__title').click();
  const label = page.locator('#sv-parent-label');
  const more = label.locator('.parent-more');
  await expect(more).toHaveText('показать еще...');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(label.locator('.parent-list')).toBeHidden();
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(label.locator('.parent-list a')).toHaveText(['«MUSIC»']);
  await expect(label.locator('.sv__parent-link')).toHaveCount(2);
  await expect(label).toHaveText('сингл к альбомам «Общий альбом» и «MUSIC» скрыть');
  const insert = cloud.state.writes.find((w) => w.method === 'POST' && w.path.startsWith('/rest/v1/albums'));
  expect(insert?.body).toMatchObject({ parent_album_id: ALBUM.id, parent_album_ids: [ALBUM.id, SECOND_ALBUM.id] });
  expect(cloud.state.tracks.filter((t) => t.single_id === 'created-single').map((t) => t.album_id)).toEqual([ALBUM.id, SECOND_ALBUM.id]);
  await label.locator('.parent-list a').click();
  await expect(page.locator('#av-title')).toHaveText('MUSIC');
  await expect(page.locator('#av-singles')).toContainText('Мульти-сингл');
  await expect(page.locator('#track-list')).toContainText('Мульти-сингл');
  await page.locator('#av-singles .scard').click();
  await label.locator('.sv__parent-link').first().click();
  await expect(page.locator('#av-title')).toHaveText(ALBUM.title);
  await expect(page.locator('#av-singles')).toContainText('Мульти-сингл');
});

test('редактор нескольких привязок: ошибка без записи, сохранение, перезагрузка и отвязка', async ({ page }) => {
  const cloud = backend();
  cloud.state.albums.push(SECOND_ALBUM);
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await cardByTitle(page, SINGLE.title).locator('.album__title').click();
  await page.locator('#sv-parent-edit').click();
  await page.locator('#single-link-input').fill('Общий альбом, несуществующий');
  await page.locator('#single-link-save').click();
  await expect(page.locator('#single-link-error')).toContainText('не найден');
  expect(cloud.state.writes.filter((w) => w.path.startsWith('/rest/v1/albums'))).toEqual([]);
  await page.locator('#single-link-input').fill('Общий альбом, MUSIC');
  await page.locator('#single-link-save').click();
  await expect(page.locator('#single-link-dialog')).not.toBeVisible();
  await expect(page.locator('#sv-parent-label .parent-more')).toBeVisible();
  await page.reload();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await page.locator('#seg-singles').click();
  await cardByTitle(page, SINGLE.title).locator('.album__title').click();
  await page.locator('#sv-parent-edit').click();
  await expect(page.locator('#single-link-input')).toHaveValue('Общий альбом, MUSIC');
  await page.locator('#single-link-input').fill('MUSIC');
  await page.locator('#single-link-save').click();
  await expect(page.locator('#single-link-dialog')).not.toBeVisible();
  await expect(page.locator('#sv-parent-label')).toHaveText('сингл к альбому «MUSIC»');
  await expect(page.locator('#sv-parent-label .parent-more')).toHaveCount(0);
  await page.locator('#sv-parent-edit').click();
  await page.locator('#single-link-input').fill('');
  await page.locator('#single-link-save').click();
  await expect(page.locator('#sv-parent-label')).toHaveText('сингл вне альбома');
  const patches = cloud.state.writes.filter((w) => w.method === 'PATCH' && w.path.startsWith('/rest/v1/albums'));
  expect(patches.map((w) => w.body)).toEqual([
    { parent_album_id: ALBUM.id, parent_album_ids: [ALBUM.id, SECOND_ALBUM.id] },
    { parent_album_id: SECOND_ALBUM.id, parent_album_ids: [SECOND_ALBUM.id] },
    { parent_album_id: null, parent_album_ids: [] },
  ]);
});

test('название с запятой и одинаковые названия: точный выбор из подсказок', async ({ page }) => {
  const cloud = backend();
  cloud.state.albums.push({ ...SECOND_ALBUM, title: 'Hello, World' }, { ...ALBUM, id: 'duplicate-title', artist: 'Другой' });
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await cardByTitle(page, SOLO.title).locator('.album__title').click();
  await page.locator('#sv-parent-edit').click();
  await page.locator('#single-link-input').fill('Общий альбом');
  await page.locator('#single-link-save').click();
  await expect(page.locator('#single-link-error')).toContainText('неоднозначно');
  await page.locator('#single-link-input').fill('Hello');
  await page.locator('#single-link-list .combo__item').click();
  await expect(page.locator('#single-link-input')).toHaveValue('"Hello, World"');
  await page.locator('#single-link-input').fill('"Hello, World", Общий');
  await page.locator('#single-link-list .combo__item').filter({ hasText: 'Другой' }).click();
  await page.locator('#single-link-save').click();
  await expect(page.locator('#single-link-dialog')).not.toBeVisible();
  const patch = cloud.state.writes.find((w) => w.method === 'PATCH' && w.path.startsWith('/rest/v1/albums'));
  expect(patch?.body).toMatchObject({ parent_album_ids: [SECOND_ALBUM.id, 'duplicate-title'] });
});

test('правка оценки трека-сингла синхронизирует трек второго альбома', async ({ page }) => {
  const cloud = backend();
  cloud.state.albums.push(SECOND_ALBUM);
  Object.assign(cloud.state.albums[1], { parent_album_ids: [ALBUM.id, SECOND_ALBUM.id] });
  cloud.state.tracks.push({ ...TRACK, id: 'track-on-second', album_id: SECOND_ALBUM.id });
  await cloud.install(page);
  await login(page);
  await cardByTitle(page, ALBUM.title).locator('.album__title').click();
  const row = page.locator('#track-list .track').first();
  await row.locator('.track__confirm-btn').click();
  // Подтверждение/снятие подтверждения распространяется на обе копии трека.
  await expect.poll(() => cloud.state.ratings.find((r) => r.track_id === 'track-on-second' && r.profile_id === ME.id)?.confirmed).toBe(false);
});


test('дополнительные альбомы раскрываются в строку: запятые и «и» перед последним, без повторов', async ({ page }) => {
  const cloud = backend();
  const third = { ...ALBUM, id: 'third-album', title: 'Третий альбом' };
  cloud.state.albums.push(SECOND_ALBUM, third);
  Object.assign(cloud.state.albums[1], { parent_album_ids: [ALBUM.id, SECOND_ALBUM.id, third.id] });
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await expect(page.locator('#albums .parent-more')).toHaveCount(0);
  await cardByTitle(page, SINGLE.title).locator('.album__title').click();
  const label = page.locator('#sv-parent-label');
  const more = label.locator('.parent-more');
  await expect(label.locator('.parent-disclosure')).toHaveCSS('display', 'inline');
  await expect(label.locator('.sv__parent-link:visible')).toHaveText(['«Общий альбом»']);
  await more.click();
  await expect(label.locator('.parent-list')).toHaveCSS('display', 'inline');
  await expect(label.locator('.parent-list')).toHaveText(', «MUSIC» и «Третий альбом»');
  await expect(label.locator('.sv__parent-link:visible')).toHaveText(['«Общий альбом»', '«MUSIC»', '«Третий альбом»']);
  await expect(label).toHaveText('сингл к альбомам «Общий альбом», «MUSIC» и «Третий альбом» скрыть');
  await more.click();
  await expect(more).toHaveText('показать еще...');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(label.locator('.parent-list')).toBeHidden();
  await more.click();
  await label.locator('.parent-list a').last().click();
  await expect(page.locator('#av-title')).toHaveText(third.title);
});


for (const count of [0, 1, 2, 5, 11, 21, 22, 101, 111]) {
  test(`подпись метки: ${count} альбомов, правильное склонение и отсутствие дублей`, async ({ page }) => {
    const cloud = backend();
    cloud.state.tracks = [];
    for (let i = 0; i < count; i++) {
      const album = { ...ALBUM, id: `origin-album-${i}`, title: `Альбом ${i}` };
      cloud.state.albums.push(album);
      // Две метки в одном альбоме считаются как один альбом.
      cloud.state.tracks.push({ ...TRACK, id: `origin-track-${i}`, album_id: album.id });
      cloud.state.tracks.push({ ...TRACK, id: `origin-track-duplicate-${i}`, album_id: album.id });
    }
    await cloud.install(page);
    await login(page);
    await page.locator('#seg-singles').click();
    await cardByTitle(page, SINGLE.title).locator('.album__title').click();
    if (!count) await expect(page.locator('#sv-origin')).toBeHidden();
    else await expect(page.locator('#sv-origin')).toHaveText(`Отмечен синглом в ${count} ${[1, 21, 101].includes(count) ? 'альбоме' : 'альбомах'}`);
  });
}

test('равные отступы, анимация раскрытия и быстрые повторные нажатия', async ({ page }) => {
  const cloud = backend();
  cloud.state.albums[0].title = 'A';
  cloud.state.albums.push(SECOND_ALBUM);
  Object.assign(cloud.state.albums[1], { parent_album_ids: [ALBUM.id, SECOND_ALBUM.id] });
  await cloud.install(page);
  await login(page);
  await page.locator('#seg-singles').click();
  await cardByTitle(page, SINGLE.title).locator('.album__title').click();
  const more = page.locator('#sv-parent-label .parent-more');
  const list = page.locator('#sv-parent-label .parent-list');
  // На достаточно широком экране оба промежутка равны 12px.
  await page.setViewportSize({ width: 1600, height: 1000 });
  const spacing = await page.evaluate(() => {
    const first = document.querySelector('#sv-parent-label > .sv__parent-link')!.getBoundingClientRect();
    const more = document.querySelector('#sv-parent-label .parent-more')!.getBoundingClientRect();
    const edit = document.querySelector('#sv-parent-edit')!.getBoundingClientRect();
    return [more.left - first.right, edit.left - more.right];
  });
  expect(spacing[0]).toBeCloseTo(12, 0);
  expect(spacing[1]).toBeCloseTo(12, 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Обработчик запускает настоящую анимацию opacity на встроенном span.
  const opening = await more.evaluate((el: HTMLButtonElement) => {
    el.click();
    return document.querySelector('#sv-parent-label .parent-list')!.getAnimations().length;
  });
  expect(opening).toBeGreaterThan(0);
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toBeVisible();
  await more.evaluate((el: HTMLButtonElement) => { el.click(); el.click(); el.click(); });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
  await expect(more).toHaveText('показать еще...');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedAnimations = await more.evaluate((el: HTMLButtonElement) => {
    el.click();
    return document.querySelector('#sv-parent-label .parent-list')!.getAnimations().length;
  });
  expect(reducedAnimations).toBe(0);
  await expect(list).toBeVisible();
});
