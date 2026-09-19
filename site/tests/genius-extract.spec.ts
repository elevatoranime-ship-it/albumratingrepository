import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { extractLyrics } from '../../worker.js';

/* Разбор страницы genius.com в текст песни — оба прокси (worker.js для Cloudflare,
   server.py для превью) на одной и той же разметке должны давать одинаковый чистый
   текст: без «шапки» Genius («6 Contributors», переводы, «<название> Lyrics»),
   без подвала («Embed») и с переносами строк на месте <br>. Браузер не нужен. */

const TITLE = 'z4p7sk4yu v n33 sv0j $$$';

/* Разметка повторяет реальную страницу: шапка лежит ВНУТРИ первого блока
   data-lyrics-container (data-exclude-from-selection + LyricsHeader__…),
   между блоками — рекламный слот, пустой блок; подвал — в последнем блоке. */
const PAGE = `<!doctype html><html><head><title>5mewmet &amp; gibbl3 – ${TITLE} Lyrics | Genius Lyrics</title>
<style data-styled="true">.LyricsHeader__Container-sc-5e4b7146-1{display:flex}.Lyrics__Container-sc-926d9e10-1{font-size:1rem}</style>
</head><body><div class="Lyrics__Root-sc-926d9e10-0">
<div data-lyrics-container="true" class="Lyrics__Container-sc-926d9e10-1 fEHzCI"><div data-exclude-from-selection="true" class="LyricsHeader__Container-sc-5e4b7146-1 hFsUgC"><div class="LyricsHeader__Contributors-sc-5e4b7146-2"><div class="ContributorsCreditSong__Label-sc-1d74f5a9-1"><span>6 Contributors</span></div><div class="LyricsHeader__Translations-sc-5e4b7146-3"><button>Translations</button><a href="/t/es">Español</a><a href="/t/pt">Português</a></div></div><h2 class="LyricsHeader__Title-sc-5e4b7146-6">${TITLE} Lyrics</h2></div>[Текст песни «${TITLE}»]<br>[Интро]<br><a href="/annotations/1" class="ReferentFragmentdesktop__ClickTarget-sc-1c7d0ad7-0"><span class="ReferentFragmentdesktop__Highlight-sc-1c7d0ad7-1">Мои мувы жёсткие, а твои дешёвки<br>Твои суки смотрят на мою машонку</span></a><br>Мои мувы жёсткие, а твои не очень<br>Она хочет больше, она хочет в ротик<br><br>[Бридж]<br>И поэтому я запускаю в неё свой—<br>И поэтому я запускаю в неё свой—</div>
<div class="InreadAd__Container-sc-1e5b7f0e-0"><div data-exclude-from-selection="true"><span>ad slot</span></div></div>
<div data-lyrics-container="true" class="Lyrics__Container-sc-926d9e10-1 fEHzCI"></div>
<div data-lyrics-container="true" class="Lyrics__Container-sc-926d9e10-1 fEHzCI">[Дроп]<br>(<i>Don't stop!</i>)<br>(<i>Don't—</i>)<br>И поэ—<br>Она хочет больше, она хочет в рот—<div class="LyricsFooter__Container-sc-4f32c8e2-0" data-exclude-from-selection="true"><div class="LyricsFooter__Pyongs">4</div><a class="LyricsFooter__Embed">Embed</a></div></div>
</div><script>window.__PRELOADED_STATE__ = JSON.parse('{"x":"data-exclude-from-selection=\\\\"true\\\\" внутри строки скрипта"}');</script></body></html>`;

const EXPECTED = [
  `[Текст песни «${TITLE}»]`,
  '[Интро]',
  'Мои мувы жёсткие, а твои дешёвки',
  'Твои суки смотрят на мою машонку',
  'Мои мувы жёсткие, а твои не очень',
  'Она хочет больше, она хочет в ротик',
  '',
  '[Бридж]',
  'И поэтому я запускаю в неё свой—',
  'И поэтому я запускаю в неё свой—',
  '',
  '[Дроп]',
  "(Don't stop!)",
  "(Don't—)",
  'И поэ—',
  'Она хочет больше, она хочет в рот—',
].join('\n');

/* Тот же разбор в server.py — импортируем функцию, сервер при импорте не стартует. */
function extractWithPython(html: string): string {
  const script = 'import json, sys\nfrom server import extract_lyrics\nprint(json.dumps(extract_lyrics(sys.stdin.read())))';
  const out = execFileSync('python3', ['-c', script], { cwd: path.resolve(__dirname, '..'), input: html, encoding: 'utf8' });
  return JSON.parse(out) as string;
}

test('страница Genius → чистый текст: без шапки «Contributors … Lyrics» и подвала, одинаково в worker.js и server.py', () => {
  const fromWorker = extractLyrics(PAGE);
  expect(fromWorker).toBe(EXPECTED);
  expect(fromWorker.startsWith(`[Текст песни «${TITLE}»]`)).toBe(true);
  expect(fromWorker).not.toMatch(/Contributors|Translations|Embed|ad slot/);
  expect(extractWithPython(PAGE)).toBe(fromWorker);
});

test('страховка: шапка без своих атрибутов и классов всё равно срезается по тексту', () => {
  // разметка изменилась — ни data-exclude-from-selection, ни LyricsHeader__ нет,
  // а шапка склеена с первой строкой, как было видно в панели: «6 Contributors…Lyrics[Текст…»
  const glued = `<div data-lyrics-container="true"><span>6 Contributors</span><span>${TITLE} Lyrics</span>[Текст песни «${TITLE}»]<br>[Интро]<br>Мои мувы</div>`;
  const expected = `[Текст песни «${TITLE}»]\n[Интро]\nМои мувы`;
  expect(extractLyrics(glued)).toBe(expected);
  expect(extractWithPython(glued)).toBe(expected);

  // блочная шапка с переводами и названием, в котором есть слово Lyrics
  const blocks = '<div data-lyrics-container="true"><div class="Xyz"><div>2 Contributors</div><div>Translations</div><div>Español</div><h2>Lyrics [Live] Lyrics</h2></div>[Verse]<br>Line one</div>';
  expect(extractLyrics(blocks)).toBe('[Verse]\nLine one');
  expect(extractWithPython(blocks)).toBe('[Verse]\nLine one');
});

test('обычный текст не трогаем: маркеры в словах песни, старая разметка без шапки', () => {
  const plain = '<div data-lyrics-container="true">[Intro]<br>she said data-exclude-from-selection="true" to me<br>and class="LyricsHeader__ too</div><div data-lyrics-container="true">[Chorus]<br>La la</div>';
  const expected = '[Intro]\nshe said data-exclude-from-selection="true" to me\nand class="LyricsHeader__ too\n[Chorus]\nLa la';
  expect(extractLyrics(plain)).toBe(expected);
  expect(extractWithPython(plain)).toBe(expected);
  expect(extractLyrics('<html><body>no lyrics here</body></html>')).toBe('');
});
