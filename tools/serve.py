#!/usr/bin/env python3
"""INKWAVE dev/LAN server: static files from the repo root on 0.0.0.0 (reachable from other machines on the network).

Every response carries `Cache-Control: no-cache`, so browsers revalidate each module on load (cheap 304s via
Last-Modified) and can never mix a fresh main.js with a stale cached module — plain `python -m http.server` sends no
cache headers and browsers apply heuristic caching to ES modules.

usage: python3 tools/serve.py [port=8490] [--dir <root>] [--verbose]

--verbose logs every request plus a running byte total. The default quiet mode hides successful requests, which makes
"the phone never connected" and "the phone connected and is loading 8 MB of modules" look identical from the log —
that distinction is the first thing worth knowing when a device cannot load the game.
"""
import http.server
import os
import socket
import sys
from functools import partial

port = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8490
root = sys.argv[sys.argv.index('--dir') + 1] if '--dir' in sys.argv else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERBOSE = '--verbose' in sys.argv
TOTAL = [0]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm',
        '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):   # quiet by default: only errors
        code = str(args[1] if len(args) > 1 else '')
        if VERBOSE:
            try: size = os.path.getsize(self.translate_path(self.path))
            except OSError: size = 0
            TOTAL[0] += size
            where = self.client_address[0] if self.client_address else '?'
            sys.stderr.write(f'[{where}] {code} {size/1024:8.1f} KB  total {TOTAL[0]/1048576:6.2f} MB  {self.path}\n')
            sys.stderr.flush()
        elif code.startswith(('4', '5')):
            super().log_message(fmt, *args)


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def handle_error(self, request, client_address):
        # a browser cancelling a download (tab closed, reload) is normal — don't print a traceback for it
        import sys as _s
        if isinstance(_s.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)

    def server_bind(self):
        # dual-stack: IPv6 + IPv4 on one socket, so both http://localhost and http://<lan-ip> work
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


def lan_ips():
    """Every non-loopback IPv4 address this machine answers on.

    The usual default-route trick (UDP-connect to 10.255.255.255) reports only ONE address — whichever interface
    owns the default route. On a machine that is wired to one network and also on Wi-Fi (the common case when you are
    trying to reach the dev server from a phone), that hides the address the phone actually needs, and the number it
    prints instead is the one the phone cannot reach. Enumerate the interfaces instead.
    """
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith(('127.', '169.254.')):   # 169.254.x = link-local, nothing can route to it
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


if __name__ == '__main__':
    httpd = Server(('::', port), partial(Handler, directory=root))
    print(f'INKWAVE serving {root}')
    print(f'  this machine : http://localhost:{port}')
    for ip in lan_ips():
        print(f'  your network : http://{ip}:{port}')
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
