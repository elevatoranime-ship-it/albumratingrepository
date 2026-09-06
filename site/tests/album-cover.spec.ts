import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const EMAIL = 'killmiplag@demo.local'; // обычный участник, не администратор
const album = {
  id: 'existing-album', artist: 'Артист', title: 'Альбом без обложки', year: 2025,
  cover: '', tracksLocked: true, cohesion: 2, albumType: 'album',
};
const track = { id: 'track-1', albumId: album.id, title: 'Первый трек', position: 0, locked: true, featArtist: null };
const ratings = { [track.id]: { [EMAIL]: { score: 8.75, confirmed: true } } };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200"><rect width="1800" height="1200" fill="#b7a8ef"/></svg>';
const imageFile = { name: 'cover.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) };
const cloudOrigin = 'https://album-cover-tests.supabase.co';
const pageErrors = new WeakMap<Page, string[]>();

// Тесты не обращаются к настоящему Supabase или внешним изображениям.
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:8080') return route.continue();
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function config(page: Page, cloud = false): Promise<void> {
  await page.route('**/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.APP_CONFIG = ${JSON.stringify({
      supabaseUrl: cloud ? cloudOrigin : '',
      supabaseAnonKey: cloud ? 'sb_publishable_test-only' : '',
      allowedUsers: [{ email: EMAIL, username: 'Участник', initials: 'У', admin: false }],
      demoPassword: 'demo',
    })};`,
  }));
}

async function login(page: Page): Promise<void> {
  await page.locator('#email-input').fill(EMAIL);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}

async function demo(page: Page, cover = ''): Promise<void> {
  await config(page);
  await page.addInitScript(({ album, track, ratings, cover }) => {
    if (localStorage.getItem('albums_local_v1')) return;
    localStorage.setItem('albums_local_v1', JSON.stringify([
      { ...album, cover }, { ...album, id: 'other-album', title: 'Другой альбом', cover: 'covers/music.jpg' },
    ]));
    localStorage.setItem('tracks_local_v1', JSON.stringify([track]));
    localStorage.setItem('track_ratings_local_v1', JSON.stringify(ratings));
  }, { album, track, ratings, cover });
  await page.goto('/');
  await login(page);
}

async function openAlbum(page: Page, title = album.title): Promise<void> {
  await page.locator('#albums .album__title').filter({ hasText: title }).click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
}

async function openEditor(page: Page): Promise<void> {
  await page.locator('#av-cover-edit').click();
  await expect(page.locator('#album-cover-dialog')).toBeVisible();
  await expect(page.locator('#album-cover-save')).toBeDisabled();
}

async function pickFile(page: Page): Promise<void> {
  await page.locator('#album-cover-file').setInputFiles(imageFile);
  await expect(page.locator('#album-cover-save')).toBeEnabled();
}

async function save(page: Page): Promise<void> {
  await page.locator('#album-cover-save').click();
  await expect(page.locator('#album-cover-dialog')).not.toBeVisible();
}

async function storedAlbum(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('albums_local_v1')!)[0]);
}

async function imageUrl(page: Page, url = 'https://images.example.test/cover.png'): Promise<string> {
  await page.route(url, (route) => route.fulfill({ contentType: 'image/svg+xml', body: svg }));
  return url;
}

test('file cover persists without changing tracks, ratings or final album choices', async ({ page }) => {
  await demo(page);
  await openAlbum(page);
  await expect(page.locator('#av-cover-edit')).toHaveText('добавить обложку');
  await openEditor(page);
  await pickFile(page);
  await expect(page.locator('#album-cover-preview')).toHaveJSProperty('naturalWidth', 900);
  await expect(page.locator('#album-cover-preview')).toHaveJSProperty('naturalHeight', 600);
  expect((await storedAlbum(page)).cover).toBe('');
  await save(page);
  const saved = await storedAlbum(page);
  expect(saved.cover).toMatch(/^data:image\/jpeg;base64,/);
  expect({ ...saved, cover: '' }).toEqual(album);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tracks_local_v1')!))).toEqual([track]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('track_ratings_local_v1')!))).toEqual(ratings);
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', saved.cover);
  await expect(page.locator('#av-cover-edit')).toHaveText('изменить обложку');
  await page.locator('#album-back').click();
  await expect(page.locator('#albums .album__cover img').first()).toHaveAttribute('src', saved.cover);
  await page.locator('#albums .album__artist-link').first().click();
  await expect(page.locator('#artist-own .album__cover img').first()).toHaveAttribute('src', saved.cover);
  await page.locator('#artist-back').click();
  await page.locator('#artists-btn').click();
  await expect(page.locator('#artist-rank-list img').first()).toHaveAttribute('src', saved.cover);
  await page.reload();
  await login(page);
  await openAlbum(page);
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', saved.cover);
});

test('an album created without a cover can receive one later', async ({ page }) => {
  await demo(page);
  await page.locator('.album--add').click();
  await page.locator('#artist-input').fill('Новый артист');
  await page.locator('#title-input').fill('Новый альбом');
  await page.locator('#year-input').fill('2025');
  await page.locator('#add-submit').click();
  await openAlbum(page, 'Новый альбом');
  await openEditor(page);
  await pickFile(page);
  await save(page);
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', /^data:image\/jpeg/);
});

test('a URL replaces the existing cover only after saving', async ({ page }) => {
  await demo(page, 'covers/blonde.jpg');
  await openAlbum(page);
  await openEditor(page);
  const url = await imageUrl(page);
  await page.locator('#album-cover-url').fill(url);
  await expect(page.locator('#album-cover-save')).toBeEnabled();
  await expect(page.locator('#album-cover-preview')).toHaveAttribute('src', url);
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', 'covers/blonde.jpg');
  await save(page);
  expect((await storedAlbum(page)).cover).toBe(url);
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', url);
});

test('cancel and Escape discard the draft and restore focus without leaving the album', async ({ page }) => {
  await demo(page, 'covers/blonde.jpg');
  await openAlbum(page);
  await openEditor(page);
  await expect(page.locator('#album-cover-pick')).toBeFocused();
  await pickFile(page);
  await page.locator('#album-cover-cancel').click();
  await expect(page.locator('#av-cover-edit')).toBeFocused();
  expect((await storedAlbum(page)).cover).toBe('covers/blonde.jpg');
  await openEditor(page);
  await expect(page.locator('#album-cover-preview')).toHaveAttribute('src', 'covers/blonde.jpg');
  await expect(page.locator('#album-cover-pick')).toBeFocused();
  await page.locator('#album-back').focus(); // фон нативного диалога inert
  await expect(page.locator('#album-cover-pick')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#album-cover-url')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#album-cover-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#album-cover-dialog')).not.toBeVisible();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
  await expect(page.locator('#av-cover-edit')).toBeFocused();
});

test.describe('cover dialog motion', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('opening interpolates the dialog and backdrop instead of showing them instantly', async ({ page }) => {
    await demo(page);
    await openAlbum(page);
    const motion = await page.locator('#av-cover-edit').evaluate((button) => {
      button.click();
      const dialog = document.querySelector<HTMLDialogElement>('#album-cover-dialog')!;
      const animations = dialog.getAnimations({ subtree: true })
        .filter((animation) => (animation.effect as KeyframeEffect)?.target === dialog);
      const snapshot = () => ({
        opacity: Number(getComputedStyle(dialog).opacity),
        backdrop: Number(getComputedStyle(dialog, '::backdrop').opacity),
        transform: getComputedStyle(dialog).transform,
      });
      animations.forEach((animation) => { animation.pause(); animation.currentTime = 0; });
      const start = snapshot();
      animations.forEach((animation) => {
        animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2;
      });
      const middle = snapshot();
      animations.forEach((animation) => animation.finish());
      return { count: animations.length, start, middle, end: snapshot() };
    });
    expect(motion.count).toBeGreaterThanOrEqual(2);
    for (const property of ['opacity', 'backdrop'] as const) {
      expect(motion.start[property]).toBe(0);
      expect(motion.middle[property]).toBeGreaterThan(0);
      expect(motion.middle[property]).toBeLessThan(1);
      expect(motion.end[property]).toBe(1);
    }
    expect(motion.start.transform).not.toBe(motion.middle.transform);
    expect(motion.middle.transform).not.toBe(motion.end.transform);
    await expect(page.locator('#album-cover-dialog')).toBeVisible();
    await expect(page.locator('#album-cover-pick')).toBeFocused();
  });

  test('closing preserves the preview until fading ends and safely restores focus', async ({ page }) => {
    await demo(page, 'covers/blonde.jpg');
    await openAlbum(page);
    await openEditor(page);
    await pickFile(page);
    const preview = await page.locator('#album-cover-preview').getAttribute('src');
    const motion = await page.locator('#album-cover-cancel').evaluate(async (button) => {
      const dialog = document.querySelector<HTMLDialogElement>('#album-cover-dialog')!;
      const dialogAnimations = () => dialog.getAnimations({ subtree: true })
        .filter((animation) => (animation.effect as KeyframeEffect)?.target === dialog);
      await Promise.allSettled(dialogAnimations().map((animation) => animation.finished));
      button.click();
      const animations = dialogAnimations();
      animations.forEach((animation) => {
        animation.pause();
        animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2;
      });
      return { open: dialog.open, count: animations.length, opacity: Number(getComputedStyle(dialog).opacity) };
    });
    expect(motion.open).toBe(true);
    expect(motion.count).toBeGreaterThan(0);
    expect(motion.opacity).toBeGreaterThan(0);
    expect(motion.opacity).toBeLessThan(1);
    await expect(page.locator('#album-cover-preview')).toHaveAttribute('src', preview!);
    await expect(page.locator('#album-cover-save')).toBeDisabled();
    await page.keyboard.press('Escape'); // повторное закрытие не запускает навигацию
    await expect(page.locator('#album-cover-dialog')).toHaveJSProperty('open', true);
    await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
    await page.locator('#album-cover-dialog').evaluate((dialog) => {
      dialog.getAnimations({ subtree: true })
        .filter((animation) => (animation.effect as KeyframeEffect)?.target === dialog)
        .forEach((animation) => animation.finish());
    });
    await expect(page.locator('#album-cover-dialog')).not.toBeVisible();
    await expect(page.locator('#av-cover-edit')).toBeFocused();
    expect((await storedAlbum(page)).cover).toBe('covers/blonde.jpg');
    await openEditor(page);
    await expect(page.locator('#album-cover-preview')).toHaveAttribute('src', 'covers/blonde.jpg');
  });
});

test('reduced motion closes the dialog without an animation delay', async ({ page }) => {
  await demo(page);
  await openAlbum(page);
  await openEditor(page);
  const result = await page.locator('#album-cover-cancel').evaluate((button) => {
    const dialog = document.querySelector<HTMLDialogElement>('#album-cover-dialog')!;
    const durations = [getComputedStyle(dialog), getComputedStyle(dialog, '::backdrop')]
      .flatMap((style) => style.transitionDuration.split(',').map(parseFloat));
    button.click();
    return { durations, open: dialog.open };
  });
  expect(result.durations.every((duration) => duration <= 0.001)).toBe(true);
  expect(result.open).toBe(false);
  await expect(page.locator('#av-cover-edit')).toBeFocused();
});

for (const invalid of [
  { name: 'not an image', file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }, error: 'Нужен файл изображения' },
  { name: 'corrupt image', file: { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') }, error: 'Не удалось прочитать' },
  { name: 'oversize image', file: { name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }, error: 'Максимум — 10 МБ' },
]) {
  test(`rejects ${invalid.name} and allows selecting the same valid file again`, async ({ page }) => {
    await demo(page);
    await openAlbum(page);
    await openEditor(page);
    await pickFile(page);
    await page.locator('#album-cover-file').setInputFiles(invalid.file);
    await expect(page.locator('#album-cover-error')).toContainText(invalid.error);
    await expect(page.locator('#album-cover-save')).toBeDisabled();
    expect((await storedAlbum(page)).cover).toBe('');
    await pickFile(page);
    await save(page);
  });
}

test('rejects unsafe and broken URLs; clearing a valid URL clears the draft', async ({ page }) => {
  await demo(page);
  await openAlbum(page);
  await openEditor(page);
  await page.locator('#album-cover-url').fill('javascript:alert(1)');
  await expect(page.locator('#album-cover-error')).toContainText('Нужна прямая ссылка');
  await expect(page.locator('#album-cover-save')).toBeDisabled();
  await page.locator('#album-cover-url').fill('https://images.example.test/missing.jpg');
  await expect(page.locator('#album-cover-error')).toContainText('Не удалось загрузить');
  const url = await imageUrl(page);
  await page.locator('#album-cover-url').fill(url);
  await expect(page.locator('#album-cover-save')).toBeEnabled();
  await page.locator('#album-cover-url').fill('');
  await expect(page.locator('#album-cover-save')).toBeDisabled();
});

test('a slow URL cannot overwrite a newer file selection', async ({ page }) => {
  await demo(page);
  await openAlbum(page);
  await openEditor(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const url = 'https://images.example.test/slow.jpg';
  await page.route(url, async (route) => {
    await pending;
    await route.fulfill({ contentType: 'image/svg+xml', body: svg });
  });
  const requested = page.waitForRequest(url);
  await page.locator('#album-cover-url').fill(url);
  await requested;
  await expect(page.locator('#album-cover-save')).toBeDisabled();
  await pickFile(page);
  const response = page.waitForResponse(url);
  release();
  await response;
  await save(page);
  expect((await storedAlbum(page)).cover).toMatch(/^data:image\/jpeg/);
});

test('a cancelled URL cannot leak into another album', async ({ page }) => {
  await demo(page);
  await openAlbum(page);
  await openEditor(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const url = 'https://images.example.test/cancelled.jpg';
  await page.route(url, async (route) => {
    await pending;
    await route.fulfill({ contentType: 'image/svg+xml', body: svg });
  });
  const requested = page.waitForRequest(url);
  await page.locator('#album-cover-url').fill(url);
  await requested;
  await page.locator('#album-cover-cancel').click();
  await page.locator('#album-back').click();
  await openAlbum(page, 'Другой альбом');
  await openEditor(page);
  const response = page.waitForResponse(url);
  release();
  await response;
  await expect(page.locator('#album-cover-save')).toBeDisabled();
  await expect(page.locator('#album-cover-preview')).toHaveAttribute('src', 'covers/music.jpg');
});

test('a stalled image times out and the form can recover', async ({ page }) => {
  await demo(page);
  await openAlbum(page);
  await openEditor(page);
  await page.clock.install();
  await page.route('https://images.example.test/stalled.jpg', () => {});
  await page.locator('#album-cover-url').fill('https://images.example.test/stalled.jpg');
  await page.clock.runFor(16000);
  await expect(page.locator('#album-cover-error')).toContainText('слишком долго');
  await expect(page.locator('#album-cover-save')).toBeDisabled();
  await pickFile(page);
});

test('localStorage failure preserves the old cover and allows retry', async ({ page }) => {
  await demo(page, 'covers/blonde.jpg');
  await openAlbum(page);
  await openEditor(page);
  await pickFile(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'albums_local_v1') {
        Storage.prototype.setItem = original;
        throw new DOMException('full', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await page.locator('#album-cover-save').click();
  await expect(page.locator('#album-cover-error')).toContainText('Не удалось сохранить обложку в браузере');
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', 'covers/blonde.jpg');
  expect((await storedAlbum(page)).cover).toBe('covers/blonde.jpg');
  await save(page);
});

async function cloud(page: Page) {
  await config(page, true);
  const profile = { id: '11111111-1111-4111-8111-111111111111', username: 'Участник', initials: 'У', avatar_url: null };
  const user = { id: profile.id, email: EMAIL, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2025-01-01T00:00:00Z' };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: user.id, exp, role: 'authenticated' })).toString('base64url'), 'test-signature',
  ].join('.');
  const state = {
    album: { id: album.id, artist: album.artist, title: album.title, year: album.year, cover_url: 'covers/blonde.jpg', tracks_locked: true, cohesion: 2, album_type: 'album' },
    uploads: [] as { path: string; upsert: string | undefined }[],
    writes: [] as { table: string; method: string; body: Record<string, unknown>; id: string | null }[],
    failUpload: false, failUpdate: false, missingAlbum: false,
    holdUpdate: null as Promise<void> | null,
    socket: null as WebSocketRoute | null,
    albumSubscription: -1,
    joinRef: null as string | null,
  };
  await page.routeWebSocket('wss://album-cover-tests.supabase.co/**', (socket) => {
    state.socket = socket;
    socket.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      if (event === 'phx_join') {
        state.joinRef = joinRef;
        const changes = payload.config.postgres_changes.map((binding: object, index: number) => ({ ...binding, id: index + 1 }));
        state.albumSubscription = changes.find((binding: { table: string }) => binding.table === 'albums').id;
        socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: changes } }]));
      } else if (event === 'heartbeat') {
        socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
      }
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
    if (url.pathname.startsWith('/storage/v1/object/public/')) return route.fulfill({ headers, contentType: 'image/svg+xml', body: svg });
    if (url.pathname.startsWith('/storage/v1/object/covers/')) {
      state.uploads.push({ path: url.pathname, upsert: request.headers()['x-upsert'] });
      return state.failUpload ? json({ statusCode: '403', error: 'Unauthorized', message: 'storage denied' }, 403) : json({ Key: url.pathname });
    }
    const table = url.pathname.split('/').pop()!;
    if (request.method() !== 'GET') {
      state.writes.push({ table, method: request.method(), body: request.postDataJSON(), id: url.searchParams.get('id') });
      if (state.holdUpdate) await state.holdUpdate;
      if (state.failUpdate) return json({ code: '42501', message: 'update denied' }, 403);
      if (state.missingAlbum) return json({ code: 'PGRST116', message: 'No rows found' }, 406);
      Object.assign(state.album, request.postDataJSON());
      return json({ id: state.album.id });
    }
    if (table === 'profiles') return json([profile]);
    if (table === 'albums') return json([state.album]);
    if (table === 'tracks' || table === 'ratings') return json([]);
    throw new Error(`Unexpected test request: ${request.method()} ${url}`);
  });
  await page.goto('/');
  await login(page);
  await openAlbum(page);
  return state;
}

test('cloud file uploads use new paths, update only this album cover, and survive reload', async ({ page }) => {
  const state = await cloud(page);
  for (let i = 0; i < 2; i++) {
    await openEditor(page);
    await pickFile(page);
    await save(page);
  }
  expect(state.uploads).toHaveLength(2);
  expect(state.uploads[0].path).not.toBe(state.uploads[1].path);
  expect(state.uploads.every((upload) => upload.upsert === 'false')).toBe(true);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual({
    table: 'albums', method: 'PATCH', id: `eq.${album.id}`, body: { cover_url: state.album.cover_url },
  });
  expect(state.album.cover_url).toMatch(/^https:\/\/album-cover-tests.supabase.co\/storage\/v1\/object\/public\/covers\/cover-.*\.jpg$/);
  expect(state.album.cohesion).toBe(2);
  expect(state.album.album_type).toBe('album');
  expect(state.album.tracks_locked).toBe(true);
  await page.reload();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await openAlbum(page);
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', state.album.cover_url);
});

test('cloud URL saving does not upload a file', async ({ page }) => {
  const state = await cloud(page);
  const url = await imageUrl(page);
  await openEditor(page);
  await page.locator('#album-cover-url').fill(url);
  await expect(page.locator('#album-cover-save')).toBeEnabled();
  await save(page);
  expect(state.uploads).toHaveLength(0);
  expect(state.album.cover_url).toBe(url);
});

for (const failure of ['failUpload', 'failUpdate', 'missingAlbum'] as const) {
  test(`cloud ${failure} keeps the old cover and enables retry`, async ({ page }) => {
    const state = await cloud(page);
    state[failure] = true;
    await openEditor(page);
    await pickFile(page);
    await page.locator('#album-cover-save').click();
    await expect(page.locator('#album-cover-error')).toHaveClass(/is-visible/);
    await expect(page.locator('#album-cover-save')).toBeEnabled();
    await expect(page.locator('#av-cover-img')).toHaveAttribute('src', 'covers/blonde.jpg');
    expect(state.album.cover_url).toBe('covers/blonde.jpg');
    if (failure === 'failUpload') expect(state.writes).toHaveLength(0);
    if (failure === 'missingAlbum') await expect(page.locator('#album-cover-error')).toContainText('Альбом больше не доступен');
    state[failure] = false;
    await save(page);
    await expect(page.locator('#av-cover-img')).toHaveAttribute('src', state.album.cover_url);
  });
}

test('saving prevents duplicate submissions, editing and closing until the update completes', async ({ page }) => {
  const state = await cloud(page);
  let release!: () => void;
  state.holdUpdate = new Promise<void>((resolve) => { release = resolve; });
  await openEditor(page);
  await pickFile(page);
  await page.locator('#album-cover-save').click();
  await expect.poll(() => state.writes.length).toBe(1);
  for (const id of ['save', 'pick', 'url', 'cancel']) await expect(page.locator(`#album-cover-${id}`)).toBeDisabled();
  await page.locator('#album-cover-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await page.keyboard.press('Escape');
  await expect(page.locator('#album-cover-dialog')).toBeVisible();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', 'covers/blonde.jpg');
  release();
  await expect(page.locator('#album-cover-dialog')).not.toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.uploads).toHaveLength(1);
});

