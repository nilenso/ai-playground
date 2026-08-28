"""Pins OpenRouter to one provider, so the fallback path is a path and not a lottery.

`botmap` questions can be answered by the subscription or, when its quota runs
out, by the same Sonnet billed through OpenRouter. For those two to be
comparable, "the same Sonnet" has to mean one thing.

It does not by default. OpenRouter spreads requests over whoever is serving the
model -- observed on 2026-08-21 returning Anthropic, Amazon Bedrock, Claude
Platform on AWS and Azure across four consecutive calls. Same model name, four
different hosts, and no way to tell from the answer which one you got. A
baseline measured against one and candidates against another is the same class
of defect as measuring against two different map-data releases.

OpenRouter honours a `provider` field in the request body, but Claude Code
never sends one and no `--model` suffix supplies it. So we sit in the middle:
Claude Code talks to us, we add the pin, OpenRouter answers one host.

Deliberately tiny -- one request shape, streamed straight through, no
buffering. It is a shim, not a gateway.
"""

from __future__ import annotations

import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

UPSTREAM = "https://openrouter.ai/api/v1/messages"

# First-party Anthropic. The point is a fixed host, not this particular one --
# but it is the one the subscription path also uses, which is what makes the
# comparison mean something.
PINNED_PROVIDER = "anthropic"

# Headers that are ours to set, or that describe a body we are rewriting.
_DROP = {"host", "content-length", "authorization", "accept-encoding", "connection"}


class _Handler(BaseHTTPRequestHandler):
    api_key = ""
    provider = PINNED_PROVIDER

    def log_message(self, *args):  # noqa: D102 - quiet; the run's log is elsewhere
        pass

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400, "expected JSON")
            return

        # The whole reason this process exists.
        payload["provider"] = {"only": [self.provider], "allow_fallbacks": False}
        body = json.dumps(payload).encode()

        headers = {k: v for k, v in self.headers.items() if k.lower() not in _DROP}
        headers["authorization"] = f"Bearer {self.api_key}"
        headers["content-type"] = "application/json"

        req = urllib.request.Request(UPSTREAM, data=body, headers=headers, method="POST")
        try:
            upstream = urllib.request.urlopen(req, timeout=900)
        except urllib.error.HTTPError as exc:
            detail = exc.read()
            self.send_response(exc.code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(detail)))
            self.end_headers()
            self.wfile.write(detail)
            return
        except OSError as exc:
            self.send_error(502, str(exc))
            return

        self.send_response(upstream.status)
        for k, v in upstream.headers.items():
            if k.lower() not in ("transfer-encoding", "content-encoding", "connection"):
                self.send_header(k, v)
        self.end_headers()
        # Streamed, not buffered: the agent's answers arrive as server-sent
        # events and holding them back would change the timings we measure.
        while chunk := upstream.read(8192):
            self.wfile.write(chunk)
            self.wfile.flush()


class Pin:
    """A running proxy. Use as a context manager; `base_url` is what to point at."""

    def __init__(self, api_key: str, provider: str = PINNED_PROVIDER):
        handler = type("Bound", (_Handler,), {"api_key": api_key, "provider": provider})
        self._server = HTTPServer(("127.0.0.1", 0), handler)
        self.provider = provider

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address
        return f"http://{host}:{port}"

    def __enter__(self) -> "Pin":
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()
