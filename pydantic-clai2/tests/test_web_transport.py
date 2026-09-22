"""Real loopback requests exercise the browser trust and lifecycle boundaries."""

import json
from http.server import HTTPServer
from urllib.parse import urlsplit

import anyio
import httpx
import pytest

from pydantic_clai2.web_transport import serve_chat


async def echo(text: str) -> str:
    return text


async def test_default_http_port_normalization(monkeypatch: pytest.MonkeyPatch) -> None:
    bind = HTTPServer.server_bind
    ports: list[int] = []

    def bind_as_default(server: HTTPServer) -> None:
        bind(server)
        ports.append(server.server_port)
        server.server_port = 80

    monkeypatch.setattr(HTTPServer, 'server_bind', bind_as_default)
    async with serve_chat(echo) as url, httpx.AsyncClient() as client:
        assert url.startswith('http://127.0.0.1/#')
        response = await client.post(
            f'http://127.0.0.1:{ports[0]}/api/chat',
            json={'text': 'default port'},
            headers={
                'Host': '127.0.0.1',
                'Origin': 'http://127.0.0.1',
                'Authorization': f'Bearer {urlsplit(url).fragment}',
            },
        )
        assert response.json() == {'output': 'default port'}


async def test_chat_and_page() -> None:
    async with serve_chat(echo) as url, httpx.AsyncClient() as client:
        parsed = urlsplit(url)
        origin = f'{parsed.scheme}://{parsed.netloc}'
        page = await client.get(origin)
        assert page.status_code == 200
        assert 'textContent' in page.text
        assert 'no-store' == page.headers['cache-control']
        assert "frame-ancestors 'none'" in page.headers['content-security-policy']
        response = await client.post(
            origin + '/api/chat',
            json={'text': '<script>hello</script>'},
            headers={'Authorization': f'Bearer {parsed.fragment}', 'Origin': origin},
        )
        assert response.json() == {'output': '<script>hello</script>'}
        assert (await client.get(origin + '/missing')).status_code == 404
        assert (await client.get(origin, headers={'Host': 'attacker.test'})).status_code == 403


@pytest.mark.parametrize(
    ('headers', 'body', 'path', 'status'),
    [
        ({'Authorization': 'wrong'}, '{"text":"hello"}', '/api/chat', 403),
        ({'Origin': 'https://attacker.test'}, '{"text":"hello"}', '/api/chat', 403),
        ({'Host': 'attacker.test'}, '{"text":"hello"}', '/api/chat', 403),
        ({}, '{"text":"hello"}', '/wrong', 404),
        ({'Content-Type': 'text/plain'}, '{"text":"hello"}', '/api/chat', 400),
        ({}, '{"text":" "}', '/api/chat', 400),
        ({}, '{"text":5}', '/api/chat', 400),
        ({}, 'broken', '/api/chat', 400),
        ({}, '', '/api/chat', 400),
        ({}, json.dumps({'text': 'x' * 65537}), '/api/chat', 400),
    ],
)
async def test_rejected_requests(headers: dict[str, str], body: str, path: str, status: int) -> None:
    async def never(text: str) -> str:
        pytest.fail('Untrusted request reached callback')

    async with serve_chat(never) as url, httpx.AsyncClient() as client:
        parsed = urlsplit(url)
        response = await client.post(
            f'http://{parsed.netloc}{path}',
            content=body,
            headers={'Authorization': f'Bearer {parsed.fragment}', 'Content-Type': 'application/json'} | headers,
        )
        assert response.status_code == status


async def test_failure_does_not_disclose_details() -> None:
    async def fail(text: str) -> str:
        raise ValueError('SECRET')

    async with serve_chat(fail) as url, httpx.AsyncClient() as client:
        parsed = urlsplit(url)
        response = await client.post(
            f'http://{parsed.netloc}/api/chat',
            json={'text': 'hello'},
            headers={'Authorization': f'Bearer {parsed.fragment}'},
        )
        assert response.status_code == 500
        assert 'SECRET' not in response.text


async def test_serialized_turns_and_shutdown_cancellation() -> None:
    started = anyio.Event()
    cancelled = anyio.Event()
    response_done = anyio.Event()

    async def wait(text: str) -> str:
        started.set()
        try:
            await anyio.sleep_forever()
        finally:
            cancelled.set()
        return 'unreachable'  # pragma: no cover

    async with httpx.AsyncClient() as client, anyio.create_task_group() as tasks:
        async with serve_chat(wait) as url:
            parsed = urlsplit(url)
            endpoint = f'http://{parsed.netloc}/api/chat'
            headers = {'Authorization': f'Bearer {parsed.fragment}'}

            async def first() -> None:
                response = await client.post(endpoint, json={'text': 'first'}, headers=headers)
                assert response.status_code == 500
                response_done.set()

            tasks.start_soon(first)
            with anyio.fail_after(5):
                await started.wait()
                response = await client.post(endpoint, json={'text': 'second'}, headers=headers)
                assert response.status_code == 409
        assert cancelled.is_set()
        with anyio.fail_after(5):
            await response_done.wait()
        with pytest.raises(httpx.ConnectError):
            await client.get(f'http://{parsed.netloc}/')
