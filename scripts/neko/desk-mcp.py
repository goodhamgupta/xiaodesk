#!/usr/bin/env python3
"""MCP stdio server the OpenClaw node host publishes for this neko desktop.

Newline-delimited JSON-RPC, which is what OpenClaw's node MCP client reads.
`desk` runs one desk-act.py action. `sh` runs a shell command as the desktop user.
"""
import json
import os
import subprocess
import sys

DISPLAY = os.environ.get("DISPLAY", ":99.0")
HOME = os.environ.get("HOME", "/home/neko")


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def desk_script() -> str:
    for path in ("/tmp/desk-act.py", "/workspace/scripts/neko/desk-act.py"):
        if os.path.isfile(path):
            return path
    return "/tmp/desk-act.py"


def run_desk(arguments: dict) -> str:
    import base64

    payload = base64.b64encode(json.dumps(arguments).encode()).decode()
    env = os.environ.copy()
    env.setdefault("DISPLAY", DISPLAY)
    env.setdefault("HOME", HOME)
    env.setdefault("XDG_RUNTIME_DIR", "/tmp/runtime-neko")
    proc = subprocess.run(
        ["python3", desk_script(), payload],
        capture_output=True,
        text=True,
        env=env,
        timeout=40,
    )
    lines = [line for line in (proc.stdout or "").splitlines() if line.strip()]
    if lines:
        return lines[-1][:8000]
    err = (proc.stderr or "").strip()
    return err[:8000] or f"desk action exited {proc.returncode}"


def run_sh(command: str) -> str:
    env = os.environ.copy()
    env.setdefault("DISPLAY", DISPLAY)
    env.setdefault("HOME", HOME)
    env.setdefault("XDG_RUNTIME_DIR", "/tmp/runtime-neko")
    proc = subprocess.run(
        ["bash", "-lc", command],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    text = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return (text or f"exit {proc.returncode}")[:8000]


TOOLS = [
    {
        "name": "desk",
        "description": "Run one desktop action on this neko VM (chrome, terminal, files, type, key, click, scroll, bash).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "op": {"type": "string"},
                "url": {"type": "string"},
                "command": {"type": "string"},
                "path": {"type": "string"},
                "text": {"type": "string"},
                "key": {"type": "string"},
                "x": {"type": "number"},
                "y": {"type": "number"},
                "dy": {"type": "number"},
            },
            "required": ["op"],
        },
    },
    {
        "name": "sh",
        "description": "Run a shell command on this neko VM and return its output.",
        "inputSchema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
]


def handle(message: dict):
    method = message.get("method")
    mid = message.get("id")
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "neko-desk", "version": "1.0.0"},
            },
        }
    if method == "notifications/initialized":
        return None
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if name == "sh":
            text = run_sh(str(arguments.get("command") or ""))
        elif name == "desk":
            text = run_desk(arguments if isinstance(arguments, dict) else {})
        else:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool {name}"}}
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": {"content": [{"type": "text", "text": text}], "isError": False},
        }
    if mid is None:
        return None
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}


def main() -> None:
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, dict):
            continue
        reply = handle(message)
        if reply is not None:
            send(reply)


if __name__ == "__main__":
    main()
