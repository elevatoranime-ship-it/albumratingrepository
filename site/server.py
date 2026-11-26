"""Локальный сервер: статика без кэша + прокси Genius для /api/genius/*.

Прокси нужен для живого превью и ручной проверки: в проде то же самое делает
worker.js на Cloudflare. Эндпоинты:
  /api/genius/search?q=…  → прокси api.genius.com/search (поиск песен)
  /api/genius/lyrics?id=… → текст песни со страницы genius.com + refs
                            (какими строками покрыты аннотации)
  /api/genius/annotations?id=… → аннотация из JSON genius.com/api/annotations/:id
"""
import http.server
import json
import os
import re
import socketserver
import sys
import urllib.parse
import urllib.error
import urllib.request
from html import unescape

PORT = 8080
# порт можно передать аргументом: python3 server.py 8081 [--demo]
for _i, _arg in enumerate(sys.argv):
    if _arg == "--port" and _i + 1 < len(sys.argv):
        PORT = int(sys.argv[_i + 1])
    elif _arg.isdigit():
        PORT = int(_arg)

GENIUS_TOKEN = os.environ.get(
    "GENIUS_TOKEN",
    "0bdmXdOU1UaPikappqvWfrpwrpxkB3HczT2xlouY9vliFGTXSahE6jOVSwAaosGP",
)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def genius_api(path, params):
    # Токен передаётся ТОЛЬКО параметром access_token в URL: с заголовком
    # Authorization Genius отвечает на такой токен ошибкой 400.
    qs = urllib.parse.urlencode({**params, "access_token": GENIUS_TOKEN})
    req = urllib.request.Request(
        f"https://api.genius.com{path}?{qs}",
        headers={"user-agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read(150).decode("utf-8", "ignore").replace("\n", " ").strip()
        raise RuntimeError(f"Genius API ответил {e.code}{': ' + detail if detail else ''}") from None


# Внутри первого блока data-lyrics-container Genius держит «шапку» — счётчик
# «6 Contributors», переводы и заголовок «<название> Lyrics» (div с атрибутом
# data-exclude-from-selection="true", класс LyricsHeader__Container-…); в конце
# последнего блока может лежать такой же подвал (LyricsFooter__…, «Embed»).
# Всё это вырезается из разметки до снятия тегов — иначе текст начинался бы
# с «6 Contributorsназвание Lyrics[Текст песни …]». Логика зеркалит worker.js.
LYRICS_CHROME_RE = re.compile(
    r'data-exclude-from-selection="true"|class="[^"]*\bLyrics(?:Header|Footer)__', re.I
)
# Блочные теги → перенос строки, чтобы соседние блоки не склеивались в одну строку.
BLOCK_TAG_RE = re.compile(
    r"</?(?:div|p|h[1-6]|section|header|footer|ul|ol|li|blockquote)\b[^>]*>", re.I
)
# Страховка: если разметка шапки изменится и она всё же дойдёт до текста.
LYRICS_HEADER_TEXT_RE = re.compile(r"^\d+\s*Contributors?[\s\S]*?\bLyrics\b(?=[ \t]*\n|\[)", re.I)
# Пустые элементы HTML — без закрывающего тега.
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


def cut_element_at(html, at):
    """Вырезает из фрагмента элемент (со всем содержимым), внутри открывающего
    тега которого стоит позиция `at`. None — если `at` не внутри тега."""
    tag_start = html.rfind("<", 0, at)
    tag_end = html.find(">", at)
    if tag_start == -1 or tag_end == -1 or html.rfind(">", 0, at) > tag_start:
        return None
    m = re.match(r"<([a-z][\w-]*)", html[tag_start:tag_end], re.I)
    if not m:
        return None
    name = m.group(1).lower()
    end = tag_end + 1
    if name not in VOID_TAGS and html[tag_end - 1] != "/":
        end, depth = len(html), 1  # незакрытый элемент — до конца фрагмента
        for t in re.finditer(rf"<(/?){name}(?=[\s/>])", html[tag_end + 1:], re.I):
            depth += -1 if t.group(1) else 1
            if depth == 0:
                close = html.find(">", tag_end + 1 + t.start())
                end = len(html) if close == -1 else close + 1
                break
    return html[:tag_start] + html[end:], tag_start


def drop_elements(html, pattern):
    """Удаляет из фрагмента все элементы, в открывающем теге которых встречается `pattern`."""
    pos = 0
    while True:
        m = pattern.search(html, pos)
        if not m:
            return html
        cut = cut_element_at(html, m.start())
        if cut is None:  # совпадение не в теге — идём дальше
            pos = m.end()
            continue
        html, pos = cut


# Открывающий тег аннотации → маркеры NUL-ID-NUL … NUL/-/NUL: маркеры
# переживают снятие тегов и превращение <br> в \n — по ним после разбора видно,
# какими строками текста покрыта каждая аннотация. Логика зеркалит worker.js.
ANN_ANCHOR_RE = re.compile(
    r'(<a\b[^>]*\bhref="(?:https?://(?:www\.)?genius\.com)?/annotations/(\d+)"[^>]*>)([\s\S]*?)(</a>)',
    re.I,
)


def _ann_mark(m):
    return "\x00" + m.group(2) + "\x00" + m.group(3) + "\x00/\x00"


ANN_TOKEN_RE = re.compile(r"\x00[^\x00]*\x00")


def collect_ann_refs(text):
    """Какими строками финального текста (индексы с нуля) покрыта каждая
    аннотация: NUL-ID-NUL открывает охват, NUL/-/NUL закрывает; строки между
    ними (включая первую и последнюю) принадлежат аннотации."""
    by_id = {}
    stack = []

    def add(ann_id, line):
        by_id.setdefault(ann_id, set()).add(line)

    for idx, line in enumerate(text.split("\n")):
        for ann_id in stack:
            add(ann_id, idx)
        pos = 0
        while True:
            at = line.find("\x00", pos)
            if at == -1:
                break
            end = line.find("\x00", at + 1)
            if end == -1:
                break
            token = line[at + 1:end]
            pos = end + 1
            if token == "/":
                if stack:
                    stack.pop()
            elif token.isdigit():
                if token not in stack:
                    stack.append(token)
                add(token, idx)
    refs = [
        {"id": ann_id, "lines": sorted(lines)}
        for ann_id, lines in by_id.items()
    ]
    refs.sort(key=lambda r: r["lines"][0])
    return refs


def extract_lyrics_detailed(html):
    """Блоки data-lyrics-container с учётом вложенности → {text, refs}
    (шапка/подвал Genius вырезаются, <br> и блочные теги → переносы строк)."""
    marker = 'data-lyrics-container="true"'
    parts, i = [], 0
    while True:
        start = html.find(marker, i)
        if start == -1:
            break
        chunk_start = html.find(">", start) + 1
        depth, pos = 1, chunk_start
        while depth > 0 and pos < len(html):
            open_t = html.find("<div", pos)
            close_t = html.find("</div>", pos)
            if close_t == -1:
                break
            if open_t != -1 and open_t < close_t:
                depth += 1
                pos = html.find(">", open_t) + 1
            else:
                depth -= 1
                pos = close_t + 6
        part = re.sub(r"<!--[\s\S]*?-->", "", html[chunk_start:pos - 6])
        parts.append(drop_elements(part, LYRICS_CHROME_RE))
        i = pos
    text = "\n".join(parts)
    text = ANN_ANCHOR_RE.sub(_ann_mark, text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p>", "\n\n", text, flags=re.I)
    text = BLOCK_TAG_RE.sub("\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()
    cleaned = LYRICS_HEADER_TEXT_RE.sub("", text, count=1).lstrip()
    refs = collect_ann_refs(cleaned)
    return {"text": ANN_TOKEN_RE.sub("", cleaned), "refs": refs}


def extract_lyrics(html):
    """Только текст песни (обратная совместимость)."""
    return extract_lyrics_detailed(html)["text"]


def youtube_ids(text):
    """Id роликов YouTube, упомянутые в тексте (ссылки и превью i.ytimg)."""
    ids = set()
    for m in re.finditer(
        r"(?:https?://)?(?:www\.)?(?:youtube\.com/(?:watch\?(?:[^#\s]*&)?v=|embed/|shorts/|live/)|youtu\.be/)([\w-]{6,})"
        r"|i\.ytimg\.com/vi/([\w-]{6,})",
        str(text),
        re.I,
    ):
        ids.add(m.group(1) or m.group(2))
    return sorted(ids)


def normalize_annotation(ann):
    """Стабильная форма аннотации для клиента — зеркалит worker.js."""
    body = ann if isinstance(ann, dict) else {}
    inner = body.get("body") if isinstance(body.get("body"), dict) else {}
    html = inner.get("html") if isinstance(inner.get("html"), str) else ""
    author_raw = body.get("author") if isinstance(body.get("author"), dict) else None
    ann_id = str(body.get("id")) if body.get("id") is not None else ""
    author = None
    if author_raw and isinstance(author_raw.get("name"), str) and author_raw.get("name"):
        url = author_raw.get("url")
        author = {
            "name": author_raw["name"],
            "url": url if isinstance(url, str) and url else None,
        }
    url = body.get("url")
    created = body.get("created_at")
    return {
        "id": ann_id,
        "url": url if isinstance(url, str) and url else f"https://genius.com/annotations/{ann_id}",
        "author": author,
        "created_at": created if isinstance(created, str) and created else None,
        "html": html,
        "youtube": youtube_ids(html),
    }


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def _genius(self):
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        try:
            if self.path.startswith("/api/genius/search"):
                q = (params.get("q") or [""])[0].strip()
                if not q:
                    return self._json({"error": "empty query"}, 400)
                return self._json(genius_api("/search", {"q": q, "per_page": "10"}))
            if self.path.startswith("/api/genius/lyrics"):
                song_id = re.sub(r"\D", "", (params.get("id") or [""])[0])
                if not song_id:
                    return self._json({"error": "missing id"}, 400)
                meta = genius_api(f"/songs/{song_id}", {})
                song = (meta.get("response") or {}).get("song")
                if not song:
                    return self._json({"error": "song not found"}, 404)
                req = urllib.request.Request(
                    song["url"], headers={"user-agent": UA, "accept-language": "en,ru;q=0.9"}
                )
                with urllib.request.urlopen(req, timeout=20) as resp:
                    html = resp.read().decode("utf-8", "replace")
                detailed = extract_lyrics_detailed(html)
                return self._json({"song": {
                    "id": song.get("id"),
                    "title": song.get("title"),
                    "artist": (song.get("primary_artist") or {}).get("name"),
                    "url": song.get("url"),
                    "lyrics_state": song.get("lyrics_state"),
                    "text": detailed["text"],
                    "refs": detailed["refs"],
                }})
            if self.path.startswith("/api/genius/annotations"):
                ann_id = re.sub(r"\D", "", (params.get("id") or [""])[0])
                if not ann_id:
                    return self._json({"error": "missing id"}, 400)
                # Внутренний JSON Genius — тот же, которым пользуется сам сайт:
                # официальный API аннотаций не отдаёт.
                req = urllib.request.Request(
                    f"https://genius.com/api/annotations/{ann_id}",
                    headers={"user-agent": UA, "accept": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = json.loads(resp.read().decode("utf-8", "replace"))
                ann = (data.get("response") or {}).get("annotation")
                if not ann:
                    return self._json({"error": "annotation not found"}, 404)
                return self._json({"annotation": normalize_annotation(ann)})
            return self._json({"error": "not found"}, 404)
        except Exception as err:  # noqa: BLE001 — прокси должен отвечать JSON-ошибкой
            return self._json({"error": str(err)}, 502)

    def _json(self, body, status=200):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/genius/"):
            return self._genius()
        if "--demo" in sys.argv and self.path == "/":
            self.send_response(302)
            self.send_header("Location", "/?demo=1")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(fmt % args)


if __name__ == "__main__":
    with ReusableTCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving on http://0.0.0.0:{PORT}")
        httpd.serve_forever()
