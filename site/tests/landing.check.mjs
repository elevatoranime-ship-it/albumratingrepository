#!/usr/bin/env node
/** Обзор-лендинг: структура первого экрана, стили и поведение в jsdom. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const configJs = readFileSync(path.join(root, 'config.js'), 'utf8');
const appJs = readFileSync(path.join(root, 'app.js'), 'utf8');
const appSource = readFileSync(path.join(root, 'app.ts'), 'utf8');
const stylesCss = readFileSync(path.join(root, 'styles.css'), 'utf8');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}: ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
  }
}
function waitFor(fn, timeout = 8000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = fn(); } catch { /* ждём дальше */ }
      if (ok) resolve();
      else if (Date.now() - t0 > timeout) reject(new Error(`waitFor: таймаут (${timeout} мс)`));
      else setTimeout(tick, 30);
    };
    tick();
  });
}

/* --- статика --- */
console.log('проверка: статика лендинга');
check('экран есть и виден по умолчанию',
  html.includes('class="view view--landing is-visible" id="view-landing"'), true);
check('отдельного экрана входа больше нет', html.includes('view-login'), false);
check('карточка входа — внутри последней секции',
  /id="lp-enter"[\s\S]*id="card"[\s\S]*id="submit-btn"/.test(html), true);
check('шесть секций обзора', (html.match(/class="lp__sec/g) ?? []).length, 6);
check('навигация, прогресс и переходы',
  ['data-lp-scroll="lp-enter"', 'data-lp-scroll="lp-collection"', 'id="lp-progress"'].every((s) => html.includes(s)), true);
check('viewLogin заменён на viewLanding',
  appSource.includes('viewLanding') && !appSource.includes('viewLogin'), true);
check('поведение: прогресс, плавный скролл, IO-гард, въезд карточки',
  ['#lp-progress', "'IntersectionObserver' in window", 'data-lp-scroll', 'playCardEnter'].every((s) => appSource.includes(s)), true);
check('стили: fixed-скролл и reduce-motion',
  ['.view--landing', 'prefers-reduced-motion'].every((s) => stylesCss.includes(s)), true);
check('секции без sticky-перекрытия (естественный скролл)',
  /\.lp__sec\s*\{[^}]*position:\s*sticky/.test(stylesCss), false);
check('секции обычным потоком: 100dvh и разделение линией',
  [/\.lp__sec\s*\{[^}]*min-height:\s*100dvh/, /\.lp__sec \+ \.lp__sec \{ border-top:/].every((re) => re.test(stylesCss)), true);
check('стили: навигация и прогресс выше секций',
  [/\.lp__nav\s*\{[^}]*z-index:\s*55/, /\.lp__progress\s*\{[^}]*z-index:\s*60/].every((re) => re.test(stylesCss)), true);
check('плотный контент: полка, вкладки, пилюли, статистика',
  ['lp-shelf', 'lp-tabs', 'lp__pills', 'lp__stats'].every((s) => html.includes(s)), true);
const prose = html.replace(/<title>[\s\S]*?<\/title>/, '').replace(/aria-label="[^"]*"/g, '');
check('слово на странице — ровно один раз (логотип)', (prose.match(/пространство/gi) ?? []).length, 1);

/* --- поведение --- */
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
      window.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({}),
        text: async () => '{}',
      });
    },
  });
  const { window } = dom;
  const doc = window.document;
  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(e.message));

  window.eval(configJs);
  window.eval(appJs);
  await waitFor(() => {
    const hint = doc.querySelector('#demo-hint');
    return Boolean(hint && !hint.hidden && hint.textContent.includes('демо-режим'));
  }, 10000);
  return { window, doc, pageErrors };
}

console.log('сценарий: первый экран');
const { window, doc, pageErrors } = await boot();

check('виден именно лендинг',
  [...doc.querySelectorAll('.view.is-visible')].map((v) => v.id), ['view-landing']);
check('карточка входа на месте', Boolean(doc.querySelector('#view-landing #card #submit-btn')), true);
check('секции на месте', doc.querySelectorAll('#view-landing .lp__sec').length, 6);
check('hero-кнопки есть', doc.querySelectorAll('[data-lp-scroll]').length >= 3, true);

doc.querySelector('.lp__login-link').click();
doc.querySelector('[data-lp-scroll="lp-collection"]').click();
check('клики по переходам без ошибок', pageErrors, []);

if (failures) {
  console.log(`\nПРОВЕРЕНО с ошибками: ${failures}`);
  process.exitCode = 1;
} else {
  console.log('\nВсе проверки лендинга пройдены.');
}
// jsdom держит таймеры приложения — выходим явно
process.exit(process.exitCode ?? 0);
