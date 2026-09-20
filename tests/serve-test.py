#!/usr/bin/env python3
"""Local no-cache dev server for testing budget.html without touching real data.

Usage:  python3 tests/serve-test.py [port]      (default 8000)

- Sends Cache-Control: no-store on everything (Chrome otherwise happily reuses
  a stale budget.js after an edit, and the test silently runs old code).
- Rewrites /assets/budget.js on the fly so the page reads and writes the
  Firestore doc  users/{uid}/state/budget_test  instead of  state/budget, and
  uses a separate localStorage key. The real doc is never read or written by a
  page served from here. The files on disk are not modified.

Seed budget_test first (see tests/budget-checks.js), then open
http://localhost:PORT/budget.html while signed in.
"""
import http.server, os, socketserver, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REWRITES = [
    ("'state', 'budget')", "'state', 'budget_test')"),
    ("'madrid.budget.v1'", "'madrid.budget.test'"),
]

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/assets/budget.js":
            with open(os.path.join(ROOT, "assets", "budget.js"), encoding="utf-8") as f:
                src = f.read()
            for old, new in REWRITES:
                if old not in src:
                    self.send_error(500, "serve-test.py: budget.js no longer contains %r" % old)
                    return
                src = src.replace(old, new)
            body = src.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), Handler) as srv:
        srv.serve_forever()
