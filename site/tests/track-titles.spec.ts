import { expect, test, type Page } from '@playwright/test';

/* Названия треков остаются редактируемыми, даже когда количество треков
   зафиксировано (albums.tracks_locked). Фиксация количества запрещает только
   добавлять/удалять треки и менять порядок; правку названия запрещает лишь
   личная фиксация названия (tracks.locked).

   Демо-режим (?demo=1) — данные в localStorage, настоящая база не используется. */

const EMAIL = 'killmiplag@demo.local';   // обычный участник, не админ

const album = {
  id: 'locked-album', artist: 'Артист', title: 'Зафиксированный альбом', year: 2025,
  cover: '', tracksLocked: true, cohesion: null, albumType: 'album', kind: 'album', parentId: null,
};
const tracks = [
  { id: 'track-free', albumId: album.id, title: 'Первый трек', position: 0, locked: false, featArtist: null, singleId: null, geniusId: null },
  { id: 'track-locked', albumId: album.id, title: 'Название зафиксировано', position: 1, locked: true, featArtist: null, singleId: null, geniusId: null },
];

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  // Внешние запросы запрещены: только локальный сервер и localStorage.
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === 'http://127.0.0.1:8080' ? route.continue() : route.abort());
  await page.addInitScript(({ album, tracks }) => {
    localStorage.setItem('albums_local_v1', JSON.stringify([album]));
    localStorage.setItem('tracks_local_v1', JSON.stringify(tracks));
    localStorage.setItem('track_ratings_local_v1', JSON.stringify({}));
    localStorage.setItem('single_ratings_local_v1', JSON.stringify({}));
  }, { album, tracks });
  await page.goto('/?demo=1');
  await page.locator('#email-input').fill(EMAIL);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await page.locator('#albums .album__title').click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
  await expect(page.locator('#av-title')).toHaveText('Зафиксированный альбом');
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test('количество треков зафиксировано — названия всё равно можно менять', async ({ page }) => {
  // форма добавления трека скрыта, напоминание о фиксации на месте
  await expect(page.locator('#track-form')).toBeHidden();
  await expect(page.locator('#tracks-locked-note')).toBeVisible();
  await expect(page.locator('#tracks-locked-note')).toContainText('названия можно править');

  const free = page.locator('#track-list .track[data-id="track-free"]');
  // порядок и удаление заблокированы вместе с количеством
  await expect(free.locator('[data-act="up"]')).toHaveCount(0);
  await expect(free.locator('[data-act="down"]')).toHaveCount(0);
  await expect(free.locator('[data-act="del"]')).toHaveCount(0);
  await expect(free.locator('.track__handle')).not.toHaveAttribute('draggable', 'true');

  // а переименование доступно и обычному участнику
  await free.locator('[data-act="rename"]').click();
  const input = page.locator('#track-list .track__rename-input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Первый трек');
  await input.fill('Переименованный трек');
  await page.keyboard.press('Enter');

  const row = page.locator('#track-list .track[data-id="track-free"]');
  await expect(row.locator('.track__title')).toHaveText('Переименованный трек');
  expect(await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tracks_local_v1')!)
      .find((t: { id: string }) => t.id === 'track-free').title)).toBe('Переименованный трек');

  // количество треков не изменилось
  await expect(page.locator('#track-list .track')).toHaveCount(2);
});

test('личная фиксация названия по-прежнему запрещает переименование', async ({ page }) => {
  const locked = page.locator('#track-list .track[data-id="track-locked"]');
  await expect(locked).toHaveClass(/is-locked/);
  await expect(locked.locator('[data-act="rename"]')).toHaveCount(0);
  await expect(locked.locator('.track__title')).toHaveText('Название зафиксировано');
});

test('отмена переименования оставляет прежнее название (Escape и пустое значение)', async ({ page }) => {
  const free = page.locator('#track-list .track[data-id="track-free"]');

  await free.locator('[data-act="rename"]').click();
  await page.locator('#track-list .track__rename-input').fill('Черновик');
  await page.keyboard.press('Escape');
  await expect(page.locator('#track-list .track[data-id="track-free"] .track__title')).toHaveText('Первый трек');

  // пустое название не сохраняется
  await page.locator('#track-list .track[data-id="track-free"] [data-act="rename"]').click();
  await page.locator('#track-list .track__rename-input').fill('   ');
  await page.keyboard.press('Enter');
  await expect(page.locator('#track-list .track[data-id="track-free"] .track__title')).toHaveText('Первый трек');
});
