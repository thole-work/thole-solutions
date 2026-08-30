import type { Ctx, Env } from './types';
import { COLUMNS, JSON_COLS, BUSINESS_TABLES, GLOBAL_TABLES } from './types';
import { HttpError, requireAuth } from './auth';
import { Db, tableIsGlobal, tableIsChild, childParent, validColumns } from './db';
import { uuid, nowIso, apiError } from './util';

const FORBIDDEN_WRITE: Record<string, string> = {
  users: 'Create users through signup.',
  businesses: 'Create businesses (and become owner) through create_business.',
  receipt_number_counters: 'Receipt numbers are managed by the API layer.',
  business_types: 'System-managed.',
  modules: 'System-managed.',
  business_type_modules: 'System-managed.',
};

// businesses: inserts stay forbidden, but the app updates settings on the
// business row (settings tab). Allow only the owner-editable columns.
const BUSINESSES_UPDATE_COLS = new Set(['settings', 'name', 'address', 'phone', 'tax_id']);

function jsonStringifyWrite(table: string, obj: Record<string, unknown>): void {
  for (const col of JSON_COLS[table] ?? []) {
    const v = obj[col];
    if (v !== undefined && v !== null && typeof v !== 'string') obj[col] = JSON.stringify(v);
  }
}

export async function handleCrud(env: Env, ctx: Ctx, url: URL, req: Request): Promise<Response> {
  const match = /^\/rest\/v1\/([a-z_]+)\/?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, 'Not found');
  const table = match[1]!;
  if (!COLUMNS[table]) throw new HttpError(404, `Unknown table: ${table}`);

  requireAuth(ctx);
  const membership = ctx.membership;

  if (!tableIsGlobal(table) && !membership) {
    throw new HttpError(403, 'A business membership is required for this data');
  }

  const selectStr = url.searchParams.get('select') ?? '*';
  const filters: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    // Two PostgREST filter dialects: `eq.col=val` (newer) and `col=eq.val` (classic).
    const m = /^(eq|neq|lt|lte|gt|gte|in)\.(.+)$/.exec(k);
    if (m) {
      filters[`${m[1]}.${m[2]!}`] = v;
    } else {
      const vm = /^(eq|neq|lt|lte|gt|gte|in)\.(.+)$/.exec(v);
      if (vm) filters[`${vm[1]}.${k}`] = vm[2]!;
    }
    // NOTE: `order=x.asc` is a separate key; handled below.
  }
  const filterCols = [...new Set(Object.keys(filters).map((fk) => fk.split('.')[1]!))];
  validateFilterColumns(table, filterCols);

  let order = url.searchParams.get('order');
  // PostgREST also sends `<col>.asc` / `<col>.desc`; the shim's order() does too.
  const orderM = /^([a-z_]+)\.(asc|desc)$/.exec(order ?? '');
  if (orderM) order = orderM[1] ?? null;
  if (order && !validColumns(table).includes(order)) throw new HttpError(400, `Unknown order column: ${order}`);
  const asc = orderM ? orderM[2] === 'asc' : url.searchParams.get('asc') !== 'false';

  let limit: number | null = null;
  let offset = 0;
  const range = url.searchParams.get('range');
  if (range) {
    const [a, b] = range.split('-').map((s) => Number(s));
    limit = (b as number) - (a as number) + 1;
    offset = a as number;
  }
  const limitP = url.searchParams.get('limit');
  if (limitP !== null && /^\d+$/.test(limitP)) limit = Math.floor(Number(limitP));
  const offsetP = url.searchParams.get('offset');
  if (offsetP !== null && /^\d+$/.test(offsetP)) offset = Math.floor(Number(offsetP));

  const db = new Db(env.DB, membership?.business_id ?? null);
  const method = req.method.toUpperCase();

  // ---------------- READ ----------------
  if (method === 'GET') {
    const rows = await db.select(table, selectStr, { filters, order, asc, limit, offset });
    const single = url.searchParams.get('single') === 'true';
    if (single) {
      if (rows.length === 0) throw new HttpError(406, 'Row not found');
      if (rows.length > 1) throw new HttpError(406, 'Multiple rows returned for single query');
      return new Response(JSON.stringify(rows[0]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // ---------------- WRITES ----------------
  if (FORBIDDEN_WRITE[table] && !(method === 'PATCH' && table === 'businesses')) {
    throw new HttpError(403, FORBIDDEN_WRITE[table]);
  }

  const body = await req.text().then((t) => {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? v : [v];
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
  });

  if (method === 'POST') {
    const out: Record<string, unknown>[] = [];
    for (const row of body as Record<string, unknown>[]) {
      const prepared = prepareInsert(table, row, ctx);
      if (tableIsChild(table)) await assertParentInScope(env, table, prepared, ctx);
      await db.insert(table, prepared);
      const id = prepared['id'] as string;
      const sel = await db.select(table, selectStr, { filters: { ['eq.id']: id }, order: null, asc: true, limit: 1, offset: 0 });
      out.push(sel[0] ?? prepared);
    }
    return new Response(JSON.stringify(out.length === 1 ? out[0] : out), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (method === 'PATCH') {
    const patch = (body as Record<string, unknown>[])[0] ?? {};
    const cols = Object.keys(patch);
    for (const c of cols) {
      if (!validColumns(table).includes(c) || c === '*' || c === 'id') {
        throw new HttpError(400, `Unknown column: ${c}`);
      }
      if (table === 'businesses' && !BUSINESSES_UPDATE_COLS.has(c)) {
        throw new HttpError(403, `Column not editable: ${c}`);
      }
    }
    // Match rows via filters (supabase PATCH targets the filtered set).
    const matched = await db.select(table, table === 'orders' ? 'id, status' : 'id', { filters, order, asc, limit, offset });
    if (!matched.length) return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    const ids = matched.map((r) => r['id'] as string);
    jsonStringifyWrite(table, patch);
    const prepared = { ...patch };

    // Receipt numbering (completion flow): assign a per-business sequential
    // number atomically the first time an order becomes completed.
    if (table === 'orders' && prepared['status'] === 'completed') {
      const notCompleted = matched.filter((r) => r['status'] !== 'completed').map((r) => r['id'] as string);
      if (notCompleted.length) {
        const stmts: D1PreparedStatement[] = [];
        for (const orderId of notCompleted) {
          stmts.push(
            env.DB
              .prepare('INSERT INTO receipt_number_counters (business_id, last_number) VALUES (?, 1) ON CONFLICT(business_id) DO UPDATE SET last_number = last_number + 1')
              .bind(membership!.business_id),
            env.DB
              .prepare('UPDATE orders SET receipt_number = (SELECT last_number FROM receipt_number_counters WHERE business_id = ?) WHERE id = ? AND receipt_number IS NULL')
              .bind(membership!.business_id, orderId)
          );
        }
        await env.DB.batch(stmts);
      }
    }

    for (const id of ids) await db.update(table, id, prepared);
    const rows = await db.select(table, selectStr, { filters: { [`in.id`]: ids.join(',') }, order, asc, limit: null, offset: 0 });
    return new Response(JSON.stringify(rows.length === 1 ? rows[0] : rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (method === 'DELETE') {
    const matched = await db.select(table, 'id', { filters, order, asc, limit, offset });
    const ids = matched.map((r) => r['id'] as string);
    for (const id of ids) await db.del(table, id);
    return new Response(JSON.stringify({ count: ids.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  throw new HttpError(405, 'Method not allowed');
}

function validateFilterColumns(table: string, cols: string[]): void {
  const ok = new Set(validColumns(table));
  for (const c of cols) {
    if (!ok.has(c)) throw new HttpError(400, `Unknown filter column: ${c}`);
  }
}

// Security-critical: force business scoping on every insert of a scoped table,
// default created_at, generate ids/tokens server-side.
function prepareInsert(table: string, row: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (!validColumns(table).includes(k) || k === '*') throw new HttpError(400, `Unknown column: ${k}`);
    out[k] = v;
  }
  const cols = COLUMNS[table]!;

  if (BUSINESS_TABLES.has(table)) {
    out['business_id'] = ctx.membership!.business_id; // never trust the client
  }
  if (cols.includes('created_at') && out['created_at'] === undefined) out['created_at'] = nowIso();
  if (cols.includes('updated_at') && out['updated_at'] === undefined) out['updated_at'] = nowIso();
  if (cols.includes('id') && out['id'] === undefined) out['id'] = uuid();

  if (tableIsChild(table)) {
    const parent = childParent(table)!;
    const parentCol = parent === 'products' ? 'product_id' : parent === 'orders' ? 'order_id' : 'purchase_order_id';
    const val = out[parentCol];
    if (val === undefined) throw new HttpError(400, `Missing ${parentCol}`);
  }

  if (table === 'invites' && out['token'] === undefined) out['token'] = uuid().replace(/-/g, '');
  if (table === 'invites' && out['status'] === undefined) out['status'] = 'pending';
  if (table === 'invites' && out['expires_at'] === undefined) out['expires_at'] = nowIso();

  jsonStringifyWrite(table, out);
  return out;
}

// The parent row of a child-table insert must belong to the caller's business.
async function assertParentInScope(env: Env, table: string, prepared: Record<string, unknown>, ctx: Ctx): Promise<void> {
  const parent = childParent(table)!;
  const parentCol = parent === 'products' ? 'product_id' : parent === 'orders' ? 'order_id' : 'purchase_order_id';
  const val = prepared[parentCol];
  if (val === undefined) throw new HttpError(400, `Missing ${parentCol}`);
  const found = await env.DB.prepare(`SELECT id FROM ${parent} WHERE id = ? AND business_id = ?`)
    .bind(val as string, ctx.membership!.business_id)
    .first();
  if (!found) throw new HttpError(403, 'Parent row does not belong to this business');
}

// Re-export so rpc/index can share error helpers.
export { apiError };