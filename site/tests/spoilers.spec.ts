import { expect, test, type Page } from '@playwright/test';

/* Спойлеры оценок: тумблер в «мой профиль» размывает баллы на главной,
   страницах альбома и сингла (CSS-класс body.spoilers), подсказки-тултипы
   чипов не выдают число, своя оценка проявляется в фокусе поля/ползунка,
   настройка переживает перезагрузку. jsdom-аналог — tests/spoilers.check.mjs. */

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

const filterOf = (page: Page, selector: string): Promise<string> =>
  page.locator(selector).first().evaluate((el) => getComputedStyle(el).filter);

const expectBlurred = async (page: Page, selector: string): Promise<void> => {
  await expect.poll(() => filterOf(page, selector), { timeout: 4000 }).toContain('blur');
};
const expectSharp = async (page: Page, selector: string): Promise<void> => {
  await expect.poll(() => filterOf(page, selector), { timeout: 4000 }).toBe('none');
};

test('спойлеры: тумблер в профиле размывает оценки на главной, в альбоме и сингле', async ({ page }) => {
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
  await expectBlurred(page, '.album__avg-num');

  // альбом: среднее балл, треки, поле и ползунок своей оценки, чипы вклада
  await page.locator('#albums .album .album__title').first().click();
  await expect(page.locator('#view-album')).toHaveClass(/is-visible/);
  await expectBlurred(page, '#av-avg');
  await expectBlurred(page, '.track__avg');
  await expectBlurred(page, '.track__peer-val');
  await expectBlurred(page, '.track__numinput');
  await expectBlurred(page, '.track__slider');
  await expectBlurred(page, '#av-chips .av__chip-val');
  // подсказка чипа не должна выдавать балл
  const chipTitle = await page.locator('#av-chips .av__chip').first().getAttribute('title');
  expect(chipTitle).toBe('');

  // своя оценка проявляется в фокусе — можно выставить балл, не выключая спойлер
  const num = page.locator('.track__numinput').first();
  await num.click();
  await expect.poll(() => filterOf(page, '.track__numinput'), { timeout: 4000 }).toBe('none');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expectBlurred(page, '.track__numinput');

  // сингл: балл, моя оценка и чипы
  await page.locator('#album-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album .album__title').first().click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);
  await expectBlurred(page, '#sv-avg');
  await expectBlurred(page, '#sv-mine');
  await expectBlurred(page, '#sv-chips .av__chip-val');
  await expectBlurred(page, '#sv-slider');

  // выключаем обратно — всё снова чёткое
  await page.locator('#single-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
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
  await expectBlurred(page, '.album__avg-num');
  await page.locator('#profile-btn').click();
  await expect(page.locator('#prof-spoilers')).toHaveAttribute('aria-checked', 'true');

  expect(errors).toEqual([]);
});
