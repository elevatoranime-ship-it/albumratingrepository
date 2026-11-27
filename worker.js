/**
 * Пространство · серверный прокси Genius.
 *
 * Сайт работает как Workers Static Assets, а этот скрипт обслуживает только
 * /api/genius/* — остальное отдаёт статика (env.ASSETS). Он нужен потому, что:
 *   1) официальный Genius API не отдаёт сам текст песни — его приходится
 *      доставать со страницы genius.com, которая из браузера нечитаема (CORS);
 *   2) токен Genius должен жить на сервере, а не в коде страницы.
 *
 * Эндпоинты:
 *   GET /api/genius/search?q=…   → поиск песен (прозрачный прокси api.genius.com)
 *   GET /api/genius/lyrics?id=…  → текст песни: { song: { title, artist, url,
 *                                   lyrics_state, text, refs } } — refs: какие
 *                                   строки (индексы) покрыты аннотациями и их id
 *   GET /api/genius/annotations?id=… → аннотация: { annotation: { id, url,
 *                                   author, created_at, html, youtube } } —
 *                                   тело берётся из JSON, которым пользуется
 *                                   сам сайт genius.com/api/annotations/:id
 *
 * Ответы кэшируются (Cache API): поиск на 10 минут, текст и аннотации на сутки.
 * Токен можно задать секретом `wrangler secret put GENIUS_TOKEN`;
 * по умолчанию используется вшитый клиентский токен (только чтение).
 */

const GENIUS_TOKEN_FALLBACK = '0bdmXdOU1UaPikappqvWfrpwrpxkB3HczT2xlouY9vliFGTXSahE6jOVSwAaosGP';
/** Версия разбора текста (extractLyrics) — входит в ключ кэша /lyrics; повышать при правках разбора. */
const LYRICS_PARSER_VERSION = 3;
/** Версия нормализации аннотации — входит в ключ кэша /annotations. */
const ANN_FORMAT_VERSION = 1;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'content-type': 'application/json; charset=utf-8',
};

const json = (body, status = 200, cache = null) =>
  new Response(JSON.stringify(body), { status, headers: cache ? { ...CORS, 'cache-control': cache } : CORS });

/** Кэш-обёртка: ключ → (Cache API, указанный TTL). */
async function cached(request, ttl, produce) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await produce();
  if (response.status === 200) {
    const stored = response.clone();
    stored.headers.append('cache-control', `public, max-age=${ttl}`);
    await cache.put(request, stored);
  }
  return response;
}

async function geniusFetch(url) {
  const response = await fetch(url, {
    // Токен передаётся ТОЛЬКО параметром access_token в URL (см. вызовы ниже):
    // с заголовком Authorization Genius отвечает на такой токен ошибкой 400.
    headers: { 'user-agent': UA, 'accept': 'application/json' },
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 150);
    throw new Error(`Genius API ответил ${response.status}${body ? `: ${body}` : ''}`);
  }
  return response.json();
}

/* Внутри первого блока data-lyrics-container Genius держит «шапку» — счётчик
   «6 Contributors», переводы и заголовок «<название> Lyrics» (div с атрибутом
   data-exclude-from-selection="true", класс LyricsHeader__Container-…); в конце
   последнего блока может лежать такой же подвал (LyricsFooter__…, «Embed»).
   Всё это вырезается из разметки до снятия тегов — иначе текст начинался бы
   с «6 Contributorsназвание Lyrics[Текст песни …]». */
const LYRICS_CHROME_RE = /data-exclude-from-selection="true"|class="[^"]*\bLyrics(?:Header|Footer)__/i;
/* Блочные теги превращаются в перенос строки, чтобы соседние блоки не
   склеивались в одну строку (внутри самого текста песни только <br>, <a>, <i>, <b>). */
const BLOCK_TAG_RE = /<\/?(?:div|p|h[1-6]|section|header|footer|ul|ol|li|blockquote)\b[^>]*>/gi;
/* Страховка на случай, если разметка шапки изменится и она всё же дойдёт до
   текста: «6 Contributors … <название> Lyrics» в самом начале. */
