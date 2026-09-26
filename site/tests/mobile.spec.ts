import { expect, test, type Page } from '@playwright/test';

/* Мобильный UI (тач-экраны) и новый рейтинг альбомов.
   Демо-режим (?demo=1) — настоящая база Supabase не используется.
   Тесты с пометкой «тач» пропускаются на десктопном проекте,
   где нет эмуляции сенсорного экрана. */

const touchUi = (page: Page) =>
  page.evaluate(() => window.matchMedia('(hover: none) and (pointer: coarse)').matches);

async function demoLogin(page: Page): Promise<void> {
  await page.goto('/?demo=1');
  await page.locator('#email-input').fill('killmiplag@demo.local');
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}

/* открывает страницу альбома MUSIC (с треком, помеченным синглом) */
async function openMusicAlbum(page: Page): Promise<void> {
  const card = page.locator('#albums .album').filter({ has: page.getByRole('heading', { name: 'MUSIC', exact: true }) });
  await card.click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
}

test('тач: меню «рейтинги» раскрывается вправо, полностью помещается на экране и содержит «альбомы»', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const touch = await touchUi(page);
  test.skip(!touch, 'нужен тач-экран без мыши (мобильный проект)');
  await demoLogin(page);

  await page.locator('#artists-btn').click();
  const list = page.locator('#rank-menu-list');
  await expect(list).toBeVisible();
  await expect(list).toHaveCSS('opacity', '1'); // завершили анимацию появления

  const btn = await page.locator('#artists-btn').boundingBox();
  const box = await list.boundingBox();
  expect(btn && box).toBeTruthy();
  // список открывается вправо от кнопки (а не влево — за край экрана)
  expect(box!.x).toBeGreaterThanOrEqual(btn!.x - 2);
  // полностью помещается на экране: иконки и подписи видны целиком
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  // четыре пункта, «альбомы» — первый, со счётчиком (в демо 8 альбомов)
  await expect(page.locator('.rank-menu__item')).toHaveCount(4);
  const albums = page.locator('.rank-menu__item[data-rank="albums"]');
  await expect(albums.locator('.rank-menu__label')).toHaveText('альбомы');
  await expect(albums.locator('.rank-menu__count')).toHaveText('8');
  expect(errors).toEqual([]);
});

test('рейтинг альбомов: в чарт попадают только альбомы, подтверждённые обоими участниками', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await demoLogin(page);

  await page.locator('#artists-btn').click();
  await expect(page.locator('#rank-menu-list')).toBeVisible();
  await page.locator('.rank-menu__item[data-rank="albums"]').click();
  await expect(page.locator('#view-arank')).toHaveClass(/is-visible/);
  await expect(page.locator('#view-arank .rank__title')).toHaveText('рейтинг альбомов');

  // в демо 7 альбомов; в чарт попал только Blonde — там трек «Nikes»
  // подтверждён обоими участниками (9.4 и 8.6 → 9)
  await expect(page.locator('#album-rank-list .rank')).toHaveCount(7);
  const first = page.locator('#album-rank-list .rank').first();
  await expect(first.locator('.rank__name')).toHaveText('Blonde');
  await expect(first.locator('.rank__score')).toHaveText('9');
  await expect(first).toHaveClass(/rank--1/);
  await expect(first.locator('.rank__meta')).toContainText('Frank Ocean · 2016 · 1 трек');

  // остальные — внизу с честной подписью
  const unranked = page.locator('#album-rank-list .rank.is-unranked');
  await expect(unranked).toHaveCount(7);
  await expect(unranked.first().locator('.rank__score')).toHaveText('—');
  await expect(unranked.first().locator('.rank__meta')).toContainText('оценок пока нет');
  await expect(unranked.last().locator('.rank__meta')).toContainText('оценок пока нет');

  // клик по строке открывает страницу альбома
  await first.click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
  await expect(page.locator('#av-title')).toHaveText('Blonde');
  // назад — в рейтинг, а не на главную
  await page.locator('#album-back').click();
  await expect(page.locator('#view-arank')).toHaveClass(/is-visible/);
  await page.locator('#arank-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  expect(errors).toEqual([]);
});

