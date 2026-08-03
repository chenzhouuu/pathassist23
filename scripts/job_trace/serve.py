#!/usr/bin/env python3
"""A read-only console for watching one analysis run cross the whole stack.

    python3 scripts/job_trace/serve.py        # then open http://127.0.0.1:8099/

Why this exists. A run submitted from the Analysis panel crosses six processes before a pixel
comes back — browser, gateway, Girder, RabbitMQ, the Celery driver, the GPU service — and each
one is observable from a different place. The Runs list shows a percentage, and a successful
Girder job writes no log at all, so "it is at 42%" is the whole of what the product can tell you.
This serves a page that watches every hop at once and says what each one just did.

It is a diagnostic bystander and nothing else:

* **It adds nothing the page did not ask for.** It forwards the page's calls verbatim and tails
  container stdout; it originates no request of its own, and no production code knows it exists.
  The page does dispatch real runs — that is what it is for — but this process never decides to.
* **One process.** It serves the page *and* reverse-proxies the two APIs, so the page is
  same-origin with everything it calls and needs no CORS anywhere. It does not need `npm run dev`
  to be running.
* **Local only.** Binds 127.0.0.1. It holds no credentials — the page signs in for itself and
  keeps its token in `sessionStorage`, and this process just forwards the header.

Docker is optional. Without it the log panel says so and the rest of the page still works; the
hops that are only visible in container stdout degrade to "needs the log stream" rather than
lying about what they saw.
"""

import json
import os
import queue
import shutil
import subprocess
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent

HOST = os.environ.get("JOB_TRACE_HOST", "127.0.0.1")
PORT = int(os.environ.get("JOB_TRACE_PORT", "8099"))

#: Where the two APIs live. Girder's default is this box's own Girder, never a remote one — the
#: same invariant every service config in this repo holds.
GIRDER_BASE = os.environ.get("JOB_TRACE_GIRDER_BASE", "http://localhost:9080/api/v1").rstrip("/")
COPILOT_BASE = os.environ.get("JOB_TRACE_COPILOT_BASE", "http://localhost:8010/api/copilot"
                              ).rstrip("/")

#: The three containers a run passes through, in the order it passes through them. Overridable
#: because a second box names them differently, not because the list is arbitrary.
CONTAINERS = [c for c in os.environ.get(
    "JOB_TRACE_CONTAINERS", "agent-copilot-1,agent-celery-1,agent-cellvit-1").split(",") if c]

#: Prefix → upstream base. Longest prefix wins, so `/api/copilot` is not eaten by `/api`.
PROXY = [("/api/copilot", COPILOT_BASE), ("/api/v1", GIRDER_BASE)]

#: Headers that belong to the hop between the browser and this process, and must not be passed on.
#:
#: A deny-list rather than an allow-list, and that is the whole point. This started as
#: `("girder-token", "content-type", "accept")`, which silently dropped `Authorization` — so
#: `GET /user/authentication` came back `401: Use HTTP Basic Authentication`, a refusal naming
#: the exact header the browser had in fact sent. Pasting a token still worked, which is why it
#: survived being tested. An allow-list drops whatever nobody thought of; a deny-list only drops
#: what is known not to travel.
#:
#: `accept-encoding` is on it for a different reason: `_relay` copies Content-Type and not
#: Content-Encoding, so a compressed upstream body would reach the browser mislabelled.
HOP_BY_HOP = frozenset({
    "host", "origin", "referer", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    "accept-encoding", "content-length",
})

STATIC = {"/": "index.html", "/index.html": "index.html"}
STATIC.update({f"/{n}": n for n in
               ("trace.js", "runs.js", "slide.js", "api.js", "state.js", "ui.js", "canvas.js",
                "hops.js", "trace.css")})

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8"}


