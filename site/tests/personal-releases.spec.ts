import { expect, test, type Page } from '@playwright/test';

const admin = 'elevator@demo.local';
const evaluator = 'killmiplag@demo.local';
const card = (page: Page, name: string) => page.locator('#albums .album').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function login(page: Page, email: string) {
  await page.goto('/?demo=1');
  await page.locator('#email-input').fill(email);
  await page.locator('#password').fill('demo');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).origin === 'http://127.0.0.1:8080' ? route.continue() : route.abort());
  await page.route('**/api/genius/**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"offline"}' }));
});

test('демо: создать, унаследовать назначение, оценить одному, проверить под другим аккаунтом', async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, admin);
  await page.locator('#albums .album--add').click();
  await page.locator('#artist-input').fill('Тестовый артист');
  await page.locator('#title-input').fill('Личный альбом');
  await page.locator('#year-input').fill('2025');
  await page.locator('#evaluator-input').selectOption(evaluator);
  await page.locator('#add-submit').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await card(page, 'Личный альбом').click();
  await page.locator('#track-input').fill('Личный трек');
  await page.locator('#track-add-btn').click();
  await expect(page.locator('#track-list .track')).toHaveCount(1);
  await expect(page.locator('#track-list .track__numinput')).toBeDisabled();
  await page.locator('#track-list [data-act="single"]').click();
  await expect(page.locator('#view-single')).toHaveClass(/is-visible/);
  await expect(page.locator('#sv-evaluator')).toContainText('Оценивает только киллмиплаг');
  await expect(page.locator('#sv-num')).toBeDisabled();

  // Перезагрузка сохраняет назначение. Заходит выбранный участник (не админ).
  await login(page, evaluator);
  await page.locator('#seg-singles').click();
  await card(page, 'Личный трек').click();
  await page.locator('#sv-num').fill('8.5');
  await page.locator('#sv-confirm-btn').click();
  await expect(page.locator('#sv-confirm-state')).toHaveText('подтверждён');
  await page.locator('#sv-parent-label .sv__parent-link').click();
  await expect(page.locator('#av-confirm-state')).toHaveText('подтверждён');
  await expect(page.locator('#av-avg')).toHaveText('8.5');
  await page.locator('#cohesion-control .fin-select__trigger').click();
  await page.locator('#cohesion-control [data-value="3"]').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#cohesion-control .final__tag')).toHaveText('финально');

  await login(page, admin);
  await page.locator('#seg-albums').click();
  await card(page, 'Личный альбом').click();
  await expect(page.locator('#av-confirm-state')).toHaveText('подтверждён');
  await expect(page.locator('#av-avg')).toHaveText('8.5');
  await expect(page.locator('#track-list .track__numinput')).toBeDisabled();
  await expect(page.locator('#track-list .track__confirm-btn')).toBeDisabled();
  await expect(page.locator('#cohesion-control .final__tag')).toHaveText('финально');
  await expect(page.locator('#av-chips .av__chip')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('демо: несовместимые привязки запрещены до записи, обычный участник не выбирает оценивающего', async ({ page }) => {
  await login(page, admin);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album--add').click();
  await page.locator('#artist-input').fill('Тест');
  await page.locator('#title-input').fill('Личный сингл');
  await page.locator('#year-input').fill('2025');
  await page.locator('#evaluator-input').selectOption(evaluator);
  await page.locator('#parent-input').fill('MUSIC');
  await page.locator('#add-submit').click();
  await expect(page.locator('#view-add')).toHaveClass(/is-visible/);
  await expect(page.locator('#add-error')).toContainText('должны совпадать');
  await page.locator('#parent-input').fill('');
  await page.locator('#add-submit').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await card(page, 'Личный сингл').click();
  await page.locator('#sv-parent-edit').click();
  await page.locator('#single-link-input').fill('MUSIC');
  await page.locator('#single-link-save').click();
  await expect(page.locator('#single-link-error')).toContainText('должны совпадать');
  await login(page, evaluator);
  await page.locator('#albums .album--add').click();
  await expect(page.locator('#evaluator-field')).toBeHidden();
});