test('тач: ползунок оценки «вооружается» тапом по строке, повторный тап снимает выделение', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const touch = await touchUi(page);
  test.skip(!touch, 'нужен тач-экран без мыши (мобильный проект)');
  await demoLogin(page);
  await openMusicAlbum(page);

  // добавляем обычный (не сингл) трек
  await page.locator('#track-input').fill('Новый трек');
  await page.locator('#track-add-btn').click();
  const row = page.locator('#track-list .track:not(.track--single)');
  await expect(row.locator('.track__title')).toHaveText('Новый трек');

  // до активации строки ползунок не ловит пальцы
  await expect(row).not.toHaveClass(/is-active/);
  await expect(row.locator('.track__slider')).toHaveCSS('pointer-events', 'none');

  // тап по строке — подсветка, ползунок доступен
  await row.locator('.track__num').click();
  await expect(row).toHaveClass(/is-active/);
  await expect(row.locator('.track__slider')).toHaveCSS('pointer-events', 'auto');

  // двигаем ползунок — оценка сохраняется
  await row.locator('.track__slider').evaluate((el: HTMLInputElement) => {
    el.value = '7.25';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(row.locator('.track__numinput')).toHaveValue('7.25');
  await expect(row.locator('.track__save')).toHaveText('сохранено', { timeout: 4000 });

  // повторный тап по строке — выделение снято, ползунок снова неактивен
  await row.locator('.track__num').click();
  await expect(row).not.toHaveClass(/is-active/);
  await expect(row.locator('.track__slider')).toHaveCSS('pointer-events', 'none');

  // числовое поле доступно БЕЗ активации (заблокирован только слайдер):
  // ставим балл треку с меткой сингла — без выделения строки
  const singleRow = page.locator('#track-list .track--single').first();
  await expect(singleRow).not.toHaveClass(/is-active/);
  await singleRow.locator('.track__numinput').fill('5.5');
  await expect(singleRow.locator('.track__save')).toHaveText('сохранено', { timeout: 4000 });
  await expect(singleRow).not.toHaveClass(/is-active/);
  expect(errors).toEqual([]);
});

test('тач: тап вне списка треков снимает выделение строки', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const touch = await touchUi(page);
  test.skip(!touch, 'нужен тач-экран без мыши (мобильный проект)');
  await demoLogin(page);
  await openMusicAlbum(page);

  const row = page.locator('#track-list .track--single').first();
  // тап по строке (по номеру трека) — выделение; модалка перехода в сингл НЕ открывается
  await row.locator('.track__num').click();
  await expect(page.locator('#confirm-modal')).toBeHidden();
  await expect(row).toHaveClass(/is-active/);

  // тап вне списка — выделение снято
  await page.locator('#av-title').click();
  await expect(row).not.toHaveClass(/is-active/);
  expect(errors).toEqual([]);
});

/* Разметка карточек релиза: на телефоне две карточки в ряд, и раньше блок оценки
   «скакал» вверх-вниз (у синглов со строкой «к альбому …» и подписью про
   неподтверждённые оценки карточка получалась выше), а счётчик «12 треков»
   переносился на вторую строку, тогда как «3 трека» — нет.
   Проверяем на обоих проектах (телефон и десктоп): карточки ряда одинаковой
   высоты, блок оценки прижат к нижнему краю, счётчик строго в одну строку. */
test('карточки релизов: балл на одной линии, счётчик в одну строку', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await demoLogin(page);

  const cards = page.locator('#albums .album:not(.album--add)');
  const measure = async () => {
    // дожидаемся конца анимации появления, чтобы мерить установившуюся разметку
    await expect(cards.last()).not.toHaveClass(/reveal/);
    return cards.evaluateAll((els) => els.map((el) => {
      const card = el.getBoundingClientRect();
      const ratingEl = el.querySelector('.album__rating');
      const countEl = el.querySelector('.album__count');
      const rating = ratingEl ? ratingEl.getBoundingClientRect() : card;
      const count = countEl ? countEl.getBoundingClientRect() : null;
      const line = countEl ? parseFloat(getComputedStyle(countEl).lineHeight) : 0;
      return {
        title: (el.querySelector('.album__title')?.textContent ?? '').trim(),
        top: Math.round(card.top),
        bottom: Math.round(card.bottom),
        gap: Math.round(card.bottom - rating.bottom),
        lines: count && line > 0 ? Math.round(count.height / line) : 0,
      };
    }));
  };

  const check = (rows: Array<{ title: string; top: number; bottom: number; gap: number; lines: number }>) => {
    expect(rows.length, JSON.stringify(rows)).toBeGreaterThan(2);
    // блок оценки у всех карточек на одинаковом расстоянии от нижнего края
    const gaps = rows.map((r) => r.gap);
    expect(Math.max(...gaps) - Math.min(...gaps), JSON.stringify(rows)).toBeLessThanOrEqual(1);
    // счётчик («12 треков», «2 оценки») никогда не переносится
    expect(Math.max(...rows.map((r) => r.lines)), JSON.stringify(rows)).toBeLessThanOrEqual(1);
    // карточки одного ряда одинаковой высоты — значит, и балл у них на одной линии
    const byRow = new Map<number, number[]>();
    for (const r of rows) byRow.set(r.top, [...(byRow.get(r.top) ?? []), r.bottom]);
    for (const bottoms of byRow.values()) expect(Math.max(...bottoms) - Math.min(...bottoms), JSON.stringify(rows)).toBeLessThanOrEqual(1);
    return gaps[0];
  };

  const albumGap = check(await measure());

  // синглы: у карточек разная «начинка» (строка «к альбому …», «1 без подтверждения»,
  // пустая подпись у релиза без оценок) — линия балла от этого не меняется
  await page.locator('#seg-singles').click();
  const singleGap = check(await measure());
  expect(Math.abs(singleGap - albumGap)).toBeLessThanOrEqual(1);

  // подпись про неподтверждённую оценку видна и не ломает выравнивание
  await expect(page.locator('#albums .album__votes-count').first()).toBeVisible();
  expect(errors).toEqual([]);
});
