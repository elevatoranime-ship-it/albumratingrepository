import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { extractLyrics, extractLyricsDetailed, normalizeAnnotation, mapAnnRefs, domToHtml } from '../../worker.js';

/* Разбор страницы genius.com в текст песни — оба прокси (worker.js для Cloudflare,
   server.py для превью) на одной и той же разметке должны давать одинаковый чистый
   текст: без «шапки» Genius («6 Contributors», переводы, «<название> Lyrics»),
   без подвала («Embed») и с переносами строк на месте <br>. Плюс refs — какими
   строками покрыты аннотации — и нормализация тел аннотаций: обе стороны одинаковы.
   Браузер не нужен. */

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

/** Любое выражение над server.py с данными из stdin → JSON на выходе. */
function pyJson<T>(expr: string, payload: string): T {
  const script = 'import json, sys\nfrom server import extract_lyrics, extract_lyrics_detailed, normalize_annotation\nprint(json.dumps(' + expr + '))';
  const out = execFileSync('python3', ['-c', script], { cwd: path.resolve(__dirname, '..'), input: payload, encoding: 'utf8' });
  return JSON.parse(out) as T;
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

test('якоря аннотаций → refs: какие строки покрыты, текст без изменений', () => {
  // в PAGE аннотация 1 оборачивает строки 2–3 («Мои мувы жёсткие…» / «Твои суки…»)
  const detailed = extractLyricsDetailed(PAGE);
  expect(detailed.text).toBe(EXPECTED);
  expect(detailed.refs).toEqual([{ id: '1', lines: [2, 3] }]);
  expect(detailed.text).not.toContain('\u0000'); // маркеры не просачиваются в текст
  // паритет server.py — тот же {text, refs}
  expect(pyJson('extract_lyrics_detailed(sys.stdin.read())', PAGE))
    .toEqual({ text: detailed.text, refs: detailed.refs });
  // без якорей — refs пустые, extractLyrics как раньше
  const bare = '<div data-lyrics-container="true">[Intro]<br>Line</div>';
  expect(extractLyricsDetailed(bare).refs).toEqual([]);
  expect(extractLyrics(bare)).toBe('[Intro]\nLine');
});

test('аннотация на части строки и абсолютная ссылка Genius', () => {
  const html = '<div data-lyrics-container="true">Первая<br><a href="https://genius.com/annotations/42" class="Ref">вторая</a> половина<br>Третья</div>';
  const detailed = extractLyricsDetailed(html);
  expect(detailed.text).toBe('Первая\nвторая половина\nТретья');
  expect(detailed.refs).toEqual([{ id: '42', lines: [1] }]);
  expect(pyJson('extract_lyrics_detailed(sys.stdin.read())', html))
    .toEqual({ text: detailed.text, refs: detailed.refs });
});

test('нормализация аннотации одинакова в worker.js и server.py', () => {
  const fixture = {
    id: 777,
    url: 'https://genius.com/annotations/777',
    created_at: '2024-05-01T12:00:00Z',
    author: { name: 'Знаток', url: 'https://genius.com/znatok', image_url: 'https://images.genius.com/x.jpg' },
    body: {
      html: '<p>Абзац со <a href="https://genius.com/song-lyrics">ссылкой</a> и видео: <a href="https://www.youtube.com/watch?v=abc123def45">ютуб</a>.</p><img src="https://images.genius.com/pic.jpg" alt="картинка"/><img src="https://i.ytimg.com/vi/xyz789ghi012/hqdefault.jpg"/>',
      plain: 'текст',
    },
    votes_total: 12,
  };
  const fromWorker = normalizeAnnotation(fixture);
  expect(fromWorker.youtube).toEqual(['abc123def45', 'xyz789ghi012']);
  expect(fromWorker.author).toEqual({ name: 'Знаток', url: 'https://genius.com/znatok' });
  expect(fromWorker.html).toContain('images.genius.com/pic.jpg');
  expect(pyJson('normalize_annotation(json.loads(sys.stdin.read()))', JSON.stringify(fixture)))
    .toEqual(fromWorker);
  // без url/author — ссылка конструируется по id
  const bare = normalizeAnnotation({ id: 5, body: { html: '' } });
  expect(bare).toEqual({ id: '5', url: 'https://genius.com/annotations/5', author: null, created_at: null, html: '', youtube: [] });
  expect(pyJson('normalize_annotation(json.loads(sys.stdin.read()))', JSON.stringify({ id: 5, body: { html: '' } })))
    .toEqual(bare);
});

/* --- реальные данные Genius (сняты26.11.2026): api.genius.com referents +
   официальное тело аннотации + текст со снимка Wayback. Так проверяем новый
   путь прод-цепочки: страница genius.com с сервера закрыта (403), refs и тела
   берутся из официального API. */
const HUMBLE_TEXT = "[Intro]\nNobody pray for me\nIt been that day for me\nWay (Yeah, yeah)\n\n[Verse 1]\nAyy, I remember syrup sandwiches and crime allowances\nFinesse a nigga with some counterfeits, but now I'm countin\u2019 this\nParmesan where my accountant lives, in fact, I'm downin' this\nD\u2019uss\u00e9 with my boo bae, tastes like Kool-Aid for the analysts\nGirl, I can buy your ass the world with my paystub\nOoh, that pussy good, won't you sit it on my taste bloods?\nI get way too petty once you let me do the extras\nPull up on your block, then break it down, we playin' Tetris\nA.m. to the p.m., p.m. to the a.m., funk\nPiss out your per diem, you just gotta hate 'em, funk\nIf I quit your BM, I still ride Mercedes, funk\nIf I quit this season, I still be the greatest, funk\nMy left stroke just went viral\nRight stroke put lil' baby in a spiral\nSoprano C, we like to keep it on a high note\nIt's levels to it, you and I know\n\n[Chorus]\nBitch, be humble (Hold up, bitch)\nSit down (Hold up, lil'\u2014 hold up, lil' bitch)\nBe humble (Hold up, bitch)\nSit down (Hold up, sit down, lil\u2019\u2014 sit down, lil\u2019 bitch)\nBe humble (Hold up, hold up, hold up, hold up, lil' bitch)\nBitch, sit down (Hold up, lil\u2019 bitch)\nBe humble (Hold up, bitch)\nSit down (Hold up, hold up, hold up, hold up)\nBe humble (Hold up, hold up, hold up, hold up, lil'\u2014)\nSit down (Hold up, lil' bitch)\nBe humble (Hold up, bitch)\nSit down (Hold up, sit down, lil'\u2014 sit down, lil\u2019 bitch)\nBe humble (Hold up, hold up, hold up, hold up, lil' bitch)\nBitch, sit down (Hold up, lil' bitch)\nBe humble (Hold up, bitch)\nSit down (Hold up, hold up, hold up, hold up)\n\n[Verse 2]\nWho that nigga thinkin' that he frontin' on Man-Man? (Man-Man)\nGet the fuck off my stage, I'm the Sandman (Sandman)\nGet the fuck off my dick, that ain't right\nI make a play fucking up your whole life\nI'm so fuckin' sick and tired of the Photoshop\nShow me somethin' natural like afro on Richard Pryor\nShow me somethin' natural like ass with some stretch marks\nStill'll take you down right on your mama couch in Polo socks\nAyy, this shit way too crazy, ayy, you do not amaze me, ayy\nI blew cool from AC, ayy, Obama just paged me, ayy\nI don't fabricate it, ayy, most of y'all be fakin', ayy\nI stay modest 'bout it, ayy, she elaborate it, ayy\nThis that Grey Poupon, that Evian, that TED Talk, ayy\nWatch my soul speak, you let the meds talk, ayy\nIf I kill a nigga, it won't be the alcohol, ayy\nI'm the realest nigga after all\n\n[Chorus]\nBitch, be humble (Hold up, bitch)\nSit down (Hold up, lil'\u2014 hold up, lil' bitch)\nBe humble (Hold up, bitch)\nSit down (Hold up, sit down, lil'\u2014 sit down, lil' bitch)\nBe humble (Hold up, hold up, hold up, hold up, lil' bitch)\nBitch, sit down (Hold up, lil' bitch)\nBe humble (Hold up, bitch)\nSit down (Hold up, hold up, hold up, hold up)\nBe humble (Hold up, hold up, hold up, hold up, lil'\u2014)\nSit down (Hold up, lil' bitch)\nBe humble (Hold up, bitch)\nSit down (Hold up, sit down, lil'\u2014 sit down, lil' bitch)\nBe humble (Hold up, hold up, hold up, hold up, lil' bitch)\nBitch, sit down (Hold up, lil' bitch)\nBe humble (Hold up, bitch)\nSit down (Hold up, hold up, hold up, hold up)";
const HUMBLE_REFERENTS = [
 {
  "id": 11776682,
  "path": "/11776682/Kendrick-lamar-humble/Ooh-that-pussy-good-wont-you-sit-it-on-my-taste-bloods",
  "fragment": "Ooh, that pussy good, won’t you sit it on my taste bloods?",
  "range": {
   "content": "Ooh, that pussy good, won't you sit it on my taste bloods?"
  },
  "is_description": false,
  "annotations": [
   {
    "id": 11776682
   }
  ]
 },
 {
  "id": 11593217,
  "path": "/11593217/Kendrick-lamar-humble/Watch-my-soul-speak-you-let-the-meds-talk-ayy-if-i-kill-a-nigga-it-wont-be-the-alcohol-ayy-im-the-realest-nigga-after-all",
  "fragment": "Watch my soul speak, you let the meds talk, ayy\n If I kill a nigga, it won’t be the alcohol, ayy\n I’m the realest nigga after all",
  "range": {
   "content": "Watch my soul speak, you let the meds talk, ayy\n If I kill a nigga, it won't be the alcohol, ayy\n I'm the realest nigga after all"
  },
  "is_description": false,
  "annotations": [
   {
    "id": 11593217
   }
  ]
 },
 {
  "id": 11593050,
  "path": "/11593050/Kendrick-lamar-humble/Intro-nobody-pray-for-me-it-been-that-day-for-me-way-yeah-yeah",
  "fragment": "[Intro]\n Nobody pray for me\n It been that day for me\n Way (Yeah, yeah)",
  "range": {
   "content": "[Intro]\n Nobody pray for me\n It been that day for me\n Way (Yeah, yeah)"
  },
  "is_description": false,
  "annotations": [
   {
    "id": 11593050
   }
  ]
 },
 {
  "id": 11592958,
  "path": "/11592958/Kendrick-lamar-humble/Parmesan-where-my-accountant-lives-in-fact-im-downin-this-dusse-with-my-boo-bae-tastes-like-kool-aid-for-the-analysts",
  "fragment": "Parmesan where my accountant lives, in fact, I’m downin’ this\n D’ussé with my boo bae, tastes like Kool-Aid for the analysts",
  "range": {
   "content": "Parmesan where my accountant lives, in fact, I'm downin' this\n D'ussé with my boo bae, tastes like Kool-Aid for the analysts"
  },
  "is_description": false,
  "annotations": [
   {
    "id": 11592958
   }
  ]
 },
 {
  "id": 11592775,
  "path": "/11592775/Kendrick-lamar-humble/Girl-i-can-buy-your-ass-the-world-with-my-paystub",
  "fragment": "Girl, I can buy your ass the world with my paystub",
  "range": {
   "content": "Girl, I can buy your ass the world with my paystub"
  },
  "is_description": false,
  "annotations": [
   {
    "id": 11592775
   }
  ]
 },
 {
  "id": 11592646,
  "path": "/11592646/Kendrick-lamar-humble/Bitch-be-humble-hold-up-bitch-sit-down-hold-up-lil-hold-up-lil-bitch-be-humble-hold-up-bitch-sit-down-hold-up-sit-down-lil-sit-down-lil-bitch-be-humble-hold-up-hold-up-hold-up-hold-up-lil-bitch-bitch-sit-down-hold-up-lil-bitch-be-humble-hold-up-bitch-sit-down-hold-up-hold-up-hold-up-hold-up-be-humble-hold-up-hold-up-hold-up-hold-up-lil-sit-down-hold-up-lil-bitch-be-humble-hold-up-bitch-sit-down-hold-up-sit-down-lil-sit-down-lil-bitch-be-humble-hold-up-hold-up-hold-up-hold-up-lil-bitch-bitch-sit",
  "fragment": "Bitch, be humble (Hold up, bitch)\n Sit down (Hold up, lil’— hold up, lil’ bitch)\n Be humble (Hold up, bitch)\n Sit down (Hold up, sit down, lil’— sit down, lil’ bitch)\n Be humble (Hold up, hold up, hold up, hold up, lil’ bitch)\n Bitch, sit down (Hold up, lil’ bitch)\n Be humble (Hold up, bitch)\n Sit down (Hold up, hold up, hold up, hold up)\n Be humble (Hold up, hold up, hold up, hold up, lil’—)\n Sit down (Hold up, lil’ bitch)\n Be humble (Hold up, bitch)\n Sit down (Hold up, sit down, lil’— sit down, lil’ bitch)\n Be humble (Hold up, hold up, hold up, hold up, lil’ bitch)\n Bitch, sit down (Hold up, lil’ bitch)\n Be humble (Hold up, bitch)\n Sit down (Hold up, hold up, hold up, hold up)",
  "range": {
   "content": "Bitch, be humble (Hold up, bitch)\n Sit down (Hold up, lil'— hold up, lil' bitch)\n Be humble (Hold up, bitch)\n Sit down (Hold up, sit down, lil'— sit down, lil' bitch)\n Be humble (Hold up, hold up, hold up, hold up, lil' bitch)\n Bitch, sit down (Hold up, lil' bitch)\n Be humble (Hold up, bitch)\n Sit down (Hold up, hold up, hold up, hold up)\n Be humble (Hold up, hold up, hold up, hold up, lil'—)\n Sit down (Hold up, lil' bitch)\n Be humble (Hold up, bitch)\n Sit down (Hold up, sit down, lil'— sit down, lil' bitch)\n Be humble (Hold up, hold up, hold up, hold up, lil' bitch)\n Bitch, sit down (Hold up, lil' bitch)\n Be humble (Hold up, bitch)\n Sit down (Hold up, hold up, hold up, hold up)"
  },
  "is_description": false,
  "annotations": [
   {
    "id": 11592646
   }
  ]
 },
 {
  "id": 11592574,
  "path": "/11592574/Kendrick-lamar-humble/Verse-1-ayy-i-remember-syrup-sandwiches-and-crime-allowances-finesse-a-nigga-with-some-counterfeits-but-now-im-countin-this",
  "fragment": "[Verse 1]\n Ayy, I remember syrup sandwiches and crime allowances\n Finesse a nigga with some counterfeits, but now I’m countin’ this",
  "range": {
   "content": "[Verse 1]\n Ayy, I remember syrup sandwiches and crime allowances\n Finesse a nigga with some counterfeits, but now I'm countin' this"
  },
  "is_description": false,
  "annotations": [
   {
    "id": 11592574
   }
  ]
 },
 {
  "id": 11592561,
  "path": "/11592561/Kendrick-lamar-humble/I-get-way-too-petty-once-you-let-me-do-the-extras-pull-up-on-your-block-then-break-it-down-we-playin-tetris-am-to-the-pm-pm-to-the-am-funk",
  "fragment": "I get way too petty once you let me do the extras\n Pull up on your block, then break it down, we playin’ Tetris\n A.m. to the p.m., p.m. to the a.m., funk",
  "range": {
   "content": "I get way too petty once you let me do the extras\n Pull up on your block, then break it down, we playin' Tetris\n A.m. to the p.m., p.m. to the a.m., funk"
  },
  "is_description": false,
  "annotations": [
   {
    "id": 11592561
   }
  ]
 }
] as unknown as Array<Record<string, unknown>>;
const HUMBLE_ANNOTATION = {
 "api_path": "/annotations/35874550",
 "body": {
  "dom": {
   "tag": "root",
   "children": [
    {
     "tag": "p",
     "children": [
      "Kendrick is flexing his ability to shift the culture or dominate the game with a single move — a track, a verse, a decision.",
      {
       "tag": "br"
      },
      "When he “makes a play,” it’s not minor — it’s something that could undermine your whole career or identity, especially if you’re faking it or trying to compete with him."
     ]
    },
    "",
    {
     "tag": "p",
     "children": [
      "It’s both a warning and a power statement:"
     ]
    },
    "",
    {
     "tag": "p",
     "children": [
      "“I move with purpose, and my moves have real consequences — for me and for anyone in the way.”"
     ]
    }
   ]
  }
 },
 "comment_count": 1,
 "community": true,
 "custom_preview": null,
 "has_voters": true,
 "id": 35874550,
 "pinned": false,
 "share_url": "https://genius.com/35874550",
 "source": null,
 "state": "pending",
 "url": "https://genius.com/35874550/Kendrick-lamar-humble/I-make-a-play-fucking-up-your-whole-life",
 "verified": false,
 "votes_total": 5,
 "current_user_metadata": {
  "permissions": [],
  "excluded_permissions": [
   "vote",
   "edit",
   "cosign",
   "uncosign",
   "destroy",
   "accept",
   "reject",
   "see_unreviewed",
   "clear_votes",
   "propose_edit_to",
   "pin_to_profile",
   "unpin_from_profile",
   "update_source",
   "edit_custom_preview",
   "report_as_abusive",
   "create_comment"
  ],
  "interactions": {
   "cosign": false,
   "pyong": false,
   "vote": null
  },
  "iq_by_action": {}
 },
 "authors": [
  {
   "attribution": 1.0,
   "pinned_role": null,
   "user": {
    "api_path": "/users/23120751",
    "avatar": {
     "tiny": {
      "url": "https://images.genius.com/avatars/tiny/4e44bd87198f6acaa39eea13d31fc004",
      "bounding_box": {
       "width": 16,
       "height": 16
      }
     },
     "thumb": {
      "url": "https://images.genius.com/avatars/thumb/4e44bd87198f6acaa39eea13d31fc004",
      "bounding_box": {
       "width": 32,
       "height": 32
      }
     },
     "small": {
      "url": "https://images.genius.com/avatars/small/4e44bd87198f6acaa39eea13d31fc004",
      "bounding_box": {
       "width": 100,
       "height": 100
      }
     },
     "medium": {
      "url": "https://images.genius.com/avatars/medium/4e44bd87198f6acaa39eea13d31fc004",
      "bounding_box": {
       "width": 300,
       "height": 400
      }
     }
    },
    "header_image_url": "https://filepicker-images.genius.com/ee496405a64b1be3968d585278c2fbd265ba63e8e6429bee2f427d27e9c16e4a%2Fj7r1ou5503a",
    "human_readable_role_for_display": "Contributor",
    "id": 23120751,
    "login": "Coinz_101",
    "name": "Coinz_101",
    "role_for_display": "contributor",
    "url": "https://genius.com/Coinz_101",
    "current_user_metadata": {
     "permissions": [],
     "excluded_permissions": [
      "follow"
     ],
     "interactions": {
      "following": false
     }
    },
    "iq": 965
   }
  }
 ],
 "cosigned_by": [],
 "rejection_comment": null,
 "verified_by": null
} as unknown as Record<string, unknown>;

test('referents API: фрагмент → индексы строк (реальные данные HUMBLE.)', () => {
  const refs = mapAnnRefs(HUMBLE_REFERENTS, HUMBLE_TEXT) as Array<{ id: string; lines: number[] }>;
  expect(refs).toHaveLength(HUMBLE_REFERENTS.length); // каждый фрагмент находит себя
  const total = HUMBLE_TEXT.split('\n').length;
  for (const r of refs) {
    expect(r.lines.length).toBeGreaterThan(0);
    for (const l of r.lines) expect(l).toBeLessThan(total);
  }
  // мультистрочный фрагмент покрывает несколько строк
  const multi = refs.filter((r) => r.lines.length > 1);
  expect(multi.length).toBeGreaterThanOrEqual(2);
  // API отдаёт прямые кавычки, в тексте — типографские: всё равно находимся
  expect(refs.find((r) => r.id === '11592958')).toBeTruthy();
  // фрагмент, начинающийся с [Verse 1], занимает строки куплета
  const verse = refs.find((r) => r.id === '11592574');
  expect(verse!.lines.length).toBeGreaterThanOrEqual(3);
  // is_description не попадает в refs (в выборке их нет — проверяем и так)
  expect(mapAnnRefs([{ is_description: true, annotations: [{ id: 9 }], range: { content: 'x' } }], 'x')).toEqual([]);
  // источник недоступен / фрагмент не найден — тихо без refs
  expect(mapAnnRefs(null, HUMBLE_TEXT)).toEqual([]);
  expect(mapAnnRefs([], HUMBLE_TEXT)).toEqual([]);
});

test('официальный формат аннотации: body.dom → html, автор из authors', () => {
  const norm = normalizeAnnotation(HUMBLE_ANNOTATION);
  expect(norm.id).toBe('35874550');
  expect(norm.author).toEqual({ name: 'Coinz_101', url: 'https://genius.com/Coinz_101' });
  expect(norm.created_at).toBeNull(); // в официальном API поля нет
  expect(norm.url).toContain('/35874550/');
  expect(norm.html).toContain('<p>');
  expect(norm.html).toContain('<br>');
  expect(norm.youtube).toEqual([]);
  // санитайзер: неизвестные теги разворачиваются, ссылки — только http(s)
  expect(domToHtml({ tag: 'root', children: [{ tag: 'script', children: ['alert(1)'] }] })).toBe('alert(1)');
  expect(domToHtml({ tag: 'a', attributes: { href: 'javascript:x' }, children: ['y'] })).toBe('y');
  expect(domToHtml({ tag: 'a', attributes: { href: 'https://genius.com/a' }, children: ['y'] })).toBe('<a href="https://genius.com/a">y</a>');
  expect(domToHtml('a < b & c')).toBe('a &lt; b &amp; c');
  // вложения тела: https-img проходит, не-https молча отбрасывается
  expect(domToHtml({ tag: 'img', attributes: { src: 'https://images.genius.com/x.png', alt: 'd' } }))
    .toBe('<img src="https://images.genius.com/x.png" alt="d">');
  expect(domToHtml({ tag: 'img', attributes: { src: 'javascript:x' } })).toBe('');
});
