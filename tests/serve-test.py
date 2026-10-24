#!/usr/bin/env python3
"""Local no-cache dev server for testing budget.html and dossier.html without touching real data.

Usage:  python3 tests/serve-test.py [port]      (default 8000)

- Sends Cache-Control: no-store on everything (Chrome otherwise happily reuses
  a stale budget.js after an edit, and the test silently runs old code).
- Rewrites /assets/budget.js on the fly so the page reads and writes the
  Firestore doc  users/{uid}/state/budget_test  instead of  state/budget, and
  uses a separate localStorage key. The real doc is never read or written by a
  page served from here. The files on disk are not modified.
- Routes the page's initial load through __loadDoc (appended below), so a test
  can open  budget.html?loadtest=slow  (load resolves after 3s) or
  budget.html?loadtest=fail  (load rejects) to exercise the pre-load and
  failed-load paths. Without ?loadtest it is a plain getDoc.
- Exposes window.__budgetIdle() (no save waiting or in flight), which
  readDoc() in tests/budget-checks.js waits on instead of a fixed sleep.
- Does the same for dossier.html: /assets/itinerary.js -> state/itinerary_test
  (+ __loadDoc, window.__itinIdle), /assets/dossier.js -> state/checklist_test,
  and /assets/places.js -> state/places_test (+ __loadDoc on its own query
  param, ?placesload=slow|fail, so a failed pool load leaves the board alone;
  window.__placesIdle).

Seed budget_test first (see tests/budget-checks.js), then open
http://localhost:PORT/budget.html while signed in. Itinerary checks:
tests/itinerary-checks.js and tests/places-checks.js, run from
http://localhost:PORT/dossier.html.
"""
import http.server, os, socketserver, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# path -> (replacements, text appended to the served file)
BUDGET_SHIM = """
function __loadDoc(ref){
  const mode = new URLSearchParams(location.search).get('loadtest');
  if (mode === 'fail') return Promise.reject(new Error('loadtest: simulated getDoc failure'));
  if (mode === 'slow') return new Promise(r => setTimeout(r, 3000)).then(() => getDoc(ref));
  return getDoc(ref);
}
// lets tests wait for this page's guarded save (debounce + read + write) to finish
window.__budgetIdle = () => !savePending;
"""
REWRITES = {
    "/assets/budget.js": ([
        ("'state', 'budget')", "'state', 'budget_test')"),
        ("'madrid.budget.v1'", "'madrid.budget.test'"),
        ("getDoc(docRef).then(", "__loadDoc(docRef).then("),
    ], BUDGET_SHIM),
    # dossier.html: the itinerary gets the same treatment as the budget
    # (doc itinerary_test, own localStorage key, ?loadtest hook, idle probe)...
    "/assets/itinerary.js": ([
        ("'state', 'itinerary')", "'state', 'itinerary_test')"),
        ("'madrid.itinerary.v1'", "'madrid.itinerary.test'"),
        ("getDoc(docRef).then(", "__loadDoc(docRef).then("),
    ], BUDGET_SHIM.replace("__budgetIdle", "__itinIdle")),
    # ...the recommendations pool too, with its own ?placesload hook...
    "/assets/places.js": ([
        ("'state', 'places')", "'state', 'places_test')"),
        ("'madrid.places.v1'", "'madrid.places.test'"),
        ("getDoc(docRef).then(", "__loadDoc(docRef).then("),
    ], BUDGET_SHIM.replace("__budgetIdle", "__placesIdle").replace("'loadtest'", "'placesload'")),
    # ...and the checklist on the same page is pointed away from the real doc too
    "/assets/dossier.js": ([
        ("'state', 'checklist')", "'state', 'checklist_test')"),
        ("'madrid.checklist.v1'", "'madrid.checklist.test'"),
    ], ""),
}

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in REWRITES:
            subs, shim = REWRITES[path]
            with open(os.path.join(ROOT, path.lstrip("/")), encoding="utf-8") as f:
                src = f.read()
            for old, new in subs:
                if old not in src:
                    self.send_error(500, "serve-test.py: %s no longer contains %r" % (path, old))
                    return
                src = src.replace(old, new)
            src += shim
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
