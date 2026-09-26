import { expect, test, type Page } from '@playwright/test';

/* Поиск обложек онлайн (iTunes + Deezer). Настоящие API не вызываются:
   JSONP-запросы перехватываются и подменяются фикстурами, как и картинки CDN.
   Всё остальное (внешние адреса) блокируется — как в остальных спеках. */

const EMAIL = 'killmiplag@demo.local';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#b7a8ef"/></svg>';

const album = {
  id: 'existing-album', artist: 'Артист', title: 'Альбом без обложки', year: 2025,
  cover: '', tracksLocked: true, cohesion: 2, albumType: 'album',
  kind: 'album', parentId: null,
};
const track = { id: 'track-1', albumId: album.id, title: 'Первый трек', position: 0, locked: true, featArtist: null, singleId: null };

/* --- фикстуры платформ --- */
const itunesResults = [1, 2, 3, 4, 5, 6].map((i) => ({
  collectionName: `Издание ${i}`,
  releaseDate: `20${10 + i}-03-01T00:00:00Z`,
  artworkUrl100: `https://cdn.example.test/itunes/rel${i}/100x100bb.jpg`,
}));
const itunesData = { resultCount: itunesResults.length, results: itunesResults };

const deezerData = {
  total: 6,
  data: [1, 2, 3, 4, 5, 6].map((i) => ({
    id: 100 + i,
    title: `Релиз ${i}`,
    artist: { id: 7, name: 'Артист' },
    cover_medium: `https://cdn.example.test/deezer/rel${i}/medium.jpg`,
    cover_xl: `https://cdn.example.test/deezer/rel${i}/xl.jpg`,
  })),
};

const geniusData = {
  meta: { status: 200 },
  response: {
    hits: [
      // тип artist должен отфильтроваться: берём только арты треков
      { type: 'artist', result: { id: 42, name: 'Артист', image_url: 'https://cdn.example.test/genius/artist/300x300x1.jpg' } },
      ...[1, 2, 3, 4, 5, 6].map((i) => ({
        type: 'song',
        result: {
          id: 500 + i,
          title: `Трек ${i}`,
          primary_artist: { id: 9, name: 'Артист' },
          song_art_image_thumbnail_url: `https://cdn.example.test/genius/rel${i}/300x300x1.jpg`,
          song_art_image_url: `https://cdn.example.test/genius/rel${i}/1000x1000x1.jpg`,
        },
      })),
    ],
  },
};

const itunesBig = (i: number) => `https://cdn.example.test/itunes/rel${i}/600x600bb.jpg`;
const deezerXl = (i: number) => `https://cdn.example.test/deezer/rel${i}/xl.jpg`;
const geniusBig = (i: number) => `https://cdn.example.test/genius/rel${i}/1000x1000x1.jpg`;

const pageErrors = new WeakMap<Page, string[]>();

// чтение буфера обмена в тесте «копирование отчёта» (Chromium требует разрешения)
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