const LYRICS_HEADER_TEXT_RE = /^\d+\s*Contributors?[\s\S]*?\bLyrics\b(?=[ \t]*\n|\[)/i;
/* Пустые элементы HTML — без закрывающего тега. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Вырезает из фрагмента элемент (со всем содержимым), внутри открывающего тега
    которого стоит позиция `at`. Возвращает null, если `at` не внутри тега. */
function cutElementAt(html, at) {
  const tagStart = html.lastIndexOf('<', at);
  const tagEnd = html.indexOf('>', at);
  if (tagStart === -1 || tagEnd === -1 || html.lastIndexOf('>', at) > tagStart) return null;
  const name = /^<([a-z][\w-]*)/i.exec(html.slice(tagStart, tagEnd))?.[1]?.toLowerCase();
  if (!name) return null;
  let end = tagEnd + 1;
  if (!VOID_TAGS.has(name) && html[tagEnd - 1] !== '/') {
    const tags = new RegExp(`<(/?)${name}(?=[\\s/>])`, 'gi');
    tags.lastIndex = end;
    end = html.length; // незакрытый элемент — до конца фрагмента
    let depth = 1;
    for (let m = tags.exec(html); m; m = tags.exec(html)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        const close = html.indexOf('>', m.index);
        end = close === -1 ? html.length : close + 1;
        break;
      }
    }
  }
  return { html: html.slice(0, tagStart) + html.slice(end), start: tagStart };
}

/** Удаляет из фрагмента все элементы, в открывающем теге которых встречается `pattern`. */
function dropElements(html, pattern) {
  const re = new RegExp(pattern.source, 'gi');
  let out = html;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const cut = cutElementAt(out, m.index);
    if (!cut) continue; // совпадение не в теге — идём дальше
    out = cut.html;
    re.lastIndex = cut.start;
  }
  return out;
}

/** Открывающий тег аннотации → маркеры: \u0000ID\u0000 … \u0000/\u0000.
    Маркеры переживают снятие тегов и превращение <br> в \n — по ним после
    разбора видно, какими строками текста покрыта каждая аннотация. Поддерживаются
    и относительные (/annotations/1), и абсолютные (genius.com/annotations/1)
    ссылки Genius. */
const ANN_ANCHOR_RE = /(<a\b[^>]*\bhref="(?:https?:\/\/(?:www\.)?genius\.com)?\/annotations\/(\d+)"[^>]*>)([\s\S]*?)(<\/a>)/gi;
const ANN_TOKEN_RE = /\u0000[^\u0000]*\u0000/g;

/** Собирает, какими строками финального текста (индексы с нуля) покрыта каждая
    аннотация: \u0000ID\u0000 открывает охват, \u0000/\u0000 закрывает; строки
    между ними (включая первую и последнюю) принадлежат аннотации. */
function collectAnnRefs(text) {
  const byId = new Map();
  const stack = [];
  const add = (id, line) => {
    let set = byId.get(id);
    if (!set) { set = new Set(); byId.set(id, set); }
    set.add(line);
  };
  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    for (const id of stack) add(id, idx);
    const line = lines[idx];
    for (let pos = 0; ; ) {
      const at = line.indexOf('\u0000', pos);
      if (at === -1) break;
      const end = line.indexOf('\u0000', at + 1);
      if (end === -1) break;
      const token = line.slice(at + 1, end);
      pos = end + 1;
      if (token === '/') stack.pop();
      else if (/^\d+$/.test(token)) {
        if (!stack.includes(token)) stack.push(token);
        add(token, idx);
      }
    }
  }
  const refs = [...byId.entries()].map(([id, set]) => ({ id, lines: [...set].sort((a, b) => a - b) }));
  refs.sort((a, b) => a.lines[0] - b.lines[0]);
  return refs;
}

/** Текст песни + разметка аннотаций: { text, refs: [{ id, lines }] }. */
export function extractLyricsDetailed(html) {
  const marker = 'data-lyrics-container="true"';
  const parts = [];
  let i = 0;
  while (true) {
    const start = html.indexOf(marker, i);
    if (start === -1) break;
    let depth = 1;
    let pos = html.indexOf('>', start) + 1;
    const chunkStart = pos;
    while (depth > 0 && pos < html.length) {
      const open = html.indexOf('<div', pos);
      const close = html.indexOf('</div>', pos);
      if (close === -1) break;
      if (open !== -1 && open < close) {
        depth += 1;
        pos = html.indexOf('>', open) + 1;
      } else {
        depth -= 1;
        pos = close + 6;
      }
    }
    parts.push(html.slice(chunkStart, pos - 6));
    i = pos;
  }
  const text = parts
    .map((part) => dropElements(part.replace(/<!--[\s\S]*?-->/g, ''), LYRICS_CHROME_RE))
    .join('\n')
    .replace(ANN_ANCHOR_RE, (_m, _open, id, inner) => `\u0000${id}\u0000${inner}\u0000/\u0000`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(BLOCK_TAG_RE, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cleaned = text.replace(LYRICS_HEADER_TEXT_RE, '').trimStart();
  const refs = collectAnnRefs(cleaned);
  return { text: cleaned.replace(ANN_TOKEN_RE, ''), refs };
}

/** Для обратной совместимости — только текст. */
export function extractLyrics(html) {
  return extractLyricsDetailed(html).text;
}

/** Id роликов YouTube, упомянутые в тексте (ссылки и превью i.ytimg);
    отсортированы — как в server.py, для паритета ответов. */
export function youtubeIds(text) {
  const ids = new Set();
  const re = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})|i\.ytimg\.com\/vi\/([\w-]{6,})/gi;
  for (const m of String(text).matchAll(re)) ids.add(m[1] || m[2]);
  return [...ids].sort();
}