test('Realtime updates the cover after a fresh login, not only after page reload', async ({ page }) => {
  const state = await cloud(page);
  await expect.poll(() => state.albumSubscription).toBeGreaterThanOrEqual(0);
  const url = await imageUrl(page);
  state.album.cover_url = url;
  state.socket!.send(JSON.stringify([
    state.joinRef, null, 'realtime:db-changes', 'postgres_changes',
    { ids: [state.albumSubscription], data: { schema: 'public', table: 'albums', type: 'UPDATE', record: state.album, old_record: { id: album.id }, columns: [] } },
  ]));
  await expect(page.locator('#av-cover-img')).toHaveAttribute('src', url);
  await page.locator('#album-back').click();
  await expect(page.locator('#albums .album__cover img').first()).toHaveAttribute('src', url);
});

test('creating an album no longer silently ignores a cloud cover upload error', async ({ page }) => {
  const state = await cloud(page);
  state.failUpload = true;
  await page.locator('#album-back').click();
  await page.locator('.album--add').click();
  await page.locator('#artist-input').fill('Новый артист');
  await page.locator('#title-input').fill('Новый альбом');
  await page.locator('#year-input').fill('2025');
  await page.locator('#cover-file').setInputFiles(imageFile);
  await expect(page.locator('#cover-pick')).toHaveClass(/has-cover/);
  await page.locator('#add-submit').click();
  await expect(page.locator('#add-error')).toContainText('Не удалось загрузить обложку');
  expect(state.writes).toHaveLength(0);
  await expect(page.locator('#view-add')).toHaveClass(/is-visible/);
});
