"""
HTTP front for the downloader, for Cloudflare Containers.

A Container instance is reachable only over HTTP and is started by the Worker
when there is something to do, so the polling loop cannot be the entry point:
an instance nobody talks to is asleep, and an instance polling an empty queue
is billed for waiting. This turns the loop around. The Worker sends one
request, the loop drains whatever is queued, the request answers with what it
did, and the instance is free to sleep.

Nothing about the job protocol changes. The container still claims work
through /internal/next-job exactly as the machine at home does, which is what
keeps the atomic claim, the leases and the failure reporting identical on both
— and what lets either one cover for the other.

    MODE=serve python server.py      # in the container
    python downloader.py             # unchanged, polls forever
"""

import json
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import downloader

PORT = int(os.environ.get("PORT", "8080"))

# One drain at a time. Claiming is atomic on the Worker's side, so a second
# drain would be harmless rather than dangerous, but it would spend CPU racing
# the first for rows it cannot have. Two wake-ups arriving together should cost
# what one costs.
_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    # The default logger writes a line per request to stderr in a format
    # nothing here reads. The drain prints what actually happened.
    def log_message(self, *_args):
        pass

    def _reply(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        # Kept cheap and lock-free: it has to answer while a drain is running,
        # which is exactly when something would think to ask.
        if self.path.startswith("/health"):
            self._reply(200, {"ok": True, "busy": _lock.locked()})
            return
        self._drain()

    def do_POST(self) -> None:
        self._drain()

    def _drain(self) -> None:
        if not _lock.acquire(blocking=False):
            # Already draining. The queue this request was sent for will be
            # taken by the drain in flight, so this is success, not a clash.
            self._reply(200, {"drained": False, "reason": "already running"})
            return
        try:
            downloader.main(drain_once=True)
            self._reply(200, {"drained": True})
        except Exception as e:  # noqa: BLE001
            # A drain that dies must not take the instance with it: the next
            # wake-up should find something that still answers.
            traceback.print_exc()
            self._reply(500, {"drained": False, "error": str(e)[:400]})
        finally:
            _lock.release()


def main() -> None:
    if not downloader.APP_URL or not downloader.TOKEN:
        raise SystemExit("APP_URL and WORKER_TOKEN are required.")
    print(f"[boot] listening on :{PORT}, draining {downloader.APP_URL} on request")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
