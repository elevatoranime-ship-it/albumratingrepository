import { expect, test, type Page } from '@playwright/test';

/* Тексты песен Genius: значок у трека альбома + панель под списком,
   «пластинка» на сингле (вращение при поиске, посимвольный текст),
   запоминание выбранной песни (демо — localStorage, облако — PATCH).
   Прокси /api/genius/* подменяется фикстурами — настоящий Genius не вызывается. */

const EMAIL = 'killmiplag@demo.local';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#b7a8ef"/></svg>';

const LYRICS_TEXT = 'Раз\nДва\nТри\nТри\nТри';

const album = {
  id: 'existing-album', artist: 'Артист', title: 'Альбом без обложки', year: 2025,
  cover: '', tracksLocked: true, cohesion: 2, albumType: 'album',
  kind: 'album', parentId: null,
};
const track = { id: 'track-1', albumId: album.id, title: 'Первый трек', position: 0, locked: true, featArtist: null, singleId: null, geniusId: null };

const single = {
  id: 'single-one', artist: 'Другой артист', title: 'Отдельный сингл', year: 2024,
  cover: '', tracksLocked: false, cohesion: null, albumType: null,
  kind: 'single', parentId: null,
};

/* фикстуры поиска: точное совпадение + слабые кандидаты */
const searchFixture = {
  response: {
    hits: [
      { type: 'song', result: { id: 9001, title: 'Первый трек', url: 'https://genius.com/artist-first-track-lyrics', lyrics_state: 'complete', primary_artist: { name: 'Артист' } } },
      { type: 'song', result: { id: 9002, title: 'Другая песня', url: 'https://genius.com/artist-other-song-lyrics', lyrics_state: 'complete', primary_artist: { name: 'Артист' } } },
      { type: 'artist', result: { id: 1, name: 'Артист' } },
    ],
  },
};
const weakSearchFixture = {
  response: {
    hits: [
      { type: 'song', result: { id: 9002, title: 'Совсем другое', url: 'https://genius.com/x-lyrics', lyrics_state: 'complete', primary_artist: { name: 'Никто' } } },
    ],
  },
};
const lyricsFixture = (id: number, title: string, artist: string) => ({
  song: { id, title, artist, url: `https://genius.com/song-${id}`, lyrics_state: 'complete', text: LYRICS_TEXT },
});

const pageErrors = new WeakMap<Page, string[]>();
const queries = new WeakMap<Page, string[]>();

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

interface GeniusOptions {
  search?: 'exact' | 'weak';
  lyricsFail?: boolean;
}

