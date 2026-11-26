/* Проверка спойлеров оценок на jsdom — работает без браузера:
     node tests/spoilers.check.mjs   (npm run test:spoilers)
   Что проверяем:
     1) CSS-селекторы маски (**) находятся в разметке/рендерах;
     2) тумблер в «мой профиль» включает body.spoilers, пишет настройку
        в localStorage, чистит подсказки-тултипы чипов и рисует '***'
        в «моя оценка» сингла;
     3) настройка переживает перезагрузку (вход с сохранённым значением);
     4) выключение возвращает всё как было.
   Визуальная маска (прозрачный текст + псевдоэлемент '***', фоновые '***'
   в поле ввода) — Playwright-спека tests/spoilers.spec.ts в CI. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const configJs = readFileSync(path.join(root, 'config.js'), 'utf8');
const appJs = readFileSync(path.join(root, 'app.js'), 'utf8');
const stylesCss = readFileSync(path.join(root, 'styles.css'), 'utf8');
const appSource = readFileSync(path.join(root, 'app.ts'), 'utf8');
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

async function boot(seed = {}) {
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
      for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
    },
  });
  const { window } = dom;
  const doc = window.document;
  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(e.message));
  const visible = () => [...doc.querySelectorAll('.view.is-visible')].map((v) => v.id);

  window.eval(configJs);
  window.eval(appJs);
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

const USER_ID = 'killmiplag@demo.local';
// оценки треков первого альбома (MUSIC), чтобы на странице альбома
// отрисовались чипы «вклад в общий балл» — у них есть подсказки с баллом
const SEED_RATINGS = JSON.stringify({
  'mojo-music': {
    [USER_ID]: { score: 8.4, confirmed: true },
    'elevator@demo.local': { score: 9.1, confirmed: true },
  },
});

function checkCssSelectors() {
  console.log('проверка: CSS-селекторы маски находят свои элементы');
  const classes = new Set(
    [...stylesCss.matchAll(/body\.spoilers \.([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  );
  check('селекторов маски достаточно', classes.size >= 10, true);
  for (const cls of classes) {
    const found = html.includes(cls) || appSource.includes(cls);
    check(`.${cls} есть в разметке или рендерах`, found, true);
  }
}

async function openFirstAlbum(doc, visible) {
  doc.querySelector('#albums .album .album__title').click();
  await waitFor(() => visible().join() === 'view-album');
}

async function openFirstSingle(doc, visible) {
  doc.querySelector('#seg-singles').click();
  doc.querySelector('#albums .album .album__title').click();
  await waitFor(() => visible().join() === 'view-single');
}

async function backHome(doc, visible, viewId) {
  doc.querySelector(viewId === 'view-single' ? '#single-back' : '#album-back').click();
  await waitFor(() => visible().join() === 'view-home');
  if (viewId === 'view-single') doc.querySelector('#seg-albums').click(); // вернуть режим альбомов
}

async function scenarioToggleAndTitles() {
  console.log('сценарий: тумблер, звёздочки, подсказки чипов, выключение');
  const { dom, window, doc, visible, pageErrors } = await boot({
    track_ratings_local_v1: SEED_RATINGS,
  });
  check('при входе спойлеры выключены', doc.body.classList.contains('spoilers'), false);

  // спойлеры выключены: подсказки чипов вклада называют балл,
  // «моя оценка» сингла показывает настоящее число
  await openFirstAlbum(doc, visible);
  const chips = [...doc.querySelectorAll('#av-chips .av__chip')];
  check('чипы «вклад в общий балл» отрисованы', chips.length >= 2, true);
  check('подсказки чипов содержат балл (спойлеры выключены)', chips.every((c) => /\d/.test(c.title)), true);
  check('оценочные элементы альбома на месте', Boolean(
    doc.querySelector('#av-avg')
    && doc.querySelector('.track__avg')
    && doc.querySelector('.track__numinput')
    && doc.querySelector('.track__slider'),
  ), true);
  await backHome(doc, visible, 'view-album');

  await openFirstSingle(doc, visible);
  check('без спойлеров «моя оценка» — настоящее число', doc.querySelector('#sv-mine').textContent, '9.4');
  await backHome(doc, visible, 'view-single');

  // «мой профиль» → включаем
  doc.querySelector('#profile-btn').click();
  await waitFor(() => visible().join() === 'view-profile');
  const toggle = doc.querySelector('#prof-spoilers');
  check('тумблер выключен', toggle.getAttribute('aria-checked'), 'false');
  toggle.click();
  check('после клика: body.spoilers', doc.body.classList.contains('spoilers'), true);
  check('после клика: aria-checked', toggle.getAttribute('aria-checked'), 'true');
  check('тумблер визуально включён (is-on)', toggle.classList.contains('is-on'), true);
  const saved = JSON.parse(window.localStorage.getItem('spoilers_local_v1'));
  check('настройка сохранена по id участника', saved, { [USER_ID]: true });

  // включены: подсказки чипов пустые, «моя оценка» — звёздочки
  doc.querySelector('#profile-back').click();
  await waitFor(() => visible().join() === 'view-home');
  await openFirstAlbum(doc, visible);
  const chips2 = [...doc.querySelectorAll('#av-chips .av__chip')];
  check('при спойлерах подсказки чипов пустые', chips2.length >= 2 && chips2.every((c) => c.title === ''), true);
  await backHome(doc, visible, 'view-album');

  await openFirstSingle(doc, visible);
  check('при спойлерах «моя оценка» — звёздочки', doc.querySelector('#sv-mine').textContent, '***');
  await backHome(doc, visible, 'view-single');

  // выключаем обратно
  doc.querySelector('#profile-btn').click();
  await waitFor(() => visible().join() === 'view-profile');
  doc.querySelector('#prof-spoilers').click();
  check('после выключения: body без класса', doc.body.classList.contains('spoilers'), false);
  check('после выключения: aria-checked', doc.querySelector('#prof-spoilers').getAttribute('aria-checked'), 'false');
  const savedOff = JSON.parse(window.localStorage.getItem('spoilers_local_v1'));
  check('выключение сохранено', savedOff, { [USER_ID]: false });

  check('ошибок страницы нет', pageErrors, []);
  dom.window.close();
}

async function scenarioPersistence() {
  console.log('сценарий: настройка переживает перезагрузку');
  const { dom, doc, visible, pageErrors } = await boot({
    spoilers_local_v1: JSON.stringify({ [USER_ID]: true }),
  });
  check('спойлеры подхватились при входе', doc.body.classList.contains('spoilers'), true);
  doc.querySelector('#profile-btn').click();
  await waitFor(() => visible().join() === 'view-profile');
  check('тумблер показывает включённое состояние', doc.querySelector('#prof-spoilers').getAttribute('aria-checked'), 'true');
  check('ошибок страницы нет', pageErrors, []);
  dom.window.close();
}

checkCssSelectors();
await scenarioToggleAndTitles();
await scenarioPersistence();
if (failures) {
  console.log(`\nПРОВАЛЕНО проверок: ${failures}`);
  process.exit(1);
}
console.log('\nВсе проверки спойлеров пройдены.');
