"""Статический сервер с запретом кэширования (для живого превью)."""
import http.server
import socketserver
import sys

PORT = 8080


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
