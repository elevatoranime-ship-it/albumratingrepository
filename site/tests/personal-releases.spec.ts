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
  await page.locator('#evaluator-trigger').click();
  await page.locator(`#evaluator-list [data-value="${evaluator}"]`).click();
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
  await page.locator('#evaluator-trigger').click();
  await page.locator(`#evaluator-list [data-value="${evaluator}"]`).click();
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

test('кастомный выбор: круглые аватары, выбранная опция и сброс новой формы', async ({ page }) => {
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#b7a8ef"/></svg>');
  await page.addInitScript(({ evaluator, avatar }) => {
    localStorage.setItem('profile_meta_local_v1', JSON.stringify({ [evaluator]: { username: 'киллмиплаг', avatarUrl: avatar } }));
  }, { evaluator, avatar });
  await login(page, admin);
  await page.locator('#albums .album--add').click();
  const trigger = page.locator('#evaluator-trigger');
  const list = page.locator('#evaluator-list');
  await expect(page.locator('select#evaluator-input')).toHaveCount(0);
  await expect(trigger.locator('.evaluator__name')).toHaveText('Все участники');
  await expect(trigger.locator('.evaluator__avatar')).toHaveCount(2);
  await expect(page.locator('#evaluator-note')).toHaveText('Все или один участник. После создания выбор не изменить.');
  await trigger.click();
  await expect(list).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('option')).toHaveCount(3);
  const person = list.getByRole('option', { name: 'киллмиплаг', exact: true });
  await expect(person.locator('.evaluator__avatar')).toHaveCSS('border-radius', '50%');
  await expect(person.locator('.evaluator__avatar')).toHaveCSS('background-image', /data:image\/svg/);
  await expect(list.getByRole('option', { name: 'Elevator', exact: true }).locator('.evaluator__avatar')).toHaveText('E');
  // Список непрозрачен, не перекрыт следующими полями и не выходит по ширине.
  const bounds = await list.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await person.scrollIntoViewIfNeeded();
  const unobscured = await person.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  expect(unobscured).toBe(true);
  await person.click();
  await expect(list).toBeHidden();
  await expect(trigger.locator('.evaluator__name')).toHaveText('киллмиплаг');
  await expect(trigger.locator('.evaluator__avatar')).toHaveCount(1);
  await expect(page.locator('#evaluator-input')).toHaveValue(evaluator);
  await expect(page.locator('#evaluator-picker')).toHaveClass(/is-picked/);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(person).toHaveAttribute('aria-selected', 'true');
  await page.locator('#year-input').click();
  await expect(list).toBeHidden();
  await expect(page.locator('#evaluator-input')).toHaveValue(evaluator);
  await page.locator('#add-back').click();
  await expect(page.locator('#view-home')).toHaveClass(/is-visible/);
  await page.locator('#albums .album--add').click();
  await expect(trigger.locator('.evaluator__name')).toHaveText('Все участники');
  await expect(page.locator('#evaluator-input')).toHaveValue('');
  await expect(page.locator('#evaluator-picker')).not.toHaveClass(/is-picked/);
});

test('кастомный выбор: клавиатура, Escape без ухода, Tab без изменения и возврат ко всем', async ({ page }) => {
  await login(page, admin);
  await page.locator('#seg-singles').click();
  await page.locator('#albums .album--add').click();
  const trigger = page.locator('#evaluator-trigger');
  await trigger.focus();
  await trigger.press('ArrowDown');
  await expect(trigger).toHaveAttribute('aria-activedescendant', 'evaluator-option-0');
  await trigger.press('End');
  await expect(trigger).toHaveAttribute('aria-activedescendant', 'evaluator-option-2');
  await trigger.press('Enter');
  await expect(page.locator('#evaluator-input')).toHaveValue(admin);
  await expect(trigger.locator('.evaluator__name')).toHaveText('Elevator');
  await trigger.press('Space');
  await trigger.press('Home');
  await trigger.press('Escape');
  await expect(page.locator('#evaluator-list')).toBeHidden();
  await expect(page.locator('#view-add')).toHaveClass(/is-visible/);
  await expect(page.locator('#evaluator-input')).toHaveValue(admin);
  await trigger.press('ArrowUp');
  await trigger.press('ArrowUp');
  await trigger.press('Tab');
  await expect(page.locator('#evaluator-list')).toBeHidden();
  await expect(page.locator('#evaluator-input')).toHaveValue(admin);
  await trigger.focus();
  await trigger.press('Enter');
  await trigger.press('Home');
  await trigger.press('Enter');
  await expect(trigger.locator('.evaluator__name')).toHaveText('Все участники');
  await expect(page.locator('#evaluator-input')).toHaveValue('');
});

test('кастомный выбор: плавное раскрытие, подтверждение, быстрые клики и reduced motion', async ({ page }) => {
  await login(page, admin);
  await page.locator('#albums .album--add').click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const trigger = page.locator('#evaluator-trigger');
  const list = page.locator('#evaluator-list');
  await trigger.click();
  await expect(list).toHaveCSS('opacity', '1');
  await expect(list).toHaveCSS('transition-duration', '0.22s, 0.28s, 0s');
  // CSS-пульс и прорисовка галочки должны действительно запуститься.
  const animations = await list.getByRole('option', { name: 'киллмиплаг', exact: true }).evaluate((el: HTMLElement) => {
    el.click();
    return document.querySelector('#evaluator-picker')!.getAnimations({ subtree: true }).map((a) => a instanceof CSSAnimation ? a.animationName : 'transition');
  });
  expect(animations).toContain('evaluatorConfirm');
  expect(animations).toContain('checkDraw');
  await expect(list).toBeHidden();
  await trigger.evaluate((el: HTMLButtonElement) => { el.click(); el.click(); el.click(); });
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toHaveCSS('opacity', '1');
  await list.getByRole('option', { name: 'Elevator', exact: true }).click();
  await expect(trigger.locator('.evaluator__name')).toHaveText('Elevator');
  await expect(list).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  const reducedAnimations = await list.getByRole('option', { name: 'Все участники', exact: true }).evaluate((el: HTMLElement) => {
    el.click();
    return document.querySelector('#evaluator-picker')!.getAnimations({ subtree: true }).length;
  });
  expect(reducedAnimations).toBe(0);
  await expect(list).toBeHidden();
});
