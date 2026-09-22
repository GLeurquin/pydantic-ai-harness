"""Token-protected loopback HTTP transport for a single browser conversation."""

import json
import secrets
import threading
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from anyio import CancelScope, to_thread
from anyio.from_thread import BlockingPortal
from pydantic import BaseModel, Field, ValidationError


class ChatRequest(BaseModel):
    """Validate the browser request before invoking tools."""

    text: str = Field(min_length=1, max_length=65536)


class _ChatServer(ThreadingHTTPServer):
    """State shared by request handlers for the server lifetime."""

    def __init__(self, callback: Callable[[str], Awaitable[str]], *, portal: BlockingPortal, port: int) -> None:
        self.callback = callback
        self.portal = portal
        self.token = secrets.token_urlsafe(32)
        self.busy = threading.Lock()
        self.page = Path(__file__).with_name('web.html').read_bytes()
        super().__init__(('127.0.0.1', port), _Handler)
        self.daemon_threads = False
        self.address = '127.0.0.1' if self.server_port == 80 else f'127.0.0.1:{self.server_port}'
        self.origin = f'http://{self.address}'


class _Handler(BaseHTTPRequestHandler):
    @property
    def state(self) -> _ChatServer:
        assert isinstance(self.server, _ChatServer)
        return self.server

    def setup(self) -> None:
        self.request.settimeout(10)
        super().setup()

    def log_message(self, format: str, *args: object) -> None:
        pass

    def reply(self, status: int, body: bytes, *, content_type: str = 'application/json') -> None:
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        )
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:  # pragma: no cover -- peer disconnect timing is controlled by the OS.
            pass

    def trusted(self) -> bool:
        return (
            self.headers.get_all('Host') == [self.state.address]
            and self.headers.get('Origin', self.state.origin) == self.state.origin
        )

    def do_GET(self) -> None:
        if not self.trusted():
            self.reply(403, b'{"error":"Forbidden"}')
        elif self.path != '/':
            self.reply(404, b'{"error":"Not found"}')
        else:
            self.reply(200, self.state.page, content_type='text/html; charset=utf-8')

    def do_POST(self) -> None:
        if not self.trusted() or not secrets.compare_digest(
            self.headers.get('Authorization', ''), f'Bearer {self.state.token}'
        ):
            self.reply(403, b'{"error":"Forbidden"}')
            return
        if self.path != '/api/chat':
            self.reply(404, b'{"error":"Not found"}')
            return
        if self.headers.get('Transfer-Encoding') is not None or self.headers.get_content_type() != 'application/json':
            self.reply(400, b'{"error":"Expected JSON with Content-Length"}')
            return
        try:
            lengths = self.headers.get_all('Content-Length', [])
            length = int(lengths[0]) if len(lengths) == 1 else 0
            if not 0 < length <= 262144:
                raise ValueError('Invalid length')
            request = ChatRequest.model_validate_json(self.rfile.read(length))
            if not request.text.strip():
                raise ValueError('Empty prompt')
        except (ValueError, ValidationError, OSError):
            self.reply(400, b'{"error":"Invalid prompt or request size"}')
            return
        if not self.state.busy.acquire(blocking=False):
            self.reply(409, b'{"error":"A turn is already running"}')
            return
        try:
            output = self.state.portal.call(self.state.callback, request.text)
        except Exception:  # noqa: BLE001 -- do not disclose provider credentials or tool errors.
            self.reply(500, b'{"error":"Run failed or server stopped. Check model and plugin configuration."}')
        else:
            self.reply(200, json.dumps({'output': output}).encode())
        finally:
            self.state.busy.release()


@asynccontextmanager
async def serve_chat(callback: Callable[[str], Awaitable[str]], *, port: int = 0) -> AsyncGenerator[str]:
    """Own the listening socket, worker threads, and all submitted turns."""
    async with BlockingPortal() as portal:
        server = _ChatServer(callback, portal=portal, port=port)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}, name='clai2-web')
        thread.start()
        try:
            yield f'{server.origin}/#{server.token}'
        finally:
            with CancelScope(shield=True):
                await to_thread.run_sync(server.shutdown)
                await portal.stop(cancel_remaining=True)
                await to_thread.run_sync(server.server_close)
                await to_thread.run_sync(thread.join)
