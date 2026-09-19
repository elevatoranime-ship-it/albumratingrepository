import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const ORIGIN = 'https://ratings-sync-test.supabase.co';
const USERS = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'first@demo.local', username: 'Первый', initials: 'П', avatar_url: null },
  { id: '22222222-2222-4222-8222-222222222222', email: 'second@demo.local', username: 'Второй', initials: 'В', avatar_url: null },
];
const ALBUM = { id: 'album-one', title: 'Совместный альбом', artist: 'Артист', year: 2025, cover_url: '', tracks_locked: false, cohesion: null, album_type: 'album' };
const TRACK = { id: 'track-one', album_id: ALBUM.id, title: 'Первый трек', position: 0, locked: false, feat_artist: null };
type Row = { track_id: string; profile_id: string; score: number; confirmed: boolean };
const pageErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function backend() {
  const state = {
    albums: [{ ...ALBUM }], tracks: [{ ...TRACK }],
    ratings: [
      { track_id: TRACK.id, profile_id: USERS[0].id, score: 4, confirmed: false },
      { track_id: TRACK.id, profile_id: USERS[1].id, score: 6, confirmed: true },
    ] as Row[],
    reads: 0, ratingReads: 0, activeReads: 0, maxActiveReads: 0, joins: 0, writes: [] as Row[], activeWrites: 0, maxActiveWrites: 0,
    failReads: false, failWrites: false, broadcast: true,
    nextRead: null as Promise<void> | null,
    nextWrite: null as Promise<void> | null,
    sockets: new Set<{ route: WebSocketRoute; ref: string; bindings: Array<{ id: number; table: string }> }>(),
  };
  const notify = (table = 'ratings', type = 'UPDATE') => {
    if (!state.broadcast) return;
    for (const socket of state.sockets) {
      socket.route.send(JSON.stringify([
        socket.ref, null, 'realtime:db-changes', 'postgres_changes',
        { ids: [socket.bindings.find((b) => b.table === table)!.id], data: { schema: 'public', table, type, record: {}, old_record: {}, columns: [] } },
      ]));
    }
  };
  const peer = (score: number | null, confirmed = true) => {
    state.ratings = state.ratings.filter((r) => r.profile_id !== USERS[1].id);
    if (score !== null) state.ratings.push({ track_id: TRACK.id, profile_id: USERS[1].id, score, confirmed });
    notify('ratings', score === null ? 'DELETE' : 'UPDATE');
  };
  const install = async (page: Page) => {
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on('pageerror', (error) => errors.push(error.message));
    // Никаких запросов в настоящую базу: разрешён только локальный сайт и mock ниже.
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === 'http://127.0.0.1:8080') return route.continue();
      return route.abort();
    });
        await page.route('**/api/genius/**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"genius off in tests"}' }));
    await page.route('**/config.js', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: `window.APP_CONFIG = ${JSON.stringify({
        supabaseUrl: ORIGIN, supabaseAnonKey: 'sb_publishable_mock-only',
        allowedUsers: USERS.map((u) => ({ ...u, admin: false })),
      })};`,
    }));
    await page.routeWebSocket('wss://ratings-sync-test.supabase.co/**', (route) => {
      let socket: typeof state.sockets extends Set<infer T> ? T : never;
      route.onMessage((raw) => {
        const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
        if (event === 'phx_join') {
          state.joins += 1;
          const bindings = payload.config.postgres_changes.map((b: object, i: number) => ({ ...b, id: i + 1 }));
          socket = { route, ref: joinRef, bindings };
          state.sockets.add(socket);
          route.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: bindings } }]));
        } else if (event === 'phx_leave') {
          state.sockets.delete(socket);
          route.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
        } else if (event === 'heartbeat') {
          route.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
        }
      });
      route.onClose(() => state.sockets.delete(socket));
    });
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' };
      const json = (body: unknown, status = 200) => route.fulfill({ headers, status, contentType: 'application/json', body: JSON.stringify(body) });
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.pathname === '/auth/v1/logout') return json({});
      if (url.pathname === '/auth/v1/token') {
        const account = USERS.find((u) => u.email === request.postDataJSON().email) ?? USERS[0];
        const user = { ...account, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2025-01-01T00:00:00Z' };
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const jwt = [
          Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
          Buffer.from(JSON.stringify({ sub: user.id, exp, role: 'authenticated' })).toString('base64url'), 'test-signature',
        ].join('.');
        return json({ access_token: jwt, refresh_token: 'test-refresh', token_type: 'bearer', expires_at: exp, expires_in: 3600, user });
      }
      const table = url.pathname.split('/').pop();
      if (request.method() === 'GET') {
        state.reads += 1;
        if (state.failReads) return json({ message: 'temporarily unavailable' }, 503);
        if (table === 'profiles') return json(url.searchParams.has('id') ? USERS.filter((u) => `eq.${u.id}` === url.searchParams.get('id')) : USERS);
        if (table === 'albums') return json(state.albums);
        if (table === 'tracks') return json(state.tracks);
        if (table === 'single_ratings') return json([]); // синглов в этих сценариях нет
        if (table === 'ratings') {
          state.ratingReads += 1;
          state.activeReads += 1;
          state.maxActiveReads = Math.max(state.maxActiveReads, state.activeReads);
          const snapshot = structuredClone(state.ratings);
          const hold = state.nextRead;
          state.nextRead = null;
          if (hold) await hold;
          state.activeReads -= 1;
          return json(snapshot);
        }
      } else if (table === 'ratings') {
        const row: Row = request.method() === 'DELETE'
          ? { track_id: url.searchParams.get('track_id')!.slice(3), profile_id: url.searchParams.get('profile_id')!.slice(3), score: 0, confirmed: false }
          : request.postDataJSON();
        state.writes.push(row);
        state.activeWrites += 1;
        state.maxActiveWrites = Math.max(state.maxActiveWrites, state.activeWrites);
        const hold = state.nextWrite;
        state.nextWrite = null;
        if (hold) await hold;
        state.activeWrites -= 1;
        if (state.failWrites) return json({ code: '42501', message: 'rating write denied' }, 403);
        state.ratings = state.ratings.filter((r) => !(r.track_id === row.track_id && r.profile_id === row.profile_id));
        if (request.method() !== 'DELETE') state.ratings.push(row);
        notify();
        return json(null);
      }
      throw new Error(`Unexpected mock request: ${request.method()} ${url}`);
    });
    return errors;
  };
  return { state, notify, peer, install };
}

