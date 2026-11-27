import { expect, test, type Page } from '@playwright/test';

/* Регрессия на гонку переходов (баг-репорт: быстрый клик «профиль», затем
   сразу трек/альбом — окно профиля открывалось поверх страницы альбома).
   Причина: swapTo не был сериализован, два параллельных перехода оба
   оставляли свой экран со class is-visible. Теперь переходы идут по очереди
   (queueNav), и в любой момент виден ровно один экран. */

async function login(page: Page): Promise<void> {
  // Настоящая база и внешние сеть в тесте не используются.
  await page.route('**/*', (route) => new URL(route.request().url()).origin === 'http://127.0.0.1:8080' ? route.continue() : route.abort());
  await page.route('**/api/genius/**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"genius off in tests"}' }));
  await page.goto('/?demo=1');
  await page.locator('#email-input').fill('killmiplag@demo.local');
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}

const visibleViews = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.view.is-visible')].map((v) => v.id));

test('профиль → сразу альбом: после двух переходов виден только альбом', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.locator('#profile-btn').click();
  // второй клик — пока переход ещё идёт (как в баг-репорте)
  await page.locator('#albums .album .album__title').first().click({ force: true });
  await expect.poll(() => visibleViews(page), { timeout: 6000 }).toEqual(['view-album']);
  await page.waitForTimeout(800); // страховка: ничего не «всплывает» поверх
  await expect.poll(() => visibleViews(page), { timeout: 6000 }).toEqual(['view-album']);
  expect(errors).toEqual([]);
});

test('альбом → сразу профиль: виден только профиль, «назад» возвращает в альбом', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.locator('#albums .album .album__title').first().click();
  await page.locator('#profile-btn').click({ force: true });
  await expect.poll(() => visibleViews(page), { timeout: 6000 }).toEqual(['view-profile']);
  await page.locator('#profile-back').click();
  await expect.poll(() => visibleViews(page), { timeout: 6000 }).toEqual(['view-album']);
  expect(errors).toEqual([]);
});

test('двойной клик по «профиль»: один шаг «назад» возвращает на главную', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.locator('#profile-btn').click();
  await page.locator('#profile-btn').click({ force: true });
  await expect.poll(() => visibleViews(page), { timeout: 6000 }).toEqual(['view-profile']);
  await page.locator('#profile-back').click();
  await expect.poll(() => visibleViews(page), { timeout: 6000 }).toEqual(['view-home']);
  expect(errors).toEqual([]);
});
