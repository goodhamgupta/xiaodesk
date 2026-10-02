#!/usr/bin/env python3
"""One desktop action inside the neko container. argv[1] is base64 JSON."""
import base64
import json
import os
import shutil
import subprocess
import sys

os.environ.setdefault("DISPLAY", ":99.0")
os.environ.setdefault("HOME", "/home/neko")
os.environ.setdefault("XDG_RUNTIME_DIR", "/tmp/runtime-neko")
HOME = os.environ["HOME"]
LOG = open("/tmp/desk-spawn.log", "ab", buffering=0)


def which(name: str) -> str | None:
    return shutil.which(name)


def cua_bin() -> str | None:
    for path in (
        os.path.expanduser("~/.local/bin/cua-driver"),
        "/usr/local/bin/cua-driver",
    ):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return which("cua-driver")


def spawn(args: list[str]) -> None:
    subprocess.Popen(
        args,
        stdout=LOG,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env=os.environ.copy(),
    )


def cua_call(tool: str, payload: dict) -> str | None:
    binary = cua_bin()
    if not binary:
        return None
    try:
        proc = subprocess.run(
            [binary, "call", tool, json.dumps(payload)],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    out = (proc.stdout or "").strip()
    if proc.returncode != 0 and "launch_handoff_timeout" not in out:
        return None
    if any(token in out for token in ('"invalid_arguments"', '"refusal"', "Failed to launch")):
        return None
    if "launch_handoff_timeout" in out or proc.returncode == 0:
        return out or "ok"
    return None


def browser(url: str) -> str:
    target = url or "about:blank"
    binary = "/usr/lib/firefox-esr/firefox-esr"
    if not os.path.isfile(binary):
        binary = which("firefox-esr") or which("firefox") or ""
    if binary:
        via = cua_call("launch_app", {
            "launch_path": binary,
            "additional_arguments": ["--new-window", target],
        })
        if via is not None:
            return f"browser via cua-driver {target}"
    firefox = which("firefox") or which("firefox-esr")
    chrome = which("google-chrome") or which("chromium") or which("chromium-browser")
    if firefox:
        os.environ["MOZ_DISABLE_CONTENT_SANDBOX"] = "1"
        spawn([firefox, "--new-window", target])
        return f"firefox {target}"
    if chrome:
        spawn([chrome, "--no-sandbox", "--disable-dev-shm-usage", "--new-window", target])
        return f"chrome {target}"
    raise SystemExit("no browser installed")


def terminal(command: str | None) -> str:
    args = ["--disable-server", "--title=DeskTerm"]
    if command:
        path = "/tmp/desk-cmd.sh"
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(command)
            if not command.endswith("\n"):
                handle.write("\n")
        os.chmod(path, 0o755)
        args.extend(["--command", f"bash -lc 'bash {path}; exec bash'"])
    via = cua_call("launch_app", {"name": "Xfce Terminal", "additional_arguments": args})
    if via is not None:
        return f"terminal via cua-driver: {command or 'open'}"
    term = which("xfce4-terminal") or which("xterm")
    if not term:
        raise SystemExit("no terminal installed")
    if os.path.basename(term) == "xfce4-terminal":
        spawn([term, *args])
    else:
        spawn([term, "-T", "DeskTerm", "-e", args[-1] if command else "bash"])
    return f"terminal: {command or 'open'}"


def files(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    via = cua_call("launch_app", {"name": "Thunar File Manager", "additional_arguments": [path]})
    if via is not None:
        return f"files via cua-driver {path}"
    manager = which("thunar") or which("pcmanfm")
    if not manager:
        raise SystemExit("no file manager installed")
    spawn([manager, path])
    return f"files {path}"


def click(x: int, y: int) -> str:
    via = cua_call("click", {
        "scope": "desktop",
        "coordinate_frame": "desktop",
        "x": int(x),
        "y": int(y),
    })
    if via is not None:
        return f"click {x},{y} via cua-driver"
    subprocess.check_call(["xdotool", "mousemove", "--sync", str(int(x)), str(int(y)), "click", "1"])
    return f"click {x},{y} via xdotool"


def type_text(text: str) -> str:
    via = cua_call("type_text", {"scope": "desktop", "text": text})
    if via is not None:
        return "type via cua-driver"
    subprocess.check_call(["xdotool", "type", "--delay", "12", "--", text])
    return "type via xdotool"


def press_key(key: str) -> str:
    via = cua_call("press_key", {"scope": "desktop", "key": key})
    if via is None and key == "Return":
        via = cua_call("press_key", {"scope": "desktop", "key": "enter"})
    if via is not None:
        return f"key {key} via cua-driver"
    subprocess.check_call(["xdotool", "key", "--", key])
    return f"key {key} via xdotool"


def scroll(dy: int) -> str:
    steps = abs(int(dy)) or 1
    button = "5" if dy > 0 else "4"
    via = cua_call("scroll", {
        "scope": "desktop",
        "coordinate_frame": "desktop",
        "x": 640,
        "y": 400,
        "direction": "down" if dy > 0 else "up",
        "amount": steps,
    })
    if via is not None:
        return f"scroll {dy} via cua-driver"
    subprocess.check_call(["xdotool", "click", "--repeat", str(steps), button])
    return f"scroll {dy} via xdotool"


def shot() -> str:
    os.makedirs("/tmp", exist_ok=True)
    target = "/tmp/desk-shot.png"
    proc = subprocess.run(["scrot", "--overwrite", target], capture_output=True, text=True)
    if proc.returncode != 0:
        proc = subprocess.run(["scrot", target], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or "scrot failed")
    return target


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("missing action")
    action = json.loads(base64.b64decode(sys.argv[1]))
    op = action.get("op")
    os.makedirs(os.path.join(HOME, "Desktop"), exist_ok=True)
    os.makedirs(os.path.join(HOME, "Downloads"), exist_ok=True)
    if op == "chrome":
        detail = browser(str(action.get("url") or "about:blank"))
    elif op in ("terminal", "bash"):
        detail = terminal(action.get("command"))
    elif op == "files":
        detail = files(str(action.get("path") or HOME))
    elif op == "click":
        detail = click(int(action.get("x") or 640), int(action.get("y") or 400))
    elif op == "type":
        detail = type_text(str(action.get("text") or ""))
    elif op == "key":
        detail = press_key(str(action.get("key") or "Return"))
    elif op == "scroll":
        detail = scroll(int(action.get("dy") or 3))
    elif op == "shot":
        detail = shot()
    else:
        raise SystemExit(f"unknown op {op}")
    print(json.dumps({"ok": True, "detail": detail}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "detail": str(exc)}))
        sys.exit(0)
