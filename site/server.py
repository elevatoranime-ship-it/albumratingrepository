"""Статический сервер с запретом кэширования (для живого превью)."""
import http.server
import socketserver
import sys

PORT = 8080
# порт можно передать аргументом: python3 server.py 8081 [--demo]
for _i, _arg in enumerate(sys.argv):
    if _arg == "--port" and _i + 1 < len(sys.argv):
        PORT = int(sys.argv[_i + 1])
    elif _arg.isdigit():
        PORT = int(_arg)


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
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


with ReusableTCPServer(("0.0.0.0", PORT), Handler) as httpd:
    print(f"Serving on http://0.0.0.0:{PORT}")
    httpd.serve_forever()