async function login(page: Page, email = USERS[0].email) {
  await page.locator('#email-input').fill(email);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}
async function openAlbum(page: Page) {
  await page.locator('#albums .album__title').first().click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
}
async function start(page: Page, cloud = backend()) {
  const errors = await cloud.install(page);
  await page.goto('/');
  await login(page);
  await openAlbum(page);
  return { ...cloud, errors };
}
const mine = (page: Page) => page.locator('#track-list .track__numinput').first();
const avg = (page: Page) => page.locator('#av-avg');

test('two participants see scores and confirmations without reload or losing keyboard focus', async ({ page, browser }) => {
  const cloud = await start(page);
  const other = await browser.newPage({ baseURL: 'http://127.0.0.1:8080', reducedMotion: 'reduce', viewport: page.viewportSize()! });
  try {
    const otherErrors = await cloud.install(other);
    await other.goto('/');
    await login(other, USERS[1].email);
    await openAlbum(other);
    await other.locator('#track-list .track__confirm-btn').click(); // снять подтверждение второй оценки
    await mine(page).fill('8');
    const input = await mine(page).elementHandle();
    await mine(other).fill('9');
    await other.locator('#track-list .track__confirm-btn').click();
    await expect(avg(page)).toHaveText('8.5');
    await expect(avg(other)).toHaveText('8.5');
    await expect(page.locator('#track-list .track__peer-val')).toHaveText('9');
    await expect(mine(page)).toBeFocused();
    await expect(mine(page)).toHaveValue('8');
    expect(await input!.evaluate((el) => el.isConnected)).toBe(true);
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
    expect(cloud.errors).toEqual([]);
    expect(otherErrors).toEqual([]);
  } finally { await other.close(); }
});

