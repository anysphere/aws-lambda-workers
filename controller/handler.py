"""Lambda entry: run `agent worker controller --spawn` for one SSE poll window.

The CLI is a long-running poll loop. A normal Lambda is still 15 minutes max, and
Cursor's SSE stream is ~5 minutes, so this invoke runs the controller for 5 minutes
then exits 0. EventBridge starts the next invoke. Reserved concurrency 1 prevents
overlapping controllers. A DLQ records a crash; the next schedule is the restart.
"""
from __future__ import annotations

import os
import signal
import subprocess

DEFAULT_RUN_SECONDS = 300
SHUTDOWN_GRACE_SECONDS = 15


def split_names(value: str | None) -> list[str]:
    parts: list[str] = []
    for chunk in (value or "").replace(";", ",").split(","):
        name = chunk.strip()
        if name:
            parts.append(name)
    return parts


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def extra_has_flag(extra: list[str], *names: str) -> bool:
    flags = set(names)
    prefixes = tuple(f"{name}=" for name in names)
    return any(part in flags or part.startswith(prefixes) for part in extra)


def controller_args(env: dict[str, str]) -> list[str]:
    script = env.get("SPAWN_SCRIPT") or os.path.join(os.getcwd(), "spawn.sh")
    extra = [part for part in env.get("CURSOR_WORKER_CONTROLLER_ARGS", "").split() if part]
    args = ["worker", "controller", "--spawn", script]

    all_pools = extra_has_flag(extra, "--all-pools") or truthy(
        env.get("CONTROLLER_ALL_POOLS") or env.get("ALL_POOLS")
    )
    pools = split_names(
        env.get("CONTROLLER_POOL_NAMES")
        or env.get("POOL_NAMES")
        or env.get("POOL_NAME")
        or env.get("CURSOR_POOL")
    )
    repos = split_names(
        env.get("CONTROLLER_REPOSITORY_URLS")
        or env.get("REPOSITORY_URLS")
        or env.get("CURSOR_REPO_URL")
    )

    if extra_has_flag(extra, "--pool", "--all-pools"):
        pass
    elif all_pools:
        args.append("--all-pools")
    elif pools:
        for pool in pools:
            args.extend(["--pool", pool])
    elif repos:
        # CLI requires --pool or --all-pools; repo filters apply on top.
        args.append("--all-pools")

    if not extra_has_flag(extra, "--repository"):
        for repo in repos:
            args.extend(["--repository", repo])

    if (
        not extra_has_flag(extra, "--pool", "--all-pools", "--repository")
        and not all_pools
        and not pools
        and not repos
    ):
        raise RuntimeError(
            "configure CONTROLLER_POOL_NAMES, CONTROLLER_ALL_POOLS=true, "
            "and/or CONTROLLER_REPOSITORY_URLS"
        )

    args.extend(extra)
    return args


def agent_bin(env: dict[str, str]) -> str:
    return env.get("CURSOR_AGENT_BIN") or "cursor-agent"


def read_cursor_api_key(env: dict[str, str]) -> str:
    inline = (env.get("CURSOR_API_KEY") or "").strip()
    if inline:
        return inline
    name = (env.get("CURSOR_API_KEY_PARAM_NAME") or "").strip()
    if not name:
        raise RuntimeError("CURSOR_API_KEY or CURSOR_API_KEY_PARAM_NAME is required")
    import boto3

    region = env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION") or "us-east-1"
    client = boto3.client("ssm", region_name=region)
    value = (client.get_parameter(Name=name, WithDecryption=True)["Parameter"].get("Value") or "").strip()
    if not value:
        raise RuntimeError(f"SSM parameter {name} has no value")
    return value


def run_window_seconds(env: dict[str, str], remaining_ms: int | None) -> int:
    requested = int(env.get("CONTROLLER_RUN_SECONDS") or DEFAULT_RUN_SECONDS)
    if remaining_ms is None:
        return requested
    budget = int(remaining_ms / 1000) - SHUTDOWN_GRACE_SECONDS
    return max(1, min(requested, budget))


def wait_for(proc: subprocess.Popen[bytes], timeout: int) -> int | None:
    try:
        return proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


def stop(proc: subprocess.Popen[bytes]) -> int:
    if proc.poll() is not None:
        return proc.returncode or 0
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    code = wait_for(proc, SHUTDOWN_GRACE_SECONDS)
    if code is not None:
        return code
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return proc.wait()


def run_worker_controller(env: dict[str, str], remaining_ms: int | None = None) -> dict:
    merged = {**os.environ, **env}
    # Lambda container images often omit HOME; the agent wrapper is `set -u`.
    merged.setdefault("HOME", "/tmp")
    merged.setdefault("NODE_COMPILE_CACHE", "/tmp/cursor-compile-cache")
    child_env = {**merged, "CURSOR_API_KEY": read_cursor_api_key(merged)}
    bin_path = agent_bin(merged)
    args = controller_args(merged)
    timeout = run_window_seconds(merged, remaining_ms)
    cwd = merged.get("LAMBDA_TASK_ROOT") or os.getcwd()
    proc = subprocess.Popen(
        [bin_path, *args],
        env=child_env,
        cwd=cwd,
        start_new_session=True,
    )
    code = wait_for(proc, timeout)
    if code is None:
        stop(proc)
        return {"ok": True, "reason": "run_window_elapsed", "runSeconds": timeout}
    if code != 0:
        raise RuntimeError(f"{bin_path} {' '.join(args)} exited {code}")
    return {"ok": True, "exitCode": code}


def handler(event, context):
    remaining = context.get_remaining_time_in_millis() if context is not None else None
    return run_worker_controller(dict(os.environ), remaining)
