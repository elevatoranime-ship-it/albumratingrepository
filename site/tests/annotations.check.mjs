/* Проверка аннотаций Genius на jsdom — работает без браузера:
     node tests/annotations.check.mjs   (npm run test:annotations)
   Что проверяем:
     1) статика: прокси /api/genius/annotations есть в worker.js и server.py,
        lyrics-маршруты отдают refs, карточка и подсветка собраны в
        index.html/styles.css, санитайзер и YouTube-iframe в app.ts;
     2) поведение: запомненный трек открывает текст, строки из refs
        подсвечиваются, клик открывает карточку (цитата, автор, тело без
        script, картинка, ссылка, iframe YouTube), × закрывает.
   Браузерный прогон (desktop + mobile) — tests/genius-lyrics.spec.ts в CI. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const configJs = readFileSync(path.join(root, 'config.js'), 'utf8');
const appJs = readFileSync(path.join(root, 'app.js'), 'utf8');
const stylesCss = readFileSync(path.join(root, 'styles.css'), 'utf8');
const appSource = readFileSync(path.join(root, 'app.ts'), 'utf8');
const workerJs = readFileSync(path.join(root, '..', 'worker.js'), 'utf8');
const serverPy = readFileSync(path.join(root, 'server.py'), 'utf8');
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

console.log('проверка: статика аннотаций');
check('worker: маршрут /api/genius/annotations', workerJs.includes("'/api/genius/annotations'"), true);
check('worker: разбор возвращает refs', workerJs.includes('extractLyricsDetailed') && workerJs.includes('refs: refs.length ? refs : detailed.refs'), true);
check('worker: нормализация аннотации экспортирована', workerJs.includes('export function normalizeAnnotation'), true);
check('worker: текст — Wayback при403, refs — официальный referents API',
  ['waybackHtml', 'id_/', 'geniusReferents', 'mapAnnRefs'].every((s) => workerJs.includes(s)), true);
check('worker: тело аннотации — api.genius.com + body.dom → html',
  ['api.genius.com/annotations', 'domToHtml'].every((s) => workerJs.includes(s)), true);
check('server: маршрут /api/genius/annotations', serverPy.includes('/api/genius/annotations'), true);
check('server: lyrics-ответ содержит refs', serverPy.includes('"refs": refs or detailed["refs"]'), true);
check('server: normalize_annotation зеркалит worker', serverPy.includes('def normalize_annotation'), true);
check('server: текст — Wayback при403, refs — referents API (паритет worker)',
  ['fetch_lyrics_html', 'wayback_html', 'id_/', 'map_ann_refs', 'dom_to_html'].every((s) => serverPy.includes(s)), true);
check('server: аннотация из api.genius.com', serverPy.includes('api.genius.com/annotations'), true);
// вложения в теле: img из body.dom раньше выпадал из allowlist и пропадал без следа
check('worker: img в allowlist тела и ветка https-src',
  workerJs.includes("'img',") && workerJs.includes("tag === 'img'") && workerJs.includes('node.attributes.src'), true);
check('server: img в allowlist тела и ветка https-src (паритет)',
  serverPy.includes('"img",') && serverPy.includes('tag == "img"') && serverPy.includes('attrs.get("src")'), true);
const workerAnnImg = execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { normalizeAnnotation } from './worker.js';` +
  `console.log(normalizeAnnotation({body:{dom:{tag:'root',children:[{tag:'p',children:['текст']},{tag:'img',attributes:{src:'https://images.genius.com/8729fd8f6449d7fdca95631f6e603116.379×379×1.png'}},{tag:'img',attributes:{src:'javascript:x'}}]}}}).html)`,
], { cwd: path.join(root, '..') }).toString();
check('worker: https-img из body.dom доходит до html, javascript — нет',
  workerAnnImg.includes('<img src="https://images.genius.com/8729fd8f6449d7fdca95631f6e603116.379×379×1.png"') && !workerAnnImg.includes('javascript:'), true);
const serverAnnImg = execFileSync('python3', ['-c',
  'from server import dom_to_html; print(dom_to_html({"tag":"root","children":[{"tag":"p","children":["текст"]},{"tag":"img","attributes":{"src":"https://images.genius.com/8729fd8f6449d7fdca95631f6e603116.379×379×1.png"}},{"tag":"img","attributes":{"src":"javascript:x"}}]}))',
], { cwd: root }).toString();
check('server: https-img из body.dom доходит до html, javascript — нет',
  serverAnnImg.includes('<img src="https://images.genius.com/8729fd8f6449d7fdca95631f6e603116.379×379×1.png"') && !serverAnnImg.includes('javascript:'), true);
check('server: макет --mock-genius для превью без сети', serverPy.includes('--mock-genius') && serverPy.includes('MOCK_LYRICS_HTML'), true);
check('server: макетные аннотации идут через normalize_annotation', serverPy.includes('normalize_annotation(raw)'), true);
check('разметка: карточки на обоих экранах', ['id="lyrics-ann"', 'id="vinyl-ann"', 'id="lyrics-body"', 'id="vinyl-textwrap"'].every((s) => html.includes(s)), true);
check('разметка: затемнение-скрим на обоих экранах', (html.match(/ann-scrim/g) ?? []).length >= 4, true); // class+id ×2 экрана
check('стили: скрим скрыт вне шторки', stylesCss.includes('.lyrics__ann-scrim { display: none; }'), true);
check('стили: мобильная шторка объявлена ПОСЛЕ базовой раскладки', stylesCss.indexOf('ann-sheet') > stylesCss.indexOf('.lyrics__body.is-ann {'), true);
// мобильная шторка обязана снимать базовый inset-top: иначе top:0 + max-height
// прижимает лист к верху экрана (CI: панель перехватывает клик по затемнению)
const mobileSheetRule = stylesCss.match(/\.lyrics__body\.is-ann \.lyrics__ann \{[^}]*position: fixed[^}]*\}/);
check('стили: мобильная шторка bottom-anchored (top: auto)', Boolean(mobileSheetRule && mobileSheetRule[0].includes('top: auto')), true);
check('стили: шторка учитывает safe-area iPhone', stylesCss.includes('env(safe-area-inset-bottom)'), true);
check('стили: подсветка, раскладка, iframe', ['.lyrics__line.is-ref', '.lyrics__body.is-ann', '.lyrics__ann-body iframe'].every((s) => stylesCss.includes(s)), true);
check('стили: группа строк — единый блок (края, hover, рамка активности)',
  ['is-ref-first', 'is-ref-last', 'is-hover'].every((s) => stylesCss.includes(s)), true);
check('стили: у карточки нет display через [hidden]', !/\.lyrics__ann\s*\{[^}]*display\s*:/.test(stylesCss), true);
check('клиент: санитайзер и YouTube', ['GENIUS_ANN_KEEP', 'youtube-nocookie.com/embed', 'geniusAnnSanitize', 'geniusAnnImageSrc', 'filepicker-images.genius.com'].every((s) => appSource.includes(s)), true);
// без клинапа Chrome оставляет identity-матрицу reveal-анимации — секция
// становится containing block для fixed-шторки и обрезает её overflow'ом
check('клиент: reveal снимается после анимации rise/riseSoft (нет вечного fixed-CB)',
  appSource.includes("ev.animationName === 'rise'") && appSource.includes("'riseSoft'"), true);

/* --- поведение --- */

