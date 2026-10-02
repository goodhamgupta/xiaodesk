#!/usr/bin/env python3
"""Approve pending OpenClaw node command surfaces. Device pairing is already
auto-approved for loopback; this is the second gate (system.run and friends)."""
import json
import os
import subprocess

claw = os.environ.get("OPENCLAW_BIN", "openclaw")


def run(args: list[str]) -> str:
    proc = subprocess.run([claw, *args], capture_output=True, text=True, timeout=20)
    return proc.stdout


def main() -> None:
    raw = run(["nodes", "pending", "--json"])
    try:
        rows = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return
    if not isinstance(rows, list):
        return
    for row in rows:
        request_id = row.get("requestId") if isinstance(row, dict) else None
        if request_id:
            run(["nodes", "approve", str(request_id), "--json"])


if __name__ == "__main__":
    main()
