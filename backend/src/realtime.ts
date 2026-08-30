import type { Env } from './types';
import { loadCtx } from './auth';

// ---------------------------------------------------------------------------
// Realtime hub — ONE durable object instance ("global") serving every
// business. Browser clients connect a WebSocket authenticated by JWT; the hub
// resolves the caller's active business from the token. Writes from any
// worker request are forwarded to subscribers as `postgres_changes`-style
// events (the app only consumes `payload.table`, see app.js handleRealtimeEvent).
//
// IMPORTANT: the hub uses the WebSocket Hibernation API (`state.acceptWebSocket`).
// In Hibernation mode client frames are delivered ONLY through the class
// methods webSocketMessage/webSocketClose/webSocketError — addEventListener
// handlers are never invoked. The DO may be evicted while sockets stay open,
// so client records are rebuilt from `state.getWebSockets()` on wake.
// ---------------------------------------------------------------------------

interface Client {
  ws: WebSocket;
  businessId: string;
  userId: string;
  tables: Set<string>;
}

export function realtimeStub(env: Env): DurableObjectStub {
  return env.REALTIME.get(env.REALTIME.idFromName('global'));
}

export class RealtimeHub {
  private clients = new Map<WebSocket, Client>();
  private state: DurableObjectState;

  constructor(state: DurableObjectState, private env: Env) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => this.resyncClients());
  }

  // Restore client records after hibernation eviction/wake.
  private resyncClients(): void {
    for (const ws of this.state.getWebSockets()) {
      if (!this.clients.has(ws)) {
        this.clients.set(ws, { ws, businessId: '', userId: '', tables: new Set(['*']) });
      }
    }
  }

  private ensureClient(ws: WebSocket): Client | undefined {
    let c = this.clients.get(ws);
    if (!c) {
      this.resyncClients();
      c = this.clients.get(ws);
    }
    return c;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Internal broadcast: POST /broadcast { business_id, table, event }
    if (url.pathname === '/broadcast' && req.method === 'POST') {
      const body = (await req.json()) as { business_id: string; table: string; event: string };
      this.broadcast(body.business_id, body);
      return new Response('ok', { status: 200 });
    }

    // Client WebSocket: /realtime/v1/websocket?token=...
    const token = url.searchParams.get('token') ?? '';
    if (!token) return new Response('missing token', { status: 401 });
    const ctx = await loadCtx(this.env, new Request('https://x/', { headers: { authorization: `Bearer ${token}` } }));
    if (!ctx.membership) return new Response('not an active member', { status: 403 });

    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket upgrade', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    await this.state.acceptWebSocket(server);

    this.clients.set(server, {
      ws: server,
      businessId: ctx.membership.business_id,
      userId: ctx.userId,
      tables: new Set([]),
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation API — incoming frames from a client land here.
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer | ArrayBufferView): void {
    const c = this.ensureClient(ws);
    if (!c) return;
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message as BufferSource);
    let msg: { event?: string; table?: string };
    try {
      msg = JSON.parse(raw) as { event?: string; table?: string };
    } catch {
      return;
    }
    if (msg.event === 'subscribe' && msg.table) c.tables.add(msg.table);
    else if (msg.event === 'unsubscribe' && msg.table) c.tables.delete(msg.table);
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.clients.delete(ws);
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.clients.delete(ws);
  }

  private broadcast(businessId: string, payload: { table: string; event: string }): void {
    for (const c of this.clients.values()) {
      if (c.businessId !== businessId || c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.tables.has('*') || c.tables.has(payload.table)) {
        try {
          c.ws.send(JSON.stringify({ type: 'postgres_changes', schema: 'public', table: payload.table, eventType: payload.event, payload: { table: payload.table, schema: 'public', eventType: payload.event } }));
        } catch {
          /* socket closed mid-send */
        }
      }
    }
  }
}

// Send an event to the hub for the given business (fire-and-forget).
export async function notifyRealtime(env: Env, businessId: string, table: string, event: string): Promise<void> {
  try {
    await realtimeStub(env).fetch(new Request('https://do/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ business_id: businessId, table, event }),
    }));
  } catch {
    /* realtime is best-effort */
  }
}