import type { LiveServerMessage } from '@runner/live-protocol';

/**
 * The live session WebSocket client.
 *
 * Commands are sent as typed protocol messages — never as anything resembling
 * browser instructions. The workspace asks the Runner to "preview this
 * selector"; what that means in Playwright terms is the worker's business
 * (blueprint section 3.1).
 *
 * Reconnection is exponential with a cap: a live session holds a real browser,
 * so a client that reconnects aggressively would keep a dead session's
 * resources pinned.
 */

export type LiveSocketStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface LiveSocketHandlers {
  onMessage(message: LiveServerMessage): void;
  onStatusChange(status: LiveSocketStatus): void;
}

const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10_000;

export class LiveSocket {
  private socket: WebSocket | undefined;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: number | undefined;
  private closedByClient = false;

  constructor(
    private readonly sessionId: string,
    private readonly handlers: LiveSocketHandlers,
  ) {}

  connect(): void {
    this.closedByClient = false;
    this.handlers.onStatusChange('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/api/v1/live-sessions/${encodeURIComponent(this.sessionId)}/ws`;

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectDelay = INITIAL_RECONNECT_MS;
      this.handlers.onStatusChange('open');
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        this.handlers.onMessage(JSON.parse(event.data) as LiveServerMessage);
      } catch {
        // A frame the client cannot parse is a protocol mismatch, not a reason
        // to tear down a session that is otherwise healthy.
        this.handlers.onStatusChange('error');
      }
    });

    socket.addEventListener('error', () => this.handlers.onStatusChange('error'));

    socket.addEventListener('close', () => {
      this.handlers.onStatusChange('closed');
      if (!this.closedByClient) this.scheduleReconnect();
    });
  }

  /** Sends a live command. Returns false when the socket is not open. */
  send(command: { id: string; sessionId: string; type: string; payload: unknown }): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ kind: 'command', command }));
    return true;
  }

  ping(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ kind: 'ping' }));
    }
  }

  close(): void {
    this.closedByClient = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    }, this.reconnectDelay);
  }
}
