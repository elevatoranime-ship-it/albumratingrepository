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
 *                                   lyrics_state, text } }
 *
 * Ответы кэшируются (Cache API): поиск на 10 минут, текст на сутки.
 * Токен можно задать секретом `wrangler secret put GENIUS_TOKEN`;
 * по умолчанию используется вшитый клиентский токен (только чтение).
 */

const GENIUS_TOKEN_FALLBACK = '0bdmXdOU1UaPikappqvWfrpwrpxkB3HczT2xlouY9vliFGTXSahE6jOVSwAaosGP';
/** Версия разбора текста (extractLyrics) — входит в ключ кэша /lyrics; повышать при правках разбора. */
const LYRICS_PARSER_VERSION = 2;
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

/** Достаёт текст песни со страницы genius.com: блоки data-lyrics-container
    складываются с учётом вложенности, шапка/подвал Genius вырезаются,
    теги снимаются, <br> и блочные теги превращаются в \n. */
export function extractLyrics(html) {
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
  return text.replace(LYRICS_HEADER_TEXT_RE, '').trimStart();
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
          return json({
            song: {
              id: song.id,
              title: song.title,
              artist: song.primary_artist?.name ?? '',
              url: song.url,
              lyrics_state: song.lyrics_state ?? null,
              text: extractLyrics(html),
            },
          });
        });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err?.message || 'proxy failed' }, 502);
    }
  },
};