test('peer updates patch averages during a held slider gesture without replacing it', async ({ page }) => {
  const cloud = await start(page);
  const slider = page.locator('#track-list .track__slider');
  const handle = await slider.elementHandle();
  await slider.dispatchEvent('pointerdown', { pointerId: 1 });
  await slider.evaluate((el: HTMLInputElement) => { el.value = '7'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  cloud.peer(9);
  await expect(avg(page)).toHaveText('8');
  await expect(slider).toHaveValue('7');
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
  await page.dispatchEvent('body', 'pointercancel');
  cloud.peer(null);
  await expect(avg(page)).toHaveText('7');
  await expect(page.locator('#track-list .track__peer')).toHaveCount(0);
});

test('rapid edits serialize writes and immediate confirmation cannot be undone by the debounce', async ({ page }) => {
  const cloud = await start(page);
  const write = deferred();
  cloud.state.nextWrite = write.promise;
  await mine(page).fill('7');
  await expect.poll(() => cloud.state.writes.length).toBe(1);
  await mine(page).fill('9');
  await page.locator('#track-list .track__confirm-btn').click();
  write.resolve();
  await expect(page.locator('#track-list .track__save')).toHaveText('сохранено');
  await expect(mine(page)).toBeDisabled();
  expect(cloud.state.maxActiveWrites).toBe(1);
  expect(cloud.state.ratings.find((r) => r.profile_id === USERS[0].id)).toMatchObject({ score: 9, confirmed: true });
  expect(cloud.state.writes.at(-1)).toMatchObject({ score: 9, confirmed: true });
  cloud.peer(8);
  await expect(avg(page)).toHaveText('8.5');
});

test('missed Realtime events are recovered by the five-second fallback', async ({ page }) => {
  const cloud = await start(page);
  cloud.state.broadcast = false;
  cloud.peer(10);
  await expect(avg(page)).toHaveText('7', { timeout: 8000 });
  await expect(page.locator('#track-list .track__peer-val')).toHaveText('10');
});

test('home, artist profile and rankings update while they are open', async ({ page }) => {
  const cloud = await start(page);
  await page.locator('#album-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  cloud.peer(8);
  await expect(page.locator('#albums .album__avg-num').first()).toHaveText('6');
  await page.locator('#albums .album__artist-link').first().click();
  await expect(page.locator('#view-artist')).toHaveClass(/is-visible/);
  cloud.peer(10);
  // В рейтингах (в том числе у артиста) учитываются только подтверждённые оценки:
  // моя оценка 4 не подтверждена, поэтому балл артиста — это оценка второго участника.
  await expect(page.locator('#artist-score')).toHaveText('10');
  await page.locator('#artist-back').click();
  await page.locator('#artists-btn').click();
  await page.locator('#rank-menu-list .rank-menu__item[data-rank="artists"]').click();
  await expect(page.locator('#view-rank')).toHaveClass(/is-visible/);
  cloud.peer(6);
  await expect(page.locator('#artist-rank-list .rank__score')).toHaveText('6');
});

test('transient read errors do not clear data; coming online refreshes immediately', async ({ page }) => {
  const cloud = await start(page);
  cloud.state.failReads = true;
  const reads = cloud.state.reads;
  cloud.peer(10);
  await expect.poll(() => cloud.state.reads).toBeGreaterThan(reads);
  await expect(avg(page)).toHaveText('5');
  await expect(mine(page)).toHaveValue('4');
  cloud.state.failReads = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(avg(page)).toHaveText('7');
});

test('failed saves show an error, retain the draft, and retry after reconnecting', async ({ page }) => {
  const cloud = await start(page);
  cloud.state.failWrites = true;
  await mine(page).fill('8');
  await expect(page.locator('#track-list .track__save')).toHaveText('ошибка');
  cloud.peer(10);
  await expect(avg(page)).toHaveText('9');
  await expect(mine(page)).toHaveValue('8');
  expect(cloud.state.ratings.find((r) => r.profile_id === USERS[0].id)?.score).toBe(4);
  cloud.state.failWrites = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#track-list .track__save')).toHaveText('сохранено');
  expect(cloud.state.ratings.find((r) => r.profile_id === USERS[0].id)?.score).toBe(8);
});

test('background tabs stop polling, then catch up immediately when visible', async ({ page }) => {
  await page.clock.install();
  const cloud = await start(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  cloud.state.broadcast = false;
  cloud.peer(8);
  const reads = cloud.state.reads;
  await page.clock.runFor(12000);
  expect(cloud.state.reads).toBe(reads);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(avg(page)).toHaveText('6');
});

test('logout stops polling and a second login creates a fresh subscription', async ({ page }) => {
  await page.clock.install();
  const cloud = await start(page);
  await page.locator('#album-back').click();
  await page.locator('#logout-btn').click();
  await expect(page.locator('#view-login')).toHaveClass(/is-visible/);
  const reads = cloud.state.reads;
  await page.clock.runFor(12000);
  expect(cloud.state.reads).toBe(reads);
  await login(page, USERS[1].email);
  await openAlbum(page);
  await expect.poll(() => cloud.state.joins).toBe(2);
  await expect(mine(page)).toHaveValue('6');
  cloud.state.ratings[0].score = 10;
  cloud.notify();
  await expect(avg(page)).toHaveText('8');
});

test('rating events preserve a track rename draft', async ({ page }) => {
  const cloud = await start(page);
  await page.locator('[data-act="rename"]').click();
  const input = page.locator('#track-list .track__rename-input');
  await input.fill('Название ещё редактируется');
  const handle = await input.elementHandle();
  cloud.peer(9);
  await expect(avg(page)).toHaveText('6.5');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Название ещё редактируется');
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
});


test('unconfirmed peer ratings affect averages but their badges stay hidden', async ({ page }) => {
  const cloud = await start(page);
  cloud.peer(10, false);
  await expect(avg(page)).toHaveText('7');
  await expect(page.locator('#track-list .track__peer')).toHaveCount(0);
  cloud.peer(10, true);
  await expect(page.locator('#track-list .track__peer-val')).toHaveText('10');
  await page.locator('#track-list .track__confirm-btn').click();
  await expect(page.locator('#av-confirm-state')).toHaveClass(/is-final/);
  cloud.peer(10, false);
  await expect(page.locator('#av-confirm-state')).not.toHaveClass(/is-final/);
});

test('clearing an own score stays cleared while its DELETE is in flight', async ({ page }) => {
  const cloud = await start(page);
  const write = deferred();
  cloud.state.nextWrite = write.promise;
  await mine(page).fill('');
  await expect.poll(() => cloud.state.writes.length).toBe(1);
  cloud.peer(10);
  await expect(avg(page)).toHaveText('10');
  await expect(mine(page)).toHaveValue('');
  await expect(page.locator('#track-list .track__confirm-btn')).toBeDisabled();
  write.resolve();
  await expect(page.locator('#track-list .track__save')).toHaveText('сохранено');
  expect(cloud.state.ratings.some((r) => r.profile_id === USERS[0].id)).toBe(false);
});

test('confirmation failure restores editing instead of falsely displaying success', async ({ page }) => {
  const cloud = await start(page);
  cloud.state.failWrites = true;
  await page.locator('#track-list .track__confirm-btn').click();
  await expect(page.locator('#track-list .track__save')).toHaveText('ошибка');
  await expect(mine(page)).toBeEnabled();
  await expect(page.locator('#av-confirm-state')).not.toHaveClass(/is-final/);
  expect(cloud.state.ratings.find((r) => r.profile_id === USERS[0].id)?.confirmed).toBe(false);
});

test('event bursts coalesce and a change received during a read is not dropped', async ({ page }) => {
  const cloud = await start(page);
  const read = deferred();
  cloud.state.nextRead = read.promise;
  for (let i = 0; i < 30; i += 1) cloud.notify();
  await expect.poll(() => cloud.state.nextRead === null).toBe(true);
  cloud.peer(8);
  read.resolve();
  await expect(avg(page)).toHaveText('6');
  expect(cloud.state.maxActiveReads).toBe(1);
});

test('a reconnect refreshes data even without any subsequent database event', async ({ page }) => {
  const cloud = await start(page);
  cloud.state.broadcast = false;
  cloud.peer(10);
  await expect.poll(() => cloud.state.sockets.size).toBe(1);
  [...cloud.state.sockets][0].route.close({ code: 1012, reason: 'test restart' });
  await expect.poll(() => cloud.state.joins, { timeout: 10000 }).toBeGreaterThan(1);
  await expect(avg(page)).toHaveText('7');
  cloud.state.broadcast = true;
  cloud.peer(8);
  await expect(avg(page)).toHaveText('6');
});

test('track structure updates wait for editing to finish; ratings do not', async ({ page }) => {
  const cloud = await start(page);
  await mine(page).fill('7.50');
  const handle = await mine(page).elementHandle();
  cloud.state.tracks.push({ ...TRACK, id: 'track-two', title: 'Новый трек', position: 1 });
  cloud.notify('tracks');
  cloud.peer(8.5);
  await expect(avg(page)).toHaveText('8');
  await expect(page.locator('#track-list .track')).toHaveCount(1);
  await expect(mine(page)).toHaveValue('7.50');
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
  await mine(page).blur();
  await expect(page.locator('#track-list .track')).toHaveCount(2);
  await expect(mine(page)).toHaveValue('7.5');
});

test('updating ratings does not scroll or recreate the track list', async ({ page }) => {
  const cloud = backend();
  for (let i = 1; i < 25; i += 1) cloud.state.tracks.push({ ...TRACK, id: `track-${i}`, title: `Трек ${i}`, position: i });
  await start(page, cloud);
  const input = page.locator('#track-list .track__numinput').nth(12);
  await input.focus();
  await input.fill('8');
  const top = await page.locator('#view-album').evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  const handle = await input.elementHandle();
  cloud.peer(10);
  await expect(page.locator('#track-list .track__peer-val')).toHaveText('10');
  expect(await page.locator('#view-album').evaluate((el) => el.scrollTop)).toBe(top);
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
  await expect(input).toBeFocused();
});

