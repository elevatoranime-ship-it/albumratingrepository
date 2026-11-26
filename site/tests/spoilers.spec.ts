import { expect, test, type Page } from '@playwright/test';

/* Спойлеры оценок: тумблер в «мой профиль» прячет баллы за звёздочками —
   текст числа гаснет (color: transparent), поверх ложится псевдоэлемент '***'
   (CSS-класс body.spoilers). Поле своей оценки показывает '***' фоном, пока
   не получит фокус; подсказки-тултипы чипов не выдают число; настройка
   переживает перезагрузку. jsdom-аналог — tests/spoilers.check.mjs. */

const USER_ID = 'killmiplag@demo.local';
// оценки треков первого альбома, чтобы на странице альбома были чипы вклада
const SEED_RATINGS = JSON.stringify({
  'mojo-music': {
    [USER_ID]: { score: 8.4, confirmed: true },
    'elevator@demo.local': { score: 9.1, confirmed: true },
  },
});

async function login(page: Page): Promise<void> {
  await page.route('**/*', (route) => new URL(route.request().url()).origin === 'http://127.0.0.1:8080' ? route.continue() : route.abort());
  await page.route('**/api/genius/**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"genius off in tests"}' }));
  await page.goto('/?demo=1');
  await page.evaluate((seed) => localStorage.setItem('track_ratings_local_v1', seed), SEED_RATINGS);
  await page.locator('#email-input').fill(USER_ID);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/** число замаскировано: текст прозрачный, а поверх лежат '***' */
const isMasked = (page: Page, selector: string): Promise<boolean> =>
  page.locator(selector).first().evaluate((el, transparent) => {
    const cs = getComputedStyle(el);
    return cs.color === transparent && getComputedStyle(el, '::after').content.includes('***');
  }, TRANSPARENT);

/** число видно: текст обычного цвета, псевдоэлемента-маски нет */
const isSharp = (page: Page, selector: string): Promise<boolean> =>
  page.locator(selector).first().evaluate((el, transparent) => {
    const cs = getComputedStyle(el);
    return cs.color !== transparent && getComputedStyle(el, '::after').content === 'none';
  }, TRANSPARENT);

const expectMasked = async (page: Page, selector: string): Promise<void> => {
  await expect.poll(() => isMasked(page, selector), { timeout: 4000 }).toBe(true);
};
const expectSharp = async (page: Page, selector: string): Promise<void> => {
  await expect.poll(() => isSharp(page, selector), { timeout: 4000 }).toBe(true);
};

/** поле оценки: '***' фоном и прозрачный текст, пока не в фокусе */
const inputMasked = (page: Page): Promise<boolean> =>
  page.locator('.track__numinput').first().evaluate((el, transparent) => {
    const cs = getComputedStyle(el);
    return cs.color === transparent && cs.backgroundImage !== 'none';
  }, TRANSPARENT);
const inputRevealed = (page: Page): Promise<boolean> =>
  page.locator('.track__numinput').first().evaluate((el, transparent) => {
    const cs = getComputedStyle(el);
    return cs.color !== transparent && cs.backgroundImage === 'none';
  }, TRANSPARENT);

test('спойлеры: тумблер в профиле прячет оценки за звёздочками', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);

  // до включения оценки видны чётко
  await expectSharp(page, '.album__avg-num');

  // включаем в «мой профиль»
  await page.locator('#profile-btn').click();
  await expect(page.locator('#view-profile')).toHaveClass(/is-visible/);
  const toggle = page.locator('#prof-spoilers');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('body')).toHaveClass(/spoilers/);

  // главная: карточки альбомов и синглов
  await page.locator('#profile-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await expectMasked(page, '.album__avg-num');

  // альбом: средний балл, треки, чипы вклада
  await page.locator('#albums .album .album__title').first().click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
  await expectMasked(page, '#av-avg');
  await expectMasked(page, '.track__avg');
  await expectMasked(page, '.track__peer-val');
  await expectMasked(page, '#av-chips .av__chip-val');
  await expect.poll(() => inputMasked(page)).toBe(true);
  // подсказка чипа не должна выдавать балл
  const chipTitle = await page.locator('#av-chips .av__chip').first().getAttribute('title');
  expect(chipTitle).toBe('');

  // поле своей оценки проявляется в фокусе — можно выставить балл, не выключая спойлер
  await page.locator('.track__numinput').first().click();
  await expect.poll(() => inputRevealed(page), { timeout: 4000 }).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => inputMasked(page), { timeout: 4000 }).toBe(true);

  // сингл: балл, моя оценка (звёздочки из рендера) и чипы
  await page.locator('#album-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album .album__title').first().click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);
  await expectMasked(page, '#sv-avg');
  await expectMasked(page, '#sv-chips .av__chip-val');
  await expect.poll(() => page.locator('#sv-mine').textContent()).toBe('***');

  // выключаем обратно — всё снова чёткое
  await page.locator('#single-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await page.locator('#seg-albums').click();
  await page.locator('#profile-btn').click();
  await expect(page.locator('#view-profile')).toHaveClass(/is-visible/);
  await page.locator('#prof-spoilers').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('body')).not.toHaveClass(/spoilers/);
  await page.locator('#profile-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await expectSharp(page, '.album__avg-num');

  expect(errors).toEqual([]);
});

test('спойлеры: настройка переживает перезагрузку', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.locator('#profile-btn').click();
  await page.locator('#prof-spoilers').click();
  await expect(page.locator('body')).toHaveClass(/spoilers/);

  await page.reload();
  await page.locator('#email-input').fill(USER_ID);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await expect(page.locator('body')).toHaveClass(/spoilers/);
  await expectMasked(page, '.album__avg-num');
  await page.locator('#profile-btn').click();
  await expect(page.locator('#prof-spoilers')).toHaveAttribute('aria-checked', 'true');

  expect(errors).toEqual([]);
});
