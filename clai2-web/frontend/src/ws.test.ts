import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from './api/types';
import { connectWs, parseMessage, wsUrl, type WsHandlers } from './ws';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function makeHandlers(): WsHandlers & { onSnapshot: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn>; onConnected: ReturnType<typeof vi.fn> } {
  return { onSnapshot: vi.fn(), onEvent: vi.fn(), onConnected: vi.fn() };
}

const factory = (url: string) => new FakeWebSocket(url) as unknown as WebSocket;

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (socket === undefined) {
    throw new Error('no socket was created');
  }
  return socket;
}

describe('parseMessage', () => {
  it('returns null for non-string data', () => {
    expect(parseMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseMessage(42)).toBeNull();
    expect(parseMessage(undefined)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseMessage('{nope')).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(parseMessage('"hello"')).toBeNull();
    expect(parseMessage('null')).toBeNull();
  });

  it('returns null for an object without a type field', () => {
    expect(parseMessage('{"agents": []}')).toBeNull();
  });

  it('parses a snapshot with agents, approvals, projects, and maxAgents', () => {
    const agents = [{ id: 'a1' }];
    const approvals = [{ id: 'ap1' }];
    const projects = [{ id: 'p1' }];
    expect(parseMessage(JSON.stringify({ type: 'snapshot', agents, approvals, projects, maxAgents: 250 }))).toEqual({
      kind: 'snapshot',
      snapshot: { agents, approvals, projects, maxAgents: 250 },
    });
  });

  it('defaults missing snapshot fields', () => {
    expect(parseMessage('{"type": "snapshot"}')).toEqual({
      kind: 'snapshot',
      snapshot: { agents: [], approvals: [], projects: [], maxAgents: 100 },
    });
  });

  it('passes any other typed object through as an event', () => {
    const event: ServerEvent = { type: 'agentRemoved', agentId: 'a1' };
    expect(parseMessage(JSON.stringify(event))).toEqual({ kind: 'event', event });
  });
});

describe('wsUrl', () => {
  it('maps http to ws', () => {
    expect(wsUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/ws');
  });

  it('maps https to wss', () => {
    expect(wsUrl({ protocol: 'https:', host: 'example.com' })).toBe('wss://example.com/api/ws');
  });
});

describe('connectWs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens a socket to the given url and reports the connection', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x/api/ws', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    const socket = lastSocket();
    expect(socket.url).toBe('ws://x/api/ws');
    expect(handlers.onConnected).not.toHaveBeenCalled();
    socket.onopen?.();
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
    expect(handlers.onConnected).toHaveBeenCalledWith(true);
    conn.close();
  });

  it('uses the global WebSocket constructor by default', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const conn = connectWs('ws://default/api/ws', makeHandlers());
    expect(lastSocket().url).toBe('ws://default/api/ws');
    conn.close();
    expect(lastSocket().closeCalls).toBe(1);
  });

  it('dispatches snapshot messages to onSnapshot', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    const data = JSON.stringify({ type: 'snapshot', agents: [{ id: 'a1' }], approvals: [], projects: [], maxAgents: 100 });
    lastSocket().onmessage?.(new MessageEvent('message', { data }));
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1);
    expect(handlers.onSnapshot).toHaveBeenCalledWith({
      agents: [{ id: 'a1' }],
      approvals: [],
      projects: [],
      maxAgents: 100,
    });
    expect(handlers.onEvent).not.toHaveBeenCalled();
    conn.close();
  });

  it('dispatches event messages to onEvent', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    const event: ServerEvent = { type: 'agentError', agentId: 'a1', message: 'boom' };
    lastSocket().onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onEvent).toHaveBeenCalledWith(event);
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
    conn.close();
  });

  it('ignores malformed messages', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    lastSocket().onmessage?.(new MessageEvent('message', { data: '{broken' }));
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
    expect(handlers.onEvent).not.toHaveBeenCalled();
    conn.close();
  });

  it('reports disconnect and reconnects after the delay', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    const first = lastSocket();
    first.onclose?.();
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
    expect(handlers.onConnected).toHaveBeenCalledWith(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(4);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = lastSocket();
    expect(second).not.toBe(first);
    expect(second.url).toBe('ws://x');
    second.onopen?.();
    expect(handlers.onConnected).toHaveBeenLastCalledWith(true);
    conn.close();
  });

  it('keeps reconnecting after repeated drops', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    lastSocket().onclose?.();
    vi.advanceTimersByTime(5);
    lastSocket().onclose?.();
    vi.advanceTimersByTime(5);
    expect(FakeWebSocket.instances).toHaveLength(3);
    conn.close();
  });

  it('close() closes the socket and a later drop does not reconnect', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    const socket = lastSocket();
    conn.close();
    expect(socket.closeCalls).toBe(1);
    socket.onclose?.();
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
    expect(handlers.onConnected).toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close() while a reconnect timer is pending cancels the reconnect', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    lastSocket().onclose?.();
    conn.close();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a duplicate close event cannot resurrect the connection after close()', () => {
    const handlers = makeHandlers();
    const conn = connectWs('ws://x', handlers, { webSocketFactory: factory, reconnectDelayMs: 5 });
    const socket = lastSocket();
    socket.onclose?.();
    socket.onclose?.();
    conn.close();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
