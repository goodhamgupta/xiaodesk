#!/usr/bin/env python3
"""Keep the guest on one screen. Openbox's default wheel binding flips desktop 1-4."""
from __future__ import annotations

import ctypes
import os
import re
import sys
from pathlib import Path

RC = Path("/etc/xdg/openbox/rc.xml")

WHEEL_DESKTOP = re.compile(
    r"[ \t]*<mousebind button=\"(?:Up|Down)\" action=\"Click\">\s*"
    r"<action name=\"GoToDesktop\"><to>(?:previous|next)</to></action>\s*"
    r"</mousebind>\n"
)


def pin_file() -> None:
    if os.geteuid() != 0:
        return
    text = RC.read_text()
    updated = WHEEL_DESKTOP.sub("", text)
    updated = updated.replace("<number>4</number>", "<number>1</number>", 1)
    updated = updated.replace("<popupTime>875</popupTime>", "<popupTime>0</popupTime>", 1)
    if updated == text:
        print("openbox rc already pinned")
        return
    RC.write_text(updated)
    print("openbox rc pinned to one desktop")


def client_message(display: str, atom_name: bytes, value: int) -> None:
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
    x11.XFlush.argtypes = [ctypes.c_void_p]

    class Event(ctypes.Structure):
        _fields_ = [
            ("type", ctypes.c_int),
            ("serial", ctypes.c_ulong),
            ("send_event", ctypes.c_int),
            ("display", ctypes.c_void_p),
            ("window", ctypes.c_ulong),
            ("message_type", ctypes.c_ulong),
            ("format", ctypes.c_int),
            ("data", ctypes.c_long * 5),
        ]

    dpy = x11.XOpenDisplay(display.encode())
    if not dpy:
        raise SystemExit(f"cannot open {display}")
    root = x11.XDefaultRootWindow(dpy)
    event = Event()
    event.type = 33  # ClientMessage
    event.window = root
    event.message_type = x11.XInternAtom(dpy, atom_name, 0)
    event.format = 32
    event.data[0] = value
    mask = (1 << 20) | (1 << 19)  # SubstructureRedirect | SubstructureNotify
    x11.XSendEvent(dpy, root, 0, mask, ctypes.byref(event))
    x11.XFlush(dpy)


def main() -> None:
    pin_file()
    display = os.environ.get("DISPLAY", ":0")
    client_message(display, b"_NET_CURRENT_DESKTOP", 0)
    client_message(display, b"_NET_NUMBER_OF_DESKTOPS", 1)
    print("asked openbox for one desktop")


if __name__ == "__main__":
    sys.exit(main() or 0)