/** Стабильная форма аннотации для клиента: тело (html) клиент санитайзирует
    сам — на сервере нет DOM, а доверять разметке Genius нельзя. */
export function normalizeAnnotation(ann) {
  const body = ann && typeof ann === 'object' ? ann : {};
  const inner = body.body && typeof body.body === 'object' ? body.body : {};
  const html = typeof inner.html === 'string' ? inner.html : '';
  const authorRaw = body.author && typeof body.author === 'object' ? body.author : null;
  const id = body.id != null ? String(body.id) : '';
  return {
    id,
    url: typeof body.url === 'string' && body.url ? body.url : `https://genius.com/annotations/${id}`,
    author: authorRaw && typeof authorRaw.name === 'string' && authorRaw.name
      ? { name: authorRaw.name, url: typeof authorRaw.url === 'string' && authorRaw.url ? authorRaw.url : null }
      : null,
    created_at: typeof body.created_at === 'string' && body.created_at ? body.created_at : null,
    html,
    youtube: youtubeIds(html),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!url.pathname.startsWith('/api/genius/')) {
      return env.ASSETS.fetch(request);
    }

    const token = env.GENIUS_TOKEN || GENIUS_TOKEN_FALLBACK;

    try {
      if (url.pathname === '/api/genius/search' && request.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ error: 'empty query' }, 400);
        return await cached(request, 600, async () => {
          const data = await geniusFetch(`https://api.genius.com/search?per_page=10&q=${encodeURIComponent(q)}&access_token=${encodeURIComponent(token)}`);
          return json(data);
        });
      }

      if (url.pathname === '/api/genius/lyrics' && request.method === 'GET') {
        const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
        if (!id) return json({ error: 'missing id' }, 400);
        // Ключ кэша содержит версию разбора: после правок extractLyrics суточный
        // кэш не отдаёт тексты, разобранные по-старому.
        const cacheKey = new Request(`${url.origin}/api/genius/lyrics?id=${id}&v=${LYRICS_PARSER_VERSION}`);
        return await cached(cacheKey, 86400, async () => {
          const songMeta = await geniusFetch(`https://api.genius.com/songs/${id}?access_token=${encodeURIComponent(token)}`);
          const song = songMeta?.response?.song;
          if (!song) return json({ error: 'song not found' }, 404);
          const page = await fetch(song.url, { headers: { 'user-agent': UA, 'accept-language': 'en,ru;q=0.9' } });
          if (!page.ok) return json({ error: `страница Genius ответила ${page.status}` }, 502);
          const html = await page.text();
          const detailed = extractLyricsDetailed(html);
          return json({
            song: {
              id: song.id,
              title: song.title,
              artist: song.primary_artist?.name ?? '',
              url: song.url,
              lyrics_state: song.lyrics_state ?? null,
              text: detailed.text,
              refs: detailed.refs,
            },
          });
        });
      }

      if (url.pathname === '/api/genius/annotations' && request.method === 'GET') {
        const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
        if (!id) return json({ error: 'missing id' }, 400);
        const cacheKey = new Request(`${url.origin}/api/genius/annotations?id=${id}&v=${ANN_FORMAT_VERSION}`);
        return await cached(cacheKey, 86400, async () => {
          // Внутренний JSON Genius — тот же, которым пользуется сам сайт:
          // официальный API аннотаций не отдаёт.
          const response = await fetch(`https://genius.com/api/annotations/${id}`, {
            headers: { 'user-agent': UA, 'accept': 'application/json' },
          });
          if (response.status === 404) return json({ error: 'annotation not found' }, 404);
          if (!response.ok) return json({ error: `Genius ответил ${response.status}` }, 502);
          const data = await response.json().catch(() => null);
          const ann = data?.response?.annotation;
          if (!ann) return json({ error: 'annotation not found' }, 404);
          return json({ annotation: normalizeAnnotation(ann) });
        });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err?.message || 'proxy failed' }, 502);
    }
  },
};