const LYRICS_TEXT = 'Раз\nДва\nТри\nТри\nТри';
const annFixture = {
  id: 555,
  url: 'https://genius.com/annotations/555',
  author: { name: 'Знаток', url: 'https://genius.com/znatok' },
  created_at: '2024-05-01T12:00:00Z',
  html: '<p>Это <b>аннотация</b> со <a href="https://genius.com/annotated-song-lyrics">ссылкой</a>.</p>'
    + '<img src="https://images.genius.com/pic.jpg" alt="картинка"/>'
    // вложение genius-CDN: в body приходит ссылкой — карточка показывает картинкой
    + '<a href="https://filepicker-images.genius.com/f0b42d309c89a7fd2dc9d87d18a52225ddb601db51a5aad98857cff9a15ded3%2Fac9am38xyy6">https://filepicker-images.genius.com/f0b42d309c89a7fd2dc9d87d18a52225ddb601db51a5aad98857cff9a15ded3%2Fac9am38xyy6</a>'
    + '<a href="https://www.youtube.com/watch?v=abc123def45"><img src="https://i.ytimg.com/vi/abc123def45/hqdefault.jpg" alt=""/></a>'
    + '<script>alert(1)</script>',
  youtube: ['abc123def45'],
};

const album = {
  id: 'ann-album', artist: 'Артист', title: 'Альбом с аннотациями', year: 2025,
  cover: '', tracksLocked: true, cohesion: 2, albumType: 'album',
  kind: 'album', parentId: null, geniusId: null,
};
const track = {
  id: 'track-1', albumId: album.id, title: 'Первый трек', position: 0,
  locked: true, featArtist: null, singleId: null, geniusId: '9001', // запомненная песня — без поиска
};

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
      // прокси Genius — фикстуры, настоящий Genius не вызывается
      const jsonResponse = (data, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
        text: async () => JSON.stringify(data),
      });
      window.fetch = async (input) => {
        const u = String(input);
        if (u.includes('/api/genius/lyrics')) {
          return jsonResponse({ song: {
            id: 9001, title: 'Первый трек', artist: 'Артист',
            url: 'https://genius.com/song-9001', lyrics_state: 'complete',
            text: LYRICS_TEXT, refs: [{ id: '555', lines: [1, 2] }],
          } });
        }
        if (u.includes('/api/genius/annotations')) return jsonResponse({ annotation: annFixture });
        if (u.includes('/api/genius/search')) return jsonResponse({ response: { hits: [] } });
        throw new Error(`неожиданный fetch: ${u}`);
      };
      window.localStorage.setItem('albums_local_v1', JSON.stringify([album]));
      window.localStorage.setItem('tracks_local_v1', JSON.stringify([track]));
      window.localStorage.setItem('track_ratings_local_v1', JSON.stringify({}));
      window.localStorage.setItem('single_ratings_local_v1', JSON.stringify({}));
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

  doc.querySelector('#email-input').value = 'killmiplag@demo.local';
  doc.querySelector('#password').value = 'demo';
  doc.querySelector('#submit-btn').click();
  await waitFor(() => [...doc.querySelectorAll('.view.is-visible')].map((v) => v.id).join() === 'view-home');
  return { window, doc, pageErrors };
}

