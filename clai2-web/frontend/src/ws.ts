/** WebSocket client with reconnect; feeds the store. */

import type { ServerEvent } from './api/types';
import type { Snapshot } from './state/store';

export interface WsHandlers {
  onSnapshot: (snapshot: Snapshot) => void;
  onEvent: (event: ServerEvent) => void;
  onConnected: (connected: boolean) => void;
}

export interface WsOptions {
  /** Injection point for tests. */
  webSocketFactory?: (url: string) => WebSocket;
  /** Reconnect delay in milliseconds. */
  reconnectDelayMs?: number;
}

export interface WsConnection {
  close: () => void;
}

type ParsedMessage = { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'event'; event: ServerEvent } | null;

/** Parse one wire message; unknown or malformed input maps to null. */
export function parseMessage(data: unknown): ParsedMessage {
  if (typeof data !== 'string') {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return null;
  }
  const typed = value as { type: string } & Record<string, unknown>;
  if (typed.type === 'snapshot') {
    return {
      kind: 'snapshot',
      snapshot: {
        agents: (typed.agents as Snapshot['agents']) ?? [],
        approvals: (typed.approvals as Snapshot['approvals']) ?? [],
        projects: (typed.projects as Snapshot['projects']) ?? [],
      },
    };
  }
  return { kind: 'event', event: typed as unknown as ServerEvent };
}

export function wsUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/ws`;
}

/** Connect and keep reconnecting until closed. */
export function connectWs(url: string, handlers: WsHandlers, options: WsOptions = {}): WsConnection {
  const factory = options.webSocketFactory ?? ((target: string) => new WebSocket(target));
  const delay = options.reconnectDelayMs ?? 2000;
  let closed = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) {
      return;
    }
    socket = factory(url);
    socket.onopen = () => handlers.onConnected(true);
    socket.onmessage = (message: MessageEvent) => {
      const parsed = parseMessage(message.data);
      if (parsed?.kind === 'snapshot') {
        handlers.onSnapshot(parsed.snapshot);
      } else if (parsed?.kind === 'event') {
        handlers.onEvent(parsed.event);
      }
    };
    socket.onclose = () => {
      handlers.onConnected(false);
      if (!closed) {
        timer = setTimeout(open, delay);
      }
    };
  };
  open();

  return {
    close: () => {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      socket?.close();
    },
  };
}
