/* Проверка гонки переходов на jsdom — работает без браузера:
     node tests/navigation-race.check.mjs   (npm run test:nav)
   То же покрытие даёт tests/navigation-race.spec.ts (Playwright, нужен браузер).
   Сценарии из баг-репорта: быстрый клик «профиль» → сразу альбом/трек,
   обратный порядок и двойной клик по «профиль». В любой момент должен быть
   виден ровно один экран. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}: ожидалось ${e}, получено ${a}`); }
}

async function waitFor(fn, timeout = 8000, step = 40) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`waitFor: таймаут (${timeout} мс)`);
    await sleep(step);
  }
}

/** Свежая страница демо-режима, залогиненная и дождавшаяся главной. */
const configJs = readFileSync(path.join(root, 'config.js'), 'utf8');
const appJs = readFileSync(path.join(root, 'app.js'), 'utf8');

async function boot() {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8080/?demo=1',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = (media) => ({
        matches: false, media, onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent: () => false,
      });
      window.Element.prototype.scrollIntoView = function scrollIntoView() {};
    },
  });
  const { window } = dom;
  const doc = window.document;
  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(e.message));
  const visible = () => [...doc.querySelectorAll('.view.is-visible')].map((v) => v.id);

  // внешние <script src> jsdom не грузит — выполняем сами (как в браузере)
  window.eval(configJs);
  window.eval(appJs);

  // app.js выполнился: init() показал подсказку демо-режима
  await waitFor(() => {
    const hint = doc.querySelector('#demo-hint');
    return Boolean(hint && !hint.hidden && hint.textContent.includes('демо-режим'));
  }, 10000);

  doc.querySelector('#email-input').value = 'killmiplag@demo.local';
  doc.querySelector('#password').value = 'demo';
  doc.querySelector('#submit-btn').click();
  await waitFor(() => visible().length === 1 && visible()[0] === 'view-home');
  return { dom, window, doc, visible, pageErrors };
}

async function scenarioProfileThenAlbum() {
  console.log('сценарий: профиль → сразу альбом');
  const { dom, doc, visible, pageErrors } = await boot();
  doc.querySelector('#profile-btn').click();
  // второй клик — пока переход ещё идёт (как в баг-репорте)
  doc.querySelector('#albums .album .album__title').click();
  await waitFor(() => visible().length === 1 && visible()[0] === 'view-album');
  await sleep(900); // страховка: профиль не «всплывает» поверх позже
  check('виден только альбом', visible(), ['view-album']);
  check('ошибок страницы нет', pageErrors, []);
  dom.window.close();
}

async function scenarioAlbumThenProfile() {
  console.log('сценарий: альбом → сразу профиль, затем «назад»');
  const { dom, doc, visible, pageErrors } = await boot();
  doc.querySelector('#albums .album .album__title').click();
  doc.querySelector('#profile-btn').click(); // home ещё не ушёл — клик действует
  await waitFor(() => visible().length === 1 && visible()[0] === 'view-profile');
  check('виден только профиль', visible(), ['view-profile']);
  doc.querySelector('#profile-back').click();
  await waitFor(() => visible().length === 1 && visible()[0] === 'view-album');
  check('«назад» возвращает в альбом', visible(), ['view-album']);
  doc.querySelector('#album-back').click();
  await waitFor(() => visible().length === 1 && visible()[0] === 'view-home');
  check('второй «назад» возвращает на главную', visible(), ['view-home']);
  check('ошибок страницы нет', pageErrors, []);
  dom.window.close();
}

async function scenarioDoubleProfile() {
  console.log('сценарий: двойной клик по «профиль»');
  const { dom, doc, visible, pageErrors } = await boot();
  doc.querySelector('#profile-btn').click();
  doc.querySelector('#profile-btn').click(); // повторный клик во время перехода
  await waitFor(() => visible().length === 1 && visible()[0] === 'view-profile');
  await sleep(900);
  check('виден только профиль', visible(), ['view-profile']);
  doc.querySelector('#profile-back').click();
  await waitFor(() => visible().length === 1 && visible()[0] === 'view-home');
  check('один «назад» сразу на главную (стек не задублирован)', visible(), ['view-home']);
  check('ошибок страницы нет', pageErrors, []);
  dom.window.close();
}

await scenarioProfileThenAlbum();
await scenarioAlbumThenProfile();
await scenarioDoubleProfile();
if (failures) {
  console.log(`\nПРОВАЛЕНО проверок: ${failures}`);
  process.exit(1);
}
console.log('\nВсе проверки гонки переходов пройдены.');
