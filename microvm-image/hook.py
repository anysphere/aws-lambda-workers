#!/usr/bin/env python3
"""Tiny MicroVM hook listener. /run applies CURSOR_* then starts the worker."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import subprocess

PORT = int(os.environ.get("HOOK_PORT", "9000"))


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if self.path.rstrip("/").endswith("/run"):
            body = json.loads(raw or b"{}")
            payload = body.get("runHookPayload") or "{}"
            env = json.loads(payload) if isinstance(payload, str) else payload
            if isinstance(env, dict):
                os.environ.update({str(k): str(v) for k, v in env.items() if v is not None})
            os.environ.setdefault("HOME", "/root")
            os.environ.setdefault("NODE_COMPILE_CACHE", "/tmp/cursor-compile-cache")
            keys = sorted(k for k in os.environ if k.startswith("CURSOR_"))
            print(f"hook /run microvmId={body.get('microvmId')} cursor_keys={keys}", flush=True)
            subprocess.Popen(
                ["/opt/cursor/entrypoint.sh"],
                env=os.environ.copy(),
                start_new_session=True,
            )
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_args):
        return


HTTPServer(("0.0.0.0", PORT), Hook).serve_forever()
