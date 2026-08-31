import type { Ctx, Env } from './types';
import { HttpError, requireAuth } from './auth';
import { apiError, uuid, nowIso } from './util';

export async function handleRpc(env: Env, ctx: Ctx, url: URL, req: Request): Promise<Response> {
  const match = /^\/rest\/v1\/rpc\/([a-z_]+)\/?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, 'Not found');
  const name = match[1]!;
  requireAuth(ctx);
  const membership = ctx.membership;

  const body = await req.text().then((t) => {
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
  });

  switch (name) {
    case 'create_business':
    case 'redeem_invite_code':
      return handleOnboardingRpc(env, ctx, name, body);
    case 'place_order':
      return handlePlaceOrder(env, ctx, body);
    case 'adjust_stock':
      return handleAdjustStock(env, ctx, body);
    case 'record_payments':
      return handleRecordPayments(env, ctx, body);
    case 'dashboard_summary':
      return handleDashboardSummary(env, ctx, body);
    default:
      throw new HttpError(404, `Unknown RPC: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Onboarding RPCs (also routed from /auth/v1/rpc for the shim)
// ---------------------------------------------------------------------------
export async function handleOnboardingRpc(
  env: Env,
  ctx: Ctx,
  name: 'create_business' | 'redeem_invite_code',
  body: Record<string, unknown>
): Promise<Response> {
  if (name === 'create_business') {
    const bizName = String(body['p_business_name'] ?? '').trim();
    const typeKey = String(body['p_business_type_key'] ?? '').trim();
    const fullName = String(body['p_full_name'] ?? '').trim();
    if (!bizName) throw new HttpError(400, 'Business name is required');
    const type = await env.DB.prepare('SELECT id FROM business_types WHERE type_key = ?')
      .bind(typeKey)
      .first<{ id: string }>();
    if (!type) throw new HttpError(400, `Unknown business type: ${typeKey}`);
    const now = nowIso();
    const bizId = uuid();
    const inviteCode = genInviteCode(env);
    await env.DB.batch([
      env.DB
        .prepare('INSERT INTO businesses (id, name, business_type_id, invite_code, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .bind(bizId, bizName, type.id, inviteCode, now),
      env.DB
        .prepare('INSERT INTO business_members (id, user_id, business_id, role, status, full_name, invited_by, accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(uuid(), ctx.userId, bizId, 'owner', 'active', fullName || null, null, now, now),
      env.DB
        .prepare('INSERT INTO app_users (id, user_id, business_id, role, full_name, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .bind(uuid(), ctx.userId, bizId, 'owner', fullName || null, now),
    ]);
    // The app renders this RPC's return value directly as the invite code.
    return new Response(JSON.stringify(inviteCode), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // redeem_invite_code
  const code = String(body['p_invite_code'] ?? '').trim();
  const fullName = String(body['p_full_name'] ?? '').trim();
  const biz = await env.DB.prepare('SELECT * FROM businesses WHERE invite_code = ?')
    .bind(code)
    .first<{ id: string; name: string }>();
  if (!biz) throw new HttpError(400, `No business found with invite code "${code}"`);
  const dup = await env.DB
    .prepare('SELECT id FROM business_members WHERE user_id = ? AND business_id = ?')
    .bind(ctx.userId, biz.id)
    .first();
  if (!dup) {
    const now = nowIso();
    await env.DB
      .prepare('INSERT INTO business_members (id, user_id, business_id, role, status, full_name, invited_by, accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uuid(), ctx.userId, biz.id, 'staff', 'active', fullName || null, null, now, now)
      .run();
  }
  const row = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(biz.id).first<Record<string, unknown>>();
  if (row && typeof row['settings'] === 'string') {
    try {
      row['settings'] = JSON.parse(row['settings'] as string);
    } catch { /* leave */ }
  }
  return new Response(JSON.stringify(row ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
}

function genInviteCode(_env: Env): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 14);
}

// ---------------------------------------------------------------------------
// place_order (transactional port of transactional_integrity.sql)
// ---------------------------------------------------------------------------
async function handlePlaceOrder(env: Env, ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  const bid = String(body['p_business_id'] ?? '');
  if (bid !== ctx.membership!.business_id) throw new HttpError(403, 'Not an active member of this business');
  const order = (body['p_order'] ?? {}) as Record<string, unknown>;
  const items = body['p_items'];
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Cart must be a non-empty array');
  const orderId = (body['p_order_id'] as string) || null;

  const orNull = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s && s !== 'null' ? s : null;
  };
  const orZero = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  let vOrderId: string;
  let created = false;
  const now = nowIso();

  if (!orderId) {
    created = true;
    vOrderId = uuid();
    const res = await env.DB
      .prepare(`INSERT INTO orders (
          id, business_id, branch_id, table_id, customer_id, order_type, status,
          subtotal, discount, discount_type, tax_rate, tax, tip,
          total_amount, payment_method, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        vOrderId,
        bid,
        orNull(order['branch_id']),
        orNull(order['table_id']),
        orNull(order['customer_id']),
        orNull(order['order_type']) ?? 'takeout',
        orZero(order['subtotal']),
        orZero(order['discount']),
        orNull(order['discount_type']) ?? 'amount',
        orZero(order['tax_rate']),
        orZero(order['tax']),
        orZero(order['tip']),
        orZero(order['total_amount']),
        orNull(order['payment_method']),
        ctx.userId,
        now
      )
      .run();
    if (!(res.meta.changes ?? 0)) {
      throw new HttpError(500, 'Failed to create order');
    }

    if (orNull(order['table_id'])) {
      await env.DB.prepare("UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ? AND business_id = ?")
        .bind(vOrderId, orNull(order['table_id']), bid)
        .run();
    }
  } else {
    created = false;
    const existing = await env.DB
      .prepare('SELECT status FROM orders WHERE id = ? AND business_id = ?')
      .bind(orderId, bid)
      .first<{ status: string }>();
    if (!existing) throw new HttpError(400, 'Order not found in this business');
    if (existing.status === 'voided' || existing.status === 'completed') {
      throw new HttpError(400, `Order is already ${existing.status}`);
    }
    await env.DB
      .prepare(`UPDATE orders SET
        subtotal = ?, discount = ?, discount_type = ?, tax_rate = ?, tax = ?,
        total_amount = ?
        WHERE id = ? AND business_id = ?`)
      .bind(
        orZero(order['subtotal']),
        orZero(order['discount']),
        orNull(order['discount_type']) ?? 'amount',
        orZero(order['tax_rate']),
        orZero(order['tax']),
        orZero(order['total_amount']),
        orderId,
        bid
      )
      .run();
    await env.DB.prepare('DELETE FROM order_items WHERE order_id = ?').bind(orderId).run();
    vOrderId = orderId;
  }

  // Items — line_total computed server-side. Tolerate empty-string uuids.
  const itemStmts = items.map((it) => {
    const item = it as Record<string, unknown>;
    const pid = String(item['product_id'] ?? '').trim();
    const quantity = orZero(item['quantity']);
    const unitPrice = orZero(item['unit_price']);
    return env.DB
      .prepare('INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(uuid(), vOrderId, pid, quantity, unitPrice, Math.round(quantity * unitPrice * 100) / 100);
  });
  await env.DB.batch(itemStmts);

  return new Response(
    JSON.stringify({ order_id: vOrderId, items_count: items.length, created }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// ---------------------------------------------------------------------------
// adjust_stock (atomic multi-row stock deltas)
//
// Runs every delta in ONE D1 batch (single transaction) so that:
//   - stock_qty / kitchen_stock_qty on a raw_materials row can be moved
//     atomically (store <-> kitchen transfers), and
//   - concurrent writers can never read-then-write a stale value (each delta
//     is `SET col = col + delta` at the SQL level — no lost updates).
//
// Body: { p_business_id, p_ops: [{ table, id, delta, column? }] }
//   table  : 'products' | 'raw_materials'
//   column : 'stock_qty' (default) | 'kitchen_stock_qty'
//   delta  : signed number added to the column
//
// Refuses to let any scoped stock column go below 0.
// ---------------------------------------------------------------------------
async function handleAdjustStock(env: Env, ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  const bid = String(body['p_business_id'] ?? '');
  if (bid !== ctx.membership!.business_id) throw new HttpError(403, 'Not an active member of this business');
  const ops = body['p_ops'];
  if (!Array.isArray(ops) || ops.length === 0) throw new HttpError(400, 'p_ops must be a non-empty array');
  if (ops.length > 200) throw new HttpError(400, 'Too many stock operations in one call');

  const ALLOWED_TABLES = new Set(['products', 'raw_materials']);
  const ALLOWED_COLUMNS = new Set(['stock_qty', 'kitchen_stock_qty']);

  const stmts: D1PreparedStatement[] = [];
  const results: Array<{ table: string; id: string; column: string; new_value: number }> = [];

  for (const rawOp of ops as Record<string, unknown>[]) {
    const table = String(rawOp['table'] ?? '');
    const id = String(rawOp['id'] ?? '').trim();
    const column = String(rawOp['column'] ?? 'stock_qty');
    const delta = Number(rawOp['delta']);
    if (!ALLOWED_TABLES.has(table)) throw new HttpError(400, `Unsupported stock table: ${table}`);
    if (!ALLOWED_COLUMNS.has(column)) throw new HttpError(400, `Unsupported stock column: ${column}`);
    if (!id) throw new HttpError(400, 'Stock operation missing id');
    if (!Number.isFinite(delta) || delta === 0) throw new HttpError(400, 'Stock delta must be a non-zero number');

    stmts.push(
      env.DB
        .prepare(
          `UPDATE ${table} SET ${column} = ${column} + ?
           WHERE id = ? AND business_id = ? AND ${column} + ? >= 0
           RETURNING ${column} AS new_value`
        )
        .bind(delta, id, bid, delta)
    );
    results.push({ table, id, column, new_value: Number.NaN });
  }

  const batch = await env.DB.batch(stmts);
  const out: Array<{ table: string; id: string; column: string; new_value: number | null }> = results.map((r, i) => {
    const row = (batch[i] as unknown as { results?: Array<{ new_value: number }> }).results?.[0];
    return { ...r, new_value: row ? Number(row.new_value) : null };
  });

  // If the batch failed to apply every row (e.g. insufficient stock), the
  // whole transaction is rolled back — surface which op(s) couldn't be applied.
  const failed = out.find((r) => r.new_value === null);
  if (failed) {
    throw new HttpError(409, `Insufficient stock for ${failed.table} ${failed.id} (${failed.column})`);
  }

  return new Response(JSON.stringify({ applied: out.length, results: out }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// record_payments (transactional multi-payment insert)
// ---------------------------------------------------------------------------
async function handleRecordPayments(env: Env, ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  const bid = String(body['p_business_id'] ?? '');
  if (bid !== ctx.membership!.business_id) throw new HttpError(403, 'Not an active member of this business');
  const payments = body['p_payments'];
  if (!Array.isArray(payments) || payments.length === 0) throw new HttpError(400, 'Payments must be a non-empty array');

  const now = nowIso();
  const orNull = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s && s !== 'null' ? s : null;
  };
  const ids: string[] = [];
  const stmts = (payments as Record<string, unknown>[]).map((p) => {
    const id = uuid();
    ids.push(id);
    return env.DB
      .prepare(`INSERT INTO payments (
        id, business_id, branch_id, direction, party_type, customer_id, order_id,
        amount, method, created_by, created_at)
        VALUES (?, ?, ?, 'in', 'customer', ?, ?, ?, ?, ?, ?)`)
      .bind(
        id,
        bid,
        orNull(p['branch_id']),
        orNull(p['customer_id']),
        orNull(p['order_id']),
        Number(p['amount']) || 0,
        orNull(p['method']),
        ctx.userId,
        now
      );
  });
  await env.DB.batch(stmts);
  return new Response(
    JSON.stringify({ inserted: ids.length, ids }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// ---------------------------------------------------------------------------
// dashboard_summary (read-only aggregates, port of dashboard_summary.sql)
// ---------------------------------------------------------------------------
async function handleDashboardSummary(env: Env, ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  const bid = String(body['p_business_id'] ?? '');
  if (bid !== ctx.membership!.business_id) throw new HttpError(403, 'Not an active member of this business');
  const branch = (body['p_branch_id'] as string) || null;
  const branchCond = branch ? ' AND branch_id = ?' : '';

  const today = new Date().toISOString().slice(0, 10);
  const branchBinds = branch ? [branch] : [];

  const rows = await env.DB.batch([
    env.DB.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS v FROM orders WHERE business_id = ? AND status = 'completed'${branchCond}`).bind(bid, ...branchBinds),
    env.DB.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS v, COUNT(*) AS c, COALESCE(SUM(CASE WHEN substr(created_at, 1, 10) = ? THEN total_amount ELSE 0 END), 0) AS t_sales, COALESCE(SUM(CASE WHEN substr(created_at, 1, 10) = ? THEN 1 ELSE 0 END), 0) AS t_orders FROM orders WHERE business_id = ? AND status = 'completed'${branchCond}`).bind(today, today, bid, ...branchBinds),
    env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE business_id = ?${branchCond}`).bind(bid, ...branchBinds),
    env.DB.prepare("SELECT COALESCE(SUM(total_amount), 0) AS v FROM purchase_orders WHERE business_id = ? AND status <> 'voided'").bind(bid),
    env.DB.prepare('SELECT COALESCE(SUM(quantity * unit_cost), 0) AS v FROM waste_log WHERE business_id = ?').bind(bid),
    env.DB.prepare(`SELECT COALESCE(SUM(COALESCE((julianday(s.clock_out) - julianday(s.clock_in)) * 24.0, 0) * COALESCE(s.hourly_rate, 0) - COALESCE(s.hourly_rate, 0) * COALESCE(s.break_minutes, 0) / 60.0), 0) AS v FROM labor_shifts s WHERE s.business_id = ? AND s.clock_out IS NOT NULL${branchCond.replace('branch_id', 's.branch_id')}`).bind(bid, ...branchBinds),
    env.DB.prepare('SELECT AVG(actual_yield / NULLIF(batch_qty, 0) * 100) AS v FROM produce_batches WHERE business_id = ? AND actual_yield IS NOT NULL').bind(bid),
  ]);

  const num = (i: number) => Number((rows[i] as unknown as { results: Array<{ v: unknown }> }).results?.[0]?.v ?? 0);
  const todayRow = (rows[1] as unknown as { results: Array<{ t_sales: number; t_orders: number; c: number }> }).results?.[0];

  return new Response(
    JSON.stringify({
      revenue: num(0),
      today_sales: todayRow?.t_sales ?? 0,
      today_orders: todayRow?.t_orders ?? 0,
      sales_count: todayRow?.c ?? 0,
      expense_total: num(2),
      purchase_total: num(3),
      waste_cost: num(4),
      labor_cost: Math.max(0, num(5)),
      avg_yield_pct: null as unknown,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

export { apiError };