async function baseMocks(page: Page, cloud = false): Promise<{ queries: string[] }> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  const queries: string[] = [];
  // всё внешнее — блокируется; ниже точечные подмены перебивают этот обработчик
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:8080') return route.continue();
    return route.abort();
  });
  await page.route('**/config.js*', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.APP_CONFIG = ${JSON.stringify({
      supabaseUrl: cloud ? 'https://cover-search-cloud.supabase.co' : '',
      supabaseAnonKey: cloud ? 'sb_publishable_test-only' : '',
      allowedUsers: [{ email: EMAIL, username: 'Участник', initials: 'У', admin: false }],
      demoPassword: 'demo',
    })};`,
  }));
  // JSONP iTunes: отвечаем скриптом, вызывающим колбэк из параметра callback
  await page.route(/itunes\.apple\.com\/search/, (route) => {
    const url = new URL(route.request().url());
    queries.push(`itunes:${url.searchParams.get('term') ?? ''}`);
    const callback = url.searchParams.get('callback') ?? 'noop';
    const country = url.searchParams.get('country');
    expect(country).toBe('US');
    return route.fulfill({ contentType: 'application/javascript', body: `${callback}(${JSON.stringify(itunesData)});` });
  });
  // JSONP Deezer: требует output=jsonp
  await page.route(/api\.deezer\.com\/search\/album/, (route) => {
    const url = new URL(route.request().url());
    queries.push(`deezer:${url.searchParams.get('q') ?? ''}`);
    expect(url.searchParams.get('output')).toBe('jsonp');
    const callback = url.searchParams.get('callback') ?? 'noop';
    return route.fulfill({ contentType: 'application/javascript', body: `${callback}(${JSON.stringify(deezerData)});` });
  });
  // Genius через серверный прокси /api/genius/search (токен живёт на сервере)
  await page.route(/\/api\/genius\/search/, (route) => {
    const url = new URL(route.request().url());
    queries.push(`genius:${url.searchParams.get('q') ?? ''}`);
    return route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify(geniusData),
    });
  });
  // картинки CDN: и миниатюры, и полные размеры
  await page.route(/cdn\.example\.test/, (route) => route.fulfill({ contentType: 'image/svg+xml', body: svg }));
  return { queries };
}

async function login(page: Page): Promise<void> {
  await page.locator('#email-input').fill(EMAIL);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}

async function seedDemo(page: Page): Promise<void> {
  await page.addInitScript(({ album, track }) => {
    if (localStorage.getItem('albums_local_v1')) return;
    localStorage.setItem('albums_local_v1', JSON.stringify([
      { ...album }, { ...album, id: 'other-album', title: 'Другой альбом', cover: 'covers/music.jpg' },
    ]));
    localStorage.setItem('tracks_local_v1', JSON.stringify([track]));
    localStorage.setItem('track_ratings_local_v1', JSON.stringify({}));
  }, { album, track });
}

async function openAlbumFromHome(page: Page): Promise<void> {
  await page.locator('#albums .album__title').filter({ hasText: album.title }).click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
}

async function openCoverEditor(page: Page): Promise<void> {
  await page.locator('#av-cover-edit').click();
  await expect(page.locator('#album-cover-dialog')).toBeVisible();
}

async function openEditor(page: Page): Promise<void> {
  await openAlbumFromHome(page);
  await openCoverEditor(page);
}

test('форма добавления: авто-поиск показывает все платформы, выбор подставляет обложку и сохраняется', async ({ page }) => {
  const { queries } = await baseMocks(page);
  await page.goto('/');
  await login(page);
  await page.locator('#albums .album--add').click();
  await expect(page.locator('#view-add')).toHaveClass(/is-visible/);

  // пока артист и название не заполнены — секция свёрнута и пуста
  await expect(page.locator('#cover-search')).not.toHaveClass(/is-open/);
  await expect(page.locator('#cover-search-sections')).toBeEmpty();

  await page.locator('#artist-input').fill('Артист');
  await page.locator('#title-input').fill('Новый альбом');

  // авто-поиск: секция раскрывается сама; порядок — Deezer, Genius, iTunes
  const sections = page.locator('#cover-search-sections .cover-search__section');
  await expect(page.locator('#cover-search')).toHaveClass(/is-open/);
  await expect(sections).toHaveCount(3);
  await expect(sections.nth(0)).toHaveAttribute('data-provider', 'deezer');
  await expect(sections.nth(1)).toHaveAttribute('data-provider', 'genius');
  await expect(sections.nth(2)).toHaveAttribute('data-provider', 'itunes');
  const itunes = page.locator('#cover-search-sections .cover-search__section[data-provider="itunes"]');
  const deezer = page.locator('#cover-search-sections .cover-search__section[data-provider="deezer"]');
  const genius = page.locator('#cover-search-sections .cover-search__section[data-provider="genius"]');
  await expect(itunes.locator('.cover-search__state')).toHaveText('6 вариантов');
  await expect(deezer.locator('.cover-search__state')).toHaveText('6 вариантов');
  await expect(genius.locator('.cover-search__state')).toHaveText('6 вариантов');
  await expect(itunes.locator('.cover-search__card')).toHaveCount(6);
  await expect(deezer.locator('.cover-search__card')).toHaveCount(6);
  await expect(genius.locator('.cover-search__card')).toHaveCount(6);
  // точность запроса: артист + название, без лишних пробелов; регион US и
  // поход через прокси уже проверены в маршрутах
  await expect.poll(() => queries).toEqual(expect.arrayContaining([
    'deezer:Артист Новый альбом',
    'genius:Артист Новый альбом',
    'itunes:Артист Новый альбом',
  ]));

  // все платформы подключены — примечание о резерве скрыто
  await expect(page.locator('#cover-search-note')).toBeHidden();

  // выбор первого варианта iTunes: миниатюра и поле ссылки получают полный размер 600x600
  await itunes.locator('.cover-search__card').first().click();
  await expect(itunes.locator('.cover-search__card').first()).toHaveClass(/is-selected/);
  await expect(page.locator('#cover-img')).toHaveAttribute('src', itunesBig(1));
  await expect(page.locator('#cover-url')).toHaveValue(itunesBig(1));

  // обложка сохраняется штатной кнопкой формы
  await page.locator('#year-input').fill('2025');
  await page.locator('#add-submit').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  const added = await page.evaluate(() => JSON.parse(localStorage.getItem('albums_local_v1')!)
    .find((a: { artist: string; title: string }) => a.artist === 'Артист' && a.title === 'Новый альбом'));
  expect(added.cover).toBe(itunesBig(1));
});

test('форма добавления: запрос можно отредактировать и перезапустить, Enter не отправляет форму', async ({ page }) => {
  const { queries } = await baseMocks(page);
  await page.goto('/');
  await login(page);
  await page.locator('#albums .album--add').click();
  await page.locator('#artist-input').fill('Артист');
  await page.locator('#title-input').fill('Название');
  await expect(page.locator('#cover-search-sections .cover-search__card').first()).toBeVisible();
  await expect.poll(() => queries.filter((q0) => q0.startsWith('itunes:'))).toHaveLength(1);

  // ручная правка запускает повторный поиск (debounce), Enter — не сабмитит форму
  await page.locator('#cover-search-query').fill('Другой запрос');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-add')).toHaveClass(/is-visible/); // форма не отправилась
  await expect.poll(() => queries.filter((q0) => q0.startsWith('itunes:'))).toHaveLength(2);
  expect(queries.filter((q0) => q0.startsWith('itunes:')).at(-1)).toBe('itunes:Другой запрос');

  // кнопка «искать» перезапускает текущий запрос
  await page.locator('#cover-search-run').click();
  await expect.poll(() => queries.filter((q0) => q0.startsWith('itunes:'))).toHaveLength(3);
});

test('форма добавления: очистка запроса не восстанавливает текст, ручной выбор файла сбрасывает выбор варианта', async ({ page }) => {
  const { queries } = await baseMocks(page);
  await page.goto('/');
  await login(page);
  await page.locator('#albums .album--add').click();
  await page.locator('#artist-input').fill('Артист');
  await page.locator('#title-input').fill('Название');
  const itunes = page.locator('#cover-search-sections .cover-search__section[data-provider="itunes"]');
  await itunes.locator('.cover-search__card').first().click();
  await expect(page.locator('#cover-url')).toHaveValue(itunesBig(1));

  // выбор файла вручную — подсветка варианта снимается, файл становится источником
  await page.locator('#cover-file').setInputFiles({
    name: 'cover.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg),
  });
  await expect(itunes.locator('.cover-search__card').first()).not.toHaveClass(/is-selected/);
  await expect(page.locator('#cover-img')).not.toHaveAttribute('src', itunesBig(1));
  // поле ссылки очищено выбором файла — как у обычного потока
  await expect(page.locator('#cover-url')).toHaveValue('');

  // очистка поля: текст не восстанавливается мгновенно и новый поиск не запускается
  await page.locator('#cover-search-query').fill('');
  await expect(page.locator('#cover-search-query')).toHaveValue('');
  await expect.poll(() => queries.length).toBe(3); // по-прежнему только первый поиск

  // вписали свой запрос — он ищется
  await page.locator('#cover-search-query').fill('Другой запрос');
  await expect.poll(() => queries).toEqual(expect.arrayContaining(['itunes:Другой запрос']));

  // после очистки следующее изменение артиста/названия снова подставляет авто-запрос
  await page.locator('#cover-search-query').fill('');
  await page.locator('#title-input').fill('Другое название');
  await expect(page.locator('#cover-search-query')).toHaveValue('Артист Другое название');
  await expect.poll(() => queries).toEqual(expect.arrayContaining(['itunes:Артист Другое название']));
});

test('окно обложки: авто-поиск по артисту и названию, запрос можно очистить и переписать, выбор сохраняется', async ({ page }) => {
  const { queries } = await baseMocks(page);
  await seedDemo(page);
  await page.goto('/');
  await login(page);
  await openEditor(page);

  // авто-поиск: запрос из артиста и названия релиза, секция раскрыта
  const sections = page.locator('#album-cover-search-sections .cover-search__section');
  await expect(page.locator('#album-cover-search')).toHaveClass(/is-open/);
  await expect(sections).toHaveCount(3);
  await expect(sections.nth(0)).toHaveAttribute('data-provider', 'deezer');
  await expect(sections.nth(1)).toHaveAttribute('data-provider', 'genius');
  await expect.poll(() => queries).toEqual(expect.arrayContaining([
    'deezer:Артист Альбом без обложки',
    'genius:Артист Альбом без обложки',
    'itunes:Артист Альбом без обложки',
  ]));

  // поле запроса можно очистить — мгновенного восстановления нет — и вписать свой
  const query = page.locator('#album-cover-search-query');
  await query.fill('');
  await expect(query).toHaveValue('');
  await query.fill('Кино Группа крови');
  await expect.poll(() => queries).toEqual(expect.arrayContaining(['itunes:Кино Группа крови']));
  await expect(sections).toHaveCount(3); // секции пересобраны под новый запрос

  // выбор варианта Deezer: предпросмотр и поле ссылки обновились, «сохранить» доступна
  const deezer = page.locator('#album-cover-search-sections .cover-search__section[data-provider="deezer"]');
  await deezer.locator('.cover-search__card').first().click();
  await expect(deezer.locator('.cover-search__card').first()).toHaveClass(/is-selected/);
  await expect(page.locator('#album-cover-preview')).toHaveAttribute('src', deezerXl(1));
  await expect(page.locator('#album-cover-url')).toHaveValue(deezerXl(1));
  await expect(page.locator('#album-cover-save')).toBeEnabled();

  await page.locator('#album-cover-save').click();
  await expect(page.locator('#album-cover-dialog')).not.toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('albums_local_v1')!)[0]);
  expect(saved.cover).toBe(deezerXl(1));
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', deezerXl(1));
});

test('ошибка платформы: статус, детали и копирование отчёта в буфер обмена', async ({ page }) => {
  await baseMocks(page);
  // Deezer падает (перебиваем подмену более поздним обработчиком-блокировщиком), iTunes отвечает
  await page.route(/api\.deezer\.com\/search\/album/, (route) => route.abort());
  await page.goto('/');
  await login(page);
  await page.locator('#albums .album--add').click();
  await page.locator('#artist-input').fill('Артист');
  await page.locator('#title-input').fill('Название');

  const deezer = page.locator('#cover-search-sections .cover-search__section[data-provider="deezer"]');
  await expect(deezer.locator('.cover-search__state')).toHaveText('ошибка · network');
  await expect(deezer.locator('.cover-search__fail-toggle')).toBeVisible();
  // iTunes нашёл варианты — секция раскрылась сама, у Deezer вместо сетки ошибка
  await expect(page.locator('#cover-search')).toHaveClass(/is-open/);
  await expect(deezer.locator('.cover-search__grid')).toBeHidden();

  await deezer.locator('.cover-search__fail-toggle').click();
  const report = deezer.locator('.cover-search__report');
  await expect(report).toBeVisible();
  await expect(report).toContainText('платформа: Deezer');
  await expect(report).toContainText('этап: network');
  await expect(report).toContainText('url запроса: https://api.deezer.com/search/album?');
  await expect(deezer.locator('.cover-search__fail-toggle')).toHaveText('скрыть детали');

  await deezer.locator('.cover-search__copy').click();
  await expect(page.locator('.toast')).toContainText('Отчёт скопирован');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('Поиск обложки — отчёт об ошибке');
  expect(clipboard).toContain('платформа: Deezer');
  expect(clipboard).toContain('сборка: app.js?v=');

  await deezer.locator('.cover-search__fail-toggle').click();
  await expect(report).toBeHidden();
  // остальные платформы при этом работают как обычно
  await expect(page.locator('#cover-search-sections .cover-search__section[data-provider="itunes"] .cover-search__state'))
    .toHaveText('6 вариантов');
  await expect(page.locator('#cover-search-sections .cover-search__section[data-provider="genius"] .cover-search__state'))
    .toHaveText('6 вариантов');
});

test('все платформы недоступны: секции с ошибками, выбор файла по-прежнему работает', async ({ page }) => {
  await baseMocks(page);
  // заблокировать все три (перебиваем точечные подмены более поздними обработчиками)
  await page.route(/itunes\.apple\.com\/search/, (route) => route.abort());
  await page.route(/api\.deezer\.com\/search\/album/, (route) => route.abort());
  await page.route(/\/api\/genius\/search/, (route) => route.abort());
  await page.goto('/');
  await login(page);
  await page.locator('#albums .album--add').click();
  await page.locator('#artist-input').fill('Артист');
  await page.locator('#title-input').fill('Название');

  const sections = page.locator('#cover-search-sections .cover-search__section');
  await expect(sections).toHaveCount(3);
  await expect(page.locator('#cover-search-sections .cover-search__section[data-provider="itunes"] .cover-search__state')).toHaveText('ошибка · network', { timeout: 5000 });
  await expect(page.locator('#cover-search-sections .cover-search__section[data-provider="deezer"] .cover-search__state')).toHaveText('ошибка · network');
  await expect(page.locator('#cover-search-sections .cover-search__section[data-provider="genius"] .cover-search__state')).toHaveText('ошибка · network');
  await expect(page.locator('#cover-search')).not.toHaveClass(/is-open/); // раскрывать нечего

  await page.locator('#cover-search-toggle').click();
  await expect(page.locator('#cover-search-sections .cover-search__section[data-provider="itunes"] .cover-search__fail-toggle').first()).toBeVisible();

  // файл по-прежнему можно выбрать и сохранить релиз
  await page.locator('#cover-file').setInputFiles({ name: 'cover.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await page.locator('#year-input').fill('2025');
  await page.locator('#add-submit').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  const added = await page.evaluate(() => JSON.parse(localStorage.getItem('albums_local_v1')!)
    .find((a: { artist: string; title: string }) => a.artist === 'Артист' && a.title === 'Название'));
  expect(added.cover).toMatch(/^data:image\/jpeg;base64,/);
});

test('облако: выбор из поиска сохраняется ссылкой напрямую в albums.cover_url, без загрузки в Storage', async ({ page }) => {
  const { queries } = await baseMocks(page, true);
  const profile = { id: '11111111-1111-4111-8111-111111111111', username: 'Участник', initials: 'У', avatar_url: null };
  const user = { id: profile.id, email: EMAIL, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2025-01-01T00:00:00Z' };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: user.id, exp, role: 'authenticated' })).toString('base64url'), 'test-signature',
  ].join('.');
  const cloudOrigin = 'https://cover-search-cloud.supabase.co';
  const state = {
    album: { id: album.id, artist: album.artist, title: album.title, year: album.year, cover_url: 'covers/blonde.jpg', tracks_locked: true, cohesion: 2, album_type: 'album' },
    uploads: [] as string[],
    writes: [] as { table: string; method: string; body: Record<string, unknown>; id: string | null }[],
  };
  await page.routeWebSocket('wss://cover-search-cloud.supabase.co/**', (socket) => {
    socket.onMessage((raw) => {
      const [joinRef, ref, topic] = JSON.parse(String(raw)) as [number, number, string];
      socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }]));
    });
  });
  await page.route(`${cloudOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/auth/v1/token') return json({ access_token: jwt, refresh_token: 'test-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: exp, user });
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname.startsWith('/storage/v1/object/covers/')) {
      state.uploads.push(url.pathname);
      return json({ Key: url.pathname });
    }
    const table = url.pathname.split('/').pop()!;
    if (request.method() !== 'GET') {
      state.writes.push({ table, method: request.method(), body: request.postDataJSON(), id: url.searchParams.get('id') });
      Object.assign(state.album, request.postDataJSON());
      return json({ id: state.album.id });
    }
    if (table === 'profiles') return json([profile]);
    if (table === 'albums') return json([state.album]);
    if (table === 'tracks' || table === 'ratings' || table === 'single_ratings') return json([]);
    throw new Error(`Unexpected test request: ${request.method()} ${url}`);
  });

  await page.goto('/');
  await page.locator('#email-input').fill(EMAIL);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await openEditor(page);

  const itunes = page.locator('#album-cover-search-sections .cover-search__section[data-provider="itunes"]');
  await expect(itunes.locator('.cover-search__card').first()).toBeVisible();
  await expect.poll(() => queries).toEqual(expect.arrayContaining([
    'deezer:Артист Альбом без обложки',
    'genius:Артист Альбом без обложки',
    'itunes:Артист Альбом без обложки',
  ]));
  await itunes.locator('.cover-search__card').first().click();
  await expect(page.locator('#album-cover-save')).toBeEnabled();
  await page.locator('#album-cover-save').click();
  await expect(page.locator('#album-cover-dialog')).not.toBeVisible();

  expect(state.uploads).toEqual([]); // ссылка сохраняется как есть, файл в Storage не копируется
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toEqual({ table: 'albums', method: 'PATCH', id: `eq.${album.id}`, body: { cover_url: itunesBig(1) } });
});

test('переоткрытие окна: прошлые результаты и выбор сброшены, поиск запускается заново', async ({ page }) => {
  const { queries } = await baseMocks(page);
  await seedDemo(page);
  await page.goto('/');
  await login(page);
  await openEditor(page);
  const itunes = page.locator('#album-cover-search-sections .cover-search__section[data-provider="itunes"]');
  await itunes.locator('.cover-search__card').first().click();
  await expect(page.locator('#album-cover-save')).toBeEnabled();
  await page.locator('#album-cover-cancel').click();
  await expect(page.locator('#album-cover-dialog')).not.toBeVisible();

  await openCoverEditor(page); // мы по-прежнему на странице альбома
  await expect.poll(() => queries.filter((q0) => q0.startsWith('itunes:'))).toHaveLength(2); // поиск запустился снова
  const dialogSections = page.locator('#album-cover-search-sections .cover-search__section[data-provider="itunes"]');
  await expect(dialogSections.locator('.cover-search__card.is-selected')).toHaveCount(0);
  await expect(page.locator('#album-cover-url')).toHaveValue('');
  await expect(page.locator('#album-cover-save')).toBeDisabled();
});
