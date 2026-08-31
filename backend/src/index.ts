import type { Env, Ctx } from './types';
import { HttpError, loadCtx, handleAuth } from './auth';
import { handleCrud } from './crud';
import { handleRpc } from './rpc';
import { realtimeStub, notifyRealtime, RealtimeHub } from './realtime';
import { apiError } from './util';

export { RealtimeHub };

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, apikey, x-client-info',
  'access-control-expose-headers': 'content-range, x-total-count',
};

function withCors(res: Response): Response {
  const out = new Response(res.body, { status: res.status, headers: res.headers });
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return withCors(apiError(e.message, e.status));
  const status = (e as { status?: number }).status ?? 500;
  const message = (e as { message?: string }).message ?? 'Internal server error';
  return withCors(apiError(message, status));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

    // Realtime websockets (delegated to the global hub instance)
    if (url.pathname.startsWith('/realtime/')) {
      return realtimeStub(env).fetch(request);
    }

    // Auth (supabase auth.go compatibility)
    if (url.pathname.startsWith('/auth/v1/')) {
      try {
        return withCors(await handleAuth(env, url, request));
      } catch (e) {
        return errorResponse(e);
      }
    }

    // REST (supabase postgrest.go compatibility)
    if (url.pathname.startsWith('/rest/v1/')) {
      try {
        const ctx = await loadCtx(env, request);
        if (url.pathname.includes('/rpc/')) {
          const res = await handleRpc(env, ctx, url, request);
          await afterRealtime(request, env, ctx, res, url.pathname);
          return withCors(res);
        }
        const res = await handleCrud(env, ctx, url, request);
        await afterRealtime(request, env, ctx, res, url.pathname);
        return withCors(res);
      } catch (e) {
        return errorResponse(e);
      }
    }

    if (url.pathname === '/health') return new Response('ok', { status: 200 });
    return new Response('Not found', { status: 404 });
  },
};

// Forward write events to the realtime hub (best-effort).
async function afterRealtime(request: Request, env: Env, ctx: Ctx, res: Response, pathname: string): Promise<void> {
  const method = request.method.toUpperCase();
  if (!(method === 'POST' || method === 'PATCH' || method === 'DELETE')) return;
  if (res.status >= 400) return;

  const table = pathname.replace(/^\/rest\/v1\//, '').split('/')[0]!;
  if (!/^[a-z_]+$/.test(table)) return;

  // RPC writes are invisible to generic table extraction (the path is
  // /rpc/<name>). Real Supabase emits postgres_changes from the DB WAL for the
  // tables an RPC touches, so mirror that here — the app drives its badge,
  // sales list and dashboard from these real table events.
  let tables: string[] = [table];
  if (table === 'rpc') {
    const rpcName = (pathname.match(/\/rpc\/([a-z_]+)$/) ?? [])[1] ?? '';
    const map: Record<string, string[]> = {
      place_order: ['orders', 'order_items'],
      adjust_stock: ['products', 'raw_materials'],
      record_payments: ['payments'],
      create_business: ['businesses', 'business_members'],
    };
    tables = map[rpcName] ?? [];
  }

  const businessId = ctx.membership?.business_id;
  if (!businessId) return;
  const event = method === 'POST' ? 'INSERT' : method === 'PATCH' ? 'UPDATE' : 'DELETE';
  for (const t of tables) await notifyRealtime(env, businessId, t, event);
}