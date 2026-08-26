#!/usr/bin/env python3
"""Tiny MicroVM hook listener. /run applies CURSOR_* then starts the worker."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import shutil
import subprocess

PORT = int(os.environ.get("HOOK_PORT", "9000"))
ENTRYPOINT = "/opt/cursor/entrypoint.sh"
WORKSPACES = os.environ.get("WORKSPACES", "/opt/cursor/workspaces")
AGENT_PATHS = (
    "/usr/local/bin/cursor-agent",
    "/usr/local/bin/agent",
    "/root/.local/bin/cursor-agent",
    "/root/.local/bin/agent",
    "/root/.cursor/bin/cursor-agent",
    "/root/.cursor/bin/agent",
)


def _agent_bin():
    for name in ("cursor-agent", "agent"):
        found = shutil.which(name)
        if found:
            return found
    for path in AGENT_PATHS:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def _run_bits_ready():
    if not (os.path.isfile(ENTRYPOINT) and os.access(ENTRYPOINT, os.X_OK)):
        return False
    if not os.path.isdir(WORKSPACES):
        return False
    return _agent_bin() is not None


def _touch(path):
    with open(path, "rb") as fh:
        fh.read(65536)


def _validate():
    if not _run_bits_ready():
        return False
    agent = _agent_bin()
    try:
        _touch(ENTRYPOINT)
        _touch(agent)
        os.listdir(WORKSPACES)
    except OSError:
        return False
    for args in ([agent, "--version"], [agent, "--help"]):
        try:
            subprocess.run(
                args,
                timeout=5,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except (OSError, subprocess.TimeoutExpired):
            continue
    return False


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        path = self.path.split("?", 1)[0].rstrip("/")
        if path.endswith("/ready"):
            print("hook /ready", flush=True)
            code = 200 if _run_bits_ready() else 503
        elif path.endswith("/validate"):
            print("hook /validate", flush=True)
            code = 200 if _validate() else 503
        elif path.endswith("/run"):
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
            code = 200
        else:
            code = 200
        self.send_response(code)
        self.end_headers()

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Hook).serve_forever()