class LogHub:
    """Fans `docker logs -f` for several containers out to any number of page clients.

    One reader thread per container, one queue per client. A client that stops draining is
    dropped rather than allowed to grow without bound — a page left open overnight must not turn
    into the reason the box runs out of memory.
    """

    #: Lines kept for a client that connects mid-run, so the panel is not empty on arrival.
    BACKLOG = 400
    #: Per-client queue depth. Beyond this the client is too slow to be worth serving.
    DEPTH = 2000

    def __init__(self, containers):
        self.containers = containers
        self.available = shutil.which("docker") is not None
        self._subs = []
        self._recent = []
        self._lock = threading.Lock()
        self._started = False

    def start(self):
        if self._started or not self.available:
            return
        self._started = True
        for name in self.containers:
            threading.Thread(target=self._tail, args=(name,), daemon=True).start()

    def _tail(self, name):
        """Follow one container for as long as this process lives, reconnecting if it stops."""
        while True:
            try:
                proc = subprocess.Popen(
                    ["docker", "logs", "-f", "--since", "10s", "--timestamps", name],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, errors="replace", bufsize=1)
            except OSError as exc:
                self._emit(name, f"(cannot follow this container: {exc})")
                return
            for line in proc.stdout:
                self._emit(name, line.rstrip("\n"))
            proc.wait()
            # A container that was restarted is worth reconnecting to; one that never existed
            # would spin here, so say so once per attempt and let the panel show it.
            self._emit(name, "(log stream ended — retrying)")
            threading.Event().wait(3.0)

    def _emit(self, container, line):
        # `docker --timestamps` prefixes RFC3339 followed by the line's own text.
        stamp, _, rest = line.partition(" ")
        if not (stamp[:4].isdigit() and "T" in stamp):
            stamp, rest = "", line
        event = {"c": container, "t": stamp, "line": rest}
        with self._lock:
            self._recent.append(event)
            del self._recent[:-self.BACKLOG]
            for q in list(self._subs):
                try:
                    q.put_nowait(event)
                except queue.Full:
                    self._subs.remove(q)

    def subscribe(self):
        q = queue.Queue(maxsize=self.DEPTH)
        with self._lock:
            backlog = list(self._recent)
            self._subs.append(q)
        return q, backlog

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)


HUB = LogHub(CONTAINERS)


def upstream_for(path):
    """`(url, base)` for a proxied path, or `(None, None)` when this is not one."""
    for prefix, base in PROXY:
        if path == prefix or path.startswith(prefix + "/"):
            return base + path[len(prefix):], base
    return None, None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "job-trace"

    def log_message(self, fmt, *args):        # noqa: A003 — quiet; the page is the output
        pass

    # -- routing -------------------------------------------------------------------------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/logs/stream":
            return self._stream_logs()
        if path == "/trace/config":
            return self._json(200, {
                "girder": GIRDER_BASE, "copilot": COPILOT_BASE,
                "containers": CONTAINERS, "logs": HUB.available,
            })
        if path in STATIC:
            return self._static(STATIC[path])
        return self._proxy()

    def do_POST(self):
        return self._proxy()

    def do_PUT(self):
        return self._proxy()

    def do_DELETE(self):
        return self._proxy()

    # -- responses -----------------------------------------------------------------------
    def _static(self, name):
        f = HERE / name
        if not f.exists():
            return self._json(404, {"detail": f"{name} is missing next to serve.py"})
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self):
        """Forward one call to whichever API owns its prefix, verbatim in both directions.

        Error bodies are forwarded too, and that is the point rather than politeness: the gateway
        says `no such artifact on this slide` in a 404 body, and a proxy that replaced it with its
        own wording would make the console worse at explaining a refusal than curl.
        """
        parsed = urllib.parse.urlparse(self.path)
        url, base = upstream_for(parsed.path)
        if not url:
            return self._json(404, {"detail": f"nothing is served at {parsed.path}"})
        if parsed.query:
            url += "?" + parsed.query

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}

        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                self._relay(resp.status, resp.headers.get("Content-Type"), resp.read())
        except urllib.error.HTTPError as exc:
            self._relay(exc.code, exc.headers.get("Content-Type"), exc.read())
        except Exception as exc:                                       # noqa: BLE001
            self._json(502, {"detail": f"{base} did not answer: {exc}"})

    def _relay(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _stream_logs(self):
        # `Connection: close` rather than keep-alive: an HTTP/1.1 response with neither a
        # Content-Length nor chunked encoding is only well framed when the body runs to EOF, and
        # this one never ends. EventSource reconnects on its own, so nothing is lost by it.
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if not HUB.available:
            self._sse({"c": "-", "t": "", "line": "docker is not on PATH — log panel disabled"})
            return
        HUB.start()
        q, backlog = HUB.subscribe()
        try:
            for event in backlog:
                self._sse(event)
            while True:
                try:
                    self._sse(q.get(timeout=15))
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")     # keeps proxies and the tab awake
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            HUB.unsubscribe(q)

    def _sse(self, event):
        self.wfile.write(b"data: " + json.dumps(event).encode() + b"\n\n")
        self.wfile.flush()


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"job-trace console  ->  http://{HOST}:{PORT}/")
    print(f"  copilot : {COPILOT_BASE}")
    print(f"  girder  : {GIRDER_BASE}")
    print(f"  logs    : {'docker ' + ', '.join(CONTAINERS) if HUB.available else 'disabled'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