async function base(page: Page, opts: GeniusOptions = {}): Promise<void> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  const q: string[] = [];
  queries.set(page, q);
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:8080') return route.continue();
    return route.abort();
  });
  await page.route('**/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.APP_CONFIG = ${JSON.stringify({
      supabaseUrl: '',
      supabaseAnonKey: '',
      allowedUsers: [{ email: EMAIL, username: 'Участник', initials: 'У', admin: false }],
      demoPassword: 'demo',
    })};`,
  }));
  await page.route('**/api/genius/search**', (route) => {
    const url = new URL(route.request().url());
    q.push(`search:${url.searchParams.get('q') ?? ''}`);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(opts.search === 'weak' ? weakSearchFixture : searchFixture),
    });
  });
  await page.route('**/api/genius/lyrics**', (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get('id');
    q.push(`lyrics:${id}`);
    if (opts.lyricsFail) {
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'страница Genius ответила 503' }) });
    }
    const songs: Record<string, { title: string; artist: string }> = {
      9001: { title: 'Первый трек', artist: 'Артист' },
      9002: { title: 'Другая песня', artist: 'Артист' },
      777: { title: 'Запомненная', artist: 'Артист' },
      9100: { title: 'Отдельный сингл', artist: 'Другой артист' },
    };
    const song = songs[id ?? ''] ?? { title: 'Песня', artist: 'Кто-то' };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(lyricsFixture(Number(id), song.title, song.artist)) });
  });
}

async function seedDemo(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript(({ album, track, single, extra }) => {
    if (localStorage.getItem('albums_local_v1')) return;
    localStorage.setItem('albums_local_v1', JSON.stringify([
      { ...album }, { ...single, ...extra },
    ]));
    localStorage.setItem('tracks_local_v1', JSON.stringify([track]));
    localStorage.setItem('track_ratings_local_v1', JSON.stringify({}));
    localStorage.setItem('single_ratings_local_v1', JSON.stringify({}));
  }, { album, track, single, extra });
}

async function login(page: Page): Promise<void> {
  await page.locator('#email-input').fill(EMAIL);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}

test('альбом: значок желтеет, панель с текстом раскрывается, уверенное совпадение запоминается', async ({ page }) => {
  await base(page);
  await seedDemo(page);
  await page.goto('/');
  await login(page);
  await page.locator('#albums .album__title').filter({ hasText: album.title }).click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);

  const btn = page.locator('[data-tid="track-1"] .track__genius');
  await expect(btn).not.toHaveClass(/is-on/); // ещё не выбрано
  await btn.click();

  // точный запрос: чистое название без скобок, основной артист
  await expect.poll(() => queries.get(page)!.some((x) => x === 'search:Артист Первый трек')).toBe(true);
  // панель раскрылась, текст получен
  const panel = page.locator('#lyrics-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/is-open/);
  await expect(btn).toHaveClass(/is-active/);
  await expect(page.locator('#lyrics-song')).toHaveText('Первый трек');
  await expect(page.locator('#lyrics-artist')).toHaveText('Артист');
  const text = page.locator('#lyrics-text');
  await expect(text).toBeVisible();
  await expect(text).toContainText('Раз');
  await expect(page.locator('#lyrics-link')).toHaveAttribute('href', 'https://genius.com/song-9001');
  await expect(queries.get(page)!).toContain('lyrics:9001');

  // уверенное совпадение запомнено в базе (демо — localStorage)
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tracks_local_v1')!)[0]);
  expect(stored.geniusId).toBe('9001');

  // повторный клик закрывает панель
  await btn.click();
  await expect(panel).toBeHidden();
});

test('альбом: запомненная песня открывается сразу, ошибка прокси — отчёт и копирование', async ({ page }) => {
  await base(page, { lyricsFail: true });
  await seedDemo(page, { geniusId: 777 });
  // трек тоже с запомненной песней
  await page.addInitScript(() => {
    const tracks = JSON.parse(localStorage.getItem('tracks_local_v1')!);
    tracks[0] = { ...tracks[0], geniusId: '777' };
    localStorage.setItem('tracks_local_v1', JSON.stringify(tracks));
  });
  await page.goto('/');
  await login(page);
  await page.locator('#albums .album__title').filter({ hasText: album.title }).click();

  const btn = page.locator('[data-tid="track-1"] .track__genius');
  await expect(btn).toHaveClass(/is-on/); // песня уже выбрана
  await btn.click();

  // поиск не нужен — сразу текст, но прокси отвечает ошибкой
  await expect(queries.get(page)!).not.toContain('search:Артист Первый трек');
  await expect(queries.get(page)!).toContain('lyrics:777');
  await expect(page.locator('#lyrics-state')).toContainText('не получилось');
  await expect(page.locator('#lyrics-fail-toggle')).toBeVisible();

  await page.locator('#lyrics-fail-toggle').click();
  const report = page.locator('#lyrics-report');
  await expect(report).toBeVisible();
  await expect(report).toContainText('Текст песни — отчёт об ошибке');
  await expect(report).toContainText('этап: network');
  await expect(page.locator('#lyrics-copy')).toBeVisible();

  await page.locator('#lyrics-copy').click();
  await expect(page.locator('.toast')).toContainText('Отчёт скопирован');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('платформа: Genius');
  expect(clipboard).toContain('искали: «Артист Первый трек»');
});

test('альбом: слабые совпадения — форма «не тот текст», участник подставляет локально', async ({ page }) => {
  await base(page, { search: 'weak' });
  await seedDemo(page);
  await page.goto('/');
  await login(page);
  await page.locator('#albums .album__title').filter({ hasText: album.title }).click();
  await page.locator('[data-tid="track-1"] .track__genius').click();

  await expect(page.locator('#lyrics-state')).toContainText('не уверены');
  const fix = page.locator('#lyrics-fix');
  await expect(fix).toBeVisible();
  await expect(page.locator('.lyrics__cand')).toHaveCount(1);
  await expect(page.locator('#lyrics-fix-note')).toContainText('только админ');

  // участник (не админ) выбирает кандидата — текст показывается, в базу не пишется
  await page.locator('.lyrics__cand').first().click();
  const text = page.locator('#lyrics-text');
  await expect(text).toBeVisible();
  await expect(text).toContainText('Раз');
  await expect(fix).toBeHidden();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tracks_local_v1')!)[0]);
  expect(stored.geniusId).toBeNull();
});

test('сингл: пластинка ищет при входе, диск вращается, текст печатается, песня запоминается', async ({ page }) => {
  await base(page);
  await seedDemo(page);
  await page.goto('/');
  await login(page);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album__title').filter({ hasText: single.title }).click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);

  // секция видна, диск ищет, запрос точный
  const section = page.locator('#vinyl-section');
  await expect(section).toBeVisible();
  await expect(page.locator('#vinyl-disc')).toHaveClass(/is-searching/);
  await expect.poll(() => queries.get(page)!.some((x) => x === 'search:Другой артист Отдельный сингл')).toBe(true);

  // песня найдена: значок жёлтый, шторка открыта, текст напечатался целиком
  const pin = page.locator('#vinyl-pin');
  await expect(pin).toHaveClass(/is-active/);
  await expect(page.locator('#vinyl-clip')).toHaveClass(/is-open/);
  const text = page.locator('#vinyl-text');
  await expect(text).toBeVisible();
  await expect(text).toHaveText(LYRICS_TEXT); // посимвольная печать завершилась
  await expect(page.locator('#vinyl-link')).toHaveAttribute('href', 'https://genius.com/song-9100');

  // пин погибается в базу (демо — localStorage альбомов)
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('albums_local_v1')!).find((a: { id: string }) => a.id === single.id));
  expect(stored.geniusId).toBe('9100');

  // повторное открытие — мгновенно из кэша сеанса, без поиска
  await page.locator('#single-back').click();
  await page.locator('#albums .album__title').filter({ hasText: single.title }).click();
  const before = (queries.get(page)!).length;
  await expect(text).toBeVisible();
  await expect(queries.get(page)!.length).toBe(before); // всё из кэша
});

test('сингл: ручная подстановка по ссылке, админ запоминает в облаке', async ({ page }) => {
  // облако: админ в системе
  const cloudOrigin = 'https://genius-lyrics-test.supabase.co';
  const adminEmail = 'elevator@demo.local';
  const profile = { id: '11111111-1111-4111-8111-111111111111', username: 'Elevator', initials: 'E', avatar_url: null };
  const user = { id: profile.id, email: adminEmail, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2025-01-01T00:00:00Z' };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: user.id, exp, role: 'authenticated' })).toString('base64url'), 'test-signature',
  ].join('.');
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  const q: string[] = [];
  queries.set(page, q);
  const writes: Array<{ table: string; body: Record<string, unknown>; id: string | null }> = [];
  const state = {
    album: { id: single.id, artist: single.artist, title: single.title, year: single.year, cover_url: 'covers/blonde.jpg', tracks_locked: false, cohesion: null, album_type: null, kind: 'single', parent_album_id: null, genius_song_id: null },
  };
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:8080') return route.continue();
    return route.abort();
  });
  await page.route('**/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.APP_CONFIG = ${JSON.stringify({
      supabaseUrl: cloudOrigin,
      supabaseAnonKey: 'sb_publishable_test-only',
      allowedUsers: [{ email: adminEmail, username: 'Elevator', initials: 'E', admin: true }],
      demoPassword: 'demo',
    })};`,
  }));
  await page.routeWebSocket(`wss://genius-lyrics-test.supabase.co/**`, (socket) => {
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
    const table = url.pathname.split('/').pop()!;
    if (request.method() !== 'GET') {
      writes.push({ table, body: request.postDataJSON(), id: url.searchParams.get('id') });
      Object.assign(state.album, request.postDataJSON());
      return json({ id: state.album.id });
    }
    if (table === 'profiles') return json([profile]);
    if (table === 'albums') return json([state.album]);
    if (table === 'tracks' || table === 'ratings' || table === 'single_ratings') return json([]);
    throw new Error(`Unexpected test request: ${request.method()} ${url}`);
  });
  // Genius: поиск не даёт точного совпадения, lyrics работает
  await page.route('**/api/genius/search**', (route) => {
    const url = new URL(route.request().url());
    q.push(`search:${url.searchParams.get('q') ?? ''}`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(weakSearchFixture) });
  });
  await page.route('**/api/genius/lyrics**', (route) => {
    const url = new URL(route.request().url());
    q.push(`lyrics:${url.searchParams.get('id')}`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(lyricsFixture(9100, 'Отдельный сингл', 'Другой артист')) });
  });

  await page.goto('/');
  await page.locator('#email-input').fill(adminEmail);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album__title').filter({ hasText: single.title }).click();

  // неуверенный поиск → форма; админ вставляет ссылку со страницы песни
  await expect(page.locator('#vinyl-fix')).toBeVisible();
  await expect(page.locator('#vinyl-replace-btn')).toBeVisible(); // админ видит кнопку замены
  await page.locator('#vinyl-url').fill('https://genius.com/other-artist-otdelnyy-singl-lyrics'); // id не в конце — ошибка
  await page.locator('#vinyl-fix-save').click();
  await expect(page.locator('#vinyl-url-error')).toContainText('нужна ссылка');

  await page.locator('#vinyl-url').fill('https://genius.com/other-artist-otdelnyy-singl-9100-lyrics');
  await page.locator('#vinyl-fix-save').click();
  const text = page.locator('#vinyl-text');
  await expect(text).toBeVisible();
  await expect(text).toContainText('Раз');

  // админская замена запомнена в базе
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual({ table: 'albums', body: { genius_song_id: 9100 }, id: `eq.${single.id}` });
});
