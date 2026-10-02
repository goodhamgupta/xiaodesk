#!/usr/bin/env python3
"""Relay UDP 127.0.0.1:52100 to neko's real mux socket.

neko rewrites ICE candidates to NAT1TO1 (127.0.0.1) but pion binds the mux
on the non-loopback interfaces only. Connectivity checks to 127.0.0.1 then
get no answer and the viewer stays on "Reconnecting".
"""
import select
import socket
import sys

LISTEN = ("127.0.0.1", 52100)


def target_addr() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    # `ss` lines look like: UNCONN 0 0 172.17.0.1:52100 0.0.0.0:*
    import subprocess
    out = subprocess.check_output(["ss", "-uln"], text=True)
    for line in out.splitlines():
        if ":52100" not in line:
            continue
        for field in line.split():
            if field.endswith(":52100") and not field.startswith("127.") and not field.startswith("[") and not field.startswith("*"):
                return field.rsplit(":", 1)[0]
    raise SystemExit("neko is not listening on udp 52100")


def main() -> None:
    target = (target_addr(), 52100)
    front = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    front.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    front.bind(LISTEN)
    clients: dict[tuple[str, int], socket.socket] = {}
    print(f"udp mux relay {LISTEN[0]}:{LISTEN[1]} -> {target[0]}:{target[1]}", flush=True)
    while True:
        watch = [front, *clients.values()]
        ready, _, _ = select.select(watch, [], [], 2)
        for sock in ready:
            if sock is front:
                data, addr = sock.recvfrom(65535)
                back = clients.get(addr)
                if back is None:
                    back = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    back.bind(("127.0.0.1", 0))
                    clients[addr] = back
                back.sendto(data, target)
                continue
            data, _ = sock.recvfrom(65535)
            for addr, back in clients.items():
                if back is sock:
                    front.sendto(data, addr)
                    break


if __name__ == "__main__":
    main()