async function scenario() {
  console.log('сценарий: подсветка строк, карточка, закрытие');
  const { window, doc, pageErrors } = await boot();

  doc.querySelector('#albums .album__title').click();
  await waitFor(() => [...doc.querySelectorAll('.view.is-visible')].map((v) => v.id).join() === 'view-album');
  doc.querySelector('[data-id="track-1"] .track__genius').click();

  await waitFor(() => doc.querySelectorAll('#lyrics-text .lyrics__line.is-ref').length === 2);
  const refs = [...doc.querySelectorAll('#lyrics-text .lyrics__line.is-ref')];
  check('подсвечено ровно две строки', refs.length, 2);
  check('подсвеченные строки — «Два» и «Три»', refs.map((el) => el.textContent), ['Два', 'Три']);
  check('строки доступны с клавиатуры', refs.every((el) => el.getAttribute('role') === 'button' && el.getAttribute('tabindex') === '0'), true);
  check('остальные строки не подсвечены', doc.querySelectorAll('#lyrics-text .lyrics__line:not(.is-ref)').length, 3);
  // многострочная аннотация — единым блоком: края группы и сквозной hover
  const refEls = [...doc.querySelectorAll('#lyrics-text .lyrics__line.is-ref')];
  check('группа: первая строка — край снизу', refEls[0].classList.contains('is-ref-first') && !refEls[0].classList.contains('is-ref-last'), true);
  check('группа: последняя строка — край сверху', refEls[1].classList.contains('is-ref-last') && !refEls[1].classList.contains('is-ref-first'), true);
  refEls[0].dispatchEvent(new window.MouseEvent('mouseenter'));
  check('группа: наведение подсвечивает все строки', refEls.every((el) => el.classList.contains('is-hover')), true);
  refEls[1].dispatchEvent(new window.MouseEvent('mouseleave'));
  check('группа: уход снимает подсветку со всех', refEls.some((el) => el.classList.contains('is-hover')), false);

  refs[0].click();
  const ann = doc.querySelector('#lyrics-ann');
  check('карточка открыта', ann.hidden, false);
  check('раскладка текст | карточка', doc.querySelector('#lyrics-body').classList.contains('is-ann'), true);
  const quote = ann.querySelector('.lyrics__ann-quote');
  check('цитата — точные строки аннотации', Boolean(quote && quote.textContent.includes('Два') && quote.textContent.includes('Три')), true);
  check('автор в мета', ann.querySelector('.lyrics__ann-meta').textContent.includes('Знаток'), true);
  check('тело: жирный остался', ann.querySelector('.lyrics__ann-body b')?.textContent, 'аннотация');
  check('тело: script выброшен', ann.querySelector('.lyrics__ann-body script'), null);
  check('тело: ссылка https осталась', Boolean(ann.querySelector('.lyrics__ann-body a[href="https://genius.com/annotated-song-lyrics"]')), true);
  check('тело: картинка с CDN', ann.querySelector('.lyrics__ann-body img')?.getAttribute('src'), 'https://images.genius.com/pic.jpg');
  // ссылка-вложение genius-CDN (filepicker, без расширения) — картинкой, не URL-текстом
  check('тело: ссылка-картинка стала <img>',
    Boolean(ann.querySelector('.lyrics__ann-body img[src^="https://filepicker-images.genius.com/"]')), true);
  check('тело: без ссылки-URL вместо картинки', ann.querySelector('.lyrics__ann-body a[href^="https://filepicker"]'), null);
  check('YouTube — iframe в карточке', ann.querySelector('.lyrics__ann-body iframe')?.getAttribute('src'), 'https://www.youtube-nocookie.com/embed/abc123def45');
  check('ссылка на аннотацию', ann.querySelector('.lyrics__ann-link')?.getAttribute('href'), 'https://genius.com/annotations/555');
  check('открытая строка активна', refs[0].classList.contains('is-active'), true);

  // закрытие кликом по тексту, как на Genius: тумблер по строке + обычный текст
  refs[1].click();
  check('повторный клик по строке той же аннотации закрывает', ann.hidden, true);
  refs[0].click();
  check('переоткрытие по строке работает', ann.hidden, false);
  doc.querySelector('#lyrics-text .lyrics__line:not(.is-ref)').click();
  check('клик по обычному тексту закрывает аннотацию', ann.hidden, true);
  refs[0].click();
  check('аннотация открыта для проверки ×', ann.hidden, false);

  ann.querySelector('.lyrics__ann-close').click();
  check('карточка закрыта', ann.hidden, true);
  check('раскладка сброшена', doc.querySelector('#lyrics-body').classList.contains('is-ann'), false);
  check('активность снята', refs[0].classList.contains('is-active'), false);

  // закрытие затемнением (мобильная шторка): клик по scrim рядом с карточкой
  refs[1].click();
  check('шторка открылась повторно', ann.hidden, false);
  doc.querySelector('#lyrics-ann-scrim').click();
  check('тап по затемнению закрывает карточку', ann.hidden, true);
  check('после затемнения раскладка сброшена', doc.querySelector('#lyrics-body').classList.contains('is-ann'), false);
  check('ошибок страницы нет', pageErrors, []);
}

await scenario();
if (failures) {
  console.log(`\nПРОВАЛЕНО проверок: ${failures}`);
} else {
  console.log('\nВсе проверки аннотаций пройдены.');
}
// jsdom держит таймеры приложения — выходим явно
process.exit(failures ? 1 : 0);
