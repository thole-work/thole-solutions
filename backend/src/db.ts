import { BUSINESS_TABLES, CHILD_TABLES, GLOBAL_TABLES, JSON_COLS, allColumns } from './types';
import { uuid } from './util';

type Filters = Record<string, string>;

export interface QueryOpts {
  filters?: Filters;
  order?: string | null;
  asc?: boolean;
  limit?: number | null;
  offset?: number;
}

interface Rel {
  parentCol: string;
  childCol: string;
  one: boolean;
}

// Relationship registry: [parentTable][embedName] -> candidate FKs. When
// multiple relations exist between the same pair (hint is present when the
// child is embedded twice, e.g. `payments(customers!supplier_id!)`), the hint
// names the FK column on the *parent*.
const REL: Record<string, Record<string, Rel[]>> = {
  business_members: {
    businesses: [{ parentCol: 'business_id', childCol: 'id', one: true }],
  },
  app_users: {
    businesses: [{ parentCol: 'business_id', childCol: 'id', one: true }],
  },
  businesses: {
    business_types: [{ parentCol: 'business_type_id', childCol: 'id', one: true }],
  },
  business_types: {
    business_type_modules: [{ parentCol: 'id', childCol: 'business_type_id', one: false }],
  },
  invites: {
    businesses: [{ parentCol: 'business_id', childCol: 'id', one: true }],
  },
  orders: {
    customers: [{ parentCol: 'customer_id', childCol: 'id', one: true }],
    restaurant_tables: [{ parentCol: 'table_id', childCol: 'id', one: true }],
    order_items: [{ parentCol: 'id', childCol: 'order_id', one: false }],
    payments: [{ parentCol: 'id', childCol: 'order_id', one: false }],
  },
  order_items: {
    products: [{ parentCol: 'product_id', childCol: 'id', one: true }],
  },
  products: {
    recipe_items: [{ parentCol: 'id', childCol: 'product_id', one: false }],
  },
  recipe_items: {
    raw_materials: [{ parentCol: 'raw_material_id', childCol: 'id', one: true }],
  },
  raw_materials: {
    recipe_items: [{ parentCol: 'id', childCol: 'raw_material_id', one: false }],
  },
  purchase_orders: {
    suppliers: [{ parentCol: 'supplier_id', childCol: 'id', one: true }],
    purchase_order_items: [{ parentCol: 'id', childCol: 'purchase_order_id', one: false }],
  },
  purchase_order_items: {
    products: [{ parentCol: 'product_id', childCol: 'id', one: true }],
    raw_materials: [{ parentCol: 'raw_material_id', childCol: 'id', one: true }],
  },
  payments: {
    customers: [{ parentCol: 'customer_id', childCol: 'id', one: true }],
    suppliers: [{ parentCol: 'supplier_id', childCol: 'id', one: true }],
  },
  customers: {
    orders: [{ parentCol: 'id', childCol: 'customer_id', one: false }],
  },
  restaurant_tables: {
    // `orders!current_order_id` (table map) resolves the table's live order.
    orders: [
      { parentCol: 'current_order_id', childCol: 'id', one: true },
      { parentCol: 'id', childCol: 'table_id', one: false },
    ],
  },
  waste_log: {
    products: [{ parentCol: 'product_id', childCol: 'id', one: true }],
    raw_materials: [{ parentCol: 'raw_material_id', childCol: 'id', one: true }],
  },
  stock_movements: {
    products: [{ parentCol: 'product_id', childCol: 'id', one: true }],
    raw_materials: [{ parentCol: 'raw_material_id', childCol: 'id', one: true }],
  },
  produce_batches: {
    products: [{ parentCol: 'product_id', childCol: 'id', one: true }],
  },
};

export function tableIsGlobal(table: string): boolean {
  return GLOBAL_TABLES.has(table);
}

export function tableIsChild(table: string): boolean {
  return table in CHILD_TABLES;
}

export function childParent(table: string): string | null {
  return CHILD_TABLES[table]?.parent ?? null;
}

export function validColumns(table: string): string[] {
  return allColumns(table); // includes '*' sentinel at index 0
}

function isBizScoped(table: string): boolean {
  return BUSINESS_TABLES.has(table);
}

function scopeSql(table: string, alias: string, bizId: string): { sql: string; binds: string[] } {
  if (isBizScoped(table)) return { sql: `${alias}.business_id = ?`, binds: [bizId] };
  if (table === 'businesses') return { sql: `${alias}.id = ?`, binds: [bizId] };
  const ch = CHILD_TABLES[table];
  if (ch) {
    return {
      sql: `${alias}.${ch.childCol} IN (SELECT id FROM ${ch.parent} WHERE business_id = ?)`,
      binds: [bizId],
    };
  }
  return { sql: '1 = 1', binds: [] };
}

// SQLite binds 'true'/'false' as text, which never matches INTEGER 1/0 columns.
function filterValue(v: string): unknown {
  if (v === 'true') return 1;
  if (v === 'false') return 0;
  if (v === 'null' || v === '') return null;
  return v;
}

function buildWhere(table: string, filters: Filters, bizId: string | null): { sql: string; binds: unknown[] } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (bizId && !tableIsGlobal(table)) {
    const s = scopeSql(table, 't0', bizId);
    parts.push(s.sql);
    binds.push(...s.binds);
  }
  for (const [key, val] of Object.entries(filters)) {
    const m = /^(eq|neq|lt|lte|gt|gte|in)\.(.+)$/.exec(key);
    if (!m) continue;
    const op = m[1]!;
    const col = m[2]!;
    // sqlite/order params like `order=x.asc` double as `eq.order=x.asc`
    if (op === 'in') {
      const vals = val.split(',').map((s) => s.trim()).filter(Boolean);
      if (vals.length) {
        parts.push(`t0.${col} IN (${vals.map(() => '?').join(',')})`);
        binds.push(...vals.map(filterValue));
      }
    } else {
      const sym = op === 'eq' ? '=' : op === 'neq' ? '<>' : op;
      parts.push(`t0.${col} ${sym} ?`);
      binds.push(filterValue(val));
    }
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', binds };
}

// ---------------------------------------------------------------------------
// Select parser
// ---------------------------------------------------------------------------
export interface SelectTree {
  cols: string[];
  embeds: Array<{ name: string; hint: string | null; inner: SelectTree }>;
}

export function parseSelect(sel: string): SelectTree {
  const root: SelectTree = { cols: [], embeds: [] };
  const stack: SelectTree[] = [root];
  let cur = '';
  const flush = () => {
    const name = cur.trim();
    cur = '';
    if (!name) return;
    const top = stack[stack.length - 1]!;
    top.cols.push(name);
  };
  for (const ch of sel) {
    if (ch === '(') {
      flush();
      const top = stack[stack.length - 1]!;
      const name = top.cols.pop()!; // e.g. "payments!supplier_id"
      let embName = name;
      let hint: string | null = null;
      if (name.includes('!')) {
        const parts = name.split('!');
        embName = parts[0]!;
        hint = parts.slice(1).join('!') || null;
      }
      const emb = { name: embName, hint, inner: { cols: [], embeds: [] } };
      top.embeds.push(emb);
      stack.push(emb.inner);
    } else if (ch === ')') {
      flush();
      if (stack.length > 1) stack.pop();
    } else if (ch === ',') {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return root;
}

function applyJsonParse(table: string, row: Record<string, unknown>): Record<string, unknown> {
  for (const col of JSON_COLS[table] ?? []) {
    const v = row[col];
    if (typeof v === 'string') {
      try {
        row[col] = JSON.parse(v);
      } catch {
        /* leave raw */
      }
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Core: Db with business scoping + JS-side embed resolution
// ---------------------------------------------------------------------------
export class Db {
  constructor(
    private db: D1Database,
    private bizId: string | null
  ) {}

  private async queryRows(table: string, filters: Filters, order: string | null, asc: boolean, limit: number | null, offset: number): Promise<Record<string, unknown>[]> {
    const { sql, binds } = buildWhere(table, filters, this.bizId);
    let q = `SELECT * FROM ${table} AS t0 WHERE ${sql} `;
    if (order && validColumns(table).includes(order)) {
      q += `ORDER BY t0.${order} ${asc ? 'ASC' : 'DESC'} `;
    }
    if (limit !== null) q += `LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`;
    const res = await this.db.prepare(q).bind(...binds).all<Record<string, unknown>>();
    return (res.results ?? []).map((r) => applyJsonParse(table, r));
  }

  // Recursive entry point.
  async select(table: string, select: string, opts: QueryOpts = {}): Promise<Record<string, unknown>[]> {
    const tree = parseSelect(select || '*');
    const rows = await this.queryRows(
      table,
      opts.filters ?? {},
      opts.order ?? null,
      opts.asc ?? true,
      opts.limit ?? null,
      opts.offset ?? 0
    );
    await this.resolveEmbeds(table, rows, tree);
    return rows.map((r) => this.pickColumns(table, tree, r));
  }

  private pickColumns(table: string, tree: SelectTree, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const want = tree.cols.length ? tree.cols : ['*'];
    for (const c of want) {
      if (c === '*') Object.assign(out, row);
      else if (c === 'password_hash') continue; // security
      else if (Object.prototype.hasOwnProperty.call(row, c)) out[c] = row[c];
    }
    // Embeds were resolved onto `row`; re-attach them to the narrowed object.
    for (const emb of tree.embeds) {
      if (Object.prototype.hasOwnProperty.call(row, emb.name)) out[emb.name] = row[emb.name];
    }
    return out;
  }

  private async resolveEmbeds(table: string, rows: Record<string, unknown>[], tree: SelectTree): Promise<void> {
    if (!tree.embeds.length) return;
    for (const emb of tree.embeds) {
      // Special-case cross-relation: products -> recipe_items -> raw_materials.
      if (table === 'products' && emb.name === 'raw_materials') {
        await this.productsRawMaterials(rows, emb);
        continue;
      }
      const rels = (REL[table] ?? {})[emb.name];
      if (!rels || rels.length === 0) {
        for (const r of rows) r[emb.name] = null; // unknown embed -> null
        continue;
      }
      const rel = emb.hint ? rels.find((x) => x.parentCol === emb.hint) ?? rels[0]! : rels[0]!;
      const parentValues = uniqueNonNull(rows.map((r) => r[rel.parentCol]));
      if (!parentValues.length) {
        for (const r of rows) r[emb.name] = rel.one ? null : [];
        continue;
      }
      const children = await this.fetchChildren(emb.name, emb.inner, rel.childCol, parentValues);
      const byKey = groupBy(children, rel.childCol);
      for (const r of rows) {
        const key = r[rel.parentCol];
        const bucket = byKey.get(key as string);
        r[emb.name] = rel.one ? (bucket?.[0] ?? null) : (bucket ?? []);
      }
    }
  }

  // Fetch child rows for one embed, with their own embeds resolved recursively.
  private async fetchChildren(
    childTable: string,
    tree: SelectTree,
    childCol: string,
    parentValues: string[]
  ): Promise<Record<string, unknown>[]> {
    const { sql, binds } = buildWhere(
      childTable,
      { [`in.${childCol}`]: parentValues.join(',') },
      this.bizId
    );
    const res = await this.db
      .prepare(`SELECT * FROM ${childTable} AS t0 WHERE ${sql}`)
      .bind(...binds)
      .all<Record<string, unknown>>();
    const rows = (res.results ?? []).map((r) => applyJsonParse(childTable, r));
    await this.resolveEmbeds(childTable, rows, tree);
    return rows;
  }

  // products.raw_materials = raw_materials joined through recipe_items.
  private async productsRawMaterials(rows: Record<string, unknown>[], emb: { inner: SelectTree }): Promise<void> {
    const ids = uniqueNonNull(rows.map((r) => r['id']));
    if (!ids.length) {
      for (const r of rows) r['raw_materials'] = [];
      return;
    }
    const ris = await this.fetchChildren('recipe_items', { cols: ['*'], embeds: [] }, 'product_id', ids);
    const rmIds = uniqueNonNull(ris.map((r) => r['raw_material_id']));
    const res = rmIds.length
      ? await this.db
          .prepare(
            `SELECT * FROM raw_materials AS t0 WHERE t0.id IN (${rmIds.map(() => '?').join(',')})`
          )
          .bind(...rmIds)
          .all<Record<string, unknown>>()
      : { results: [] as Record<string, unknown>[] };
    const rmRows = (res.results ?? []).map((r) => applyJsonParse('raw_materials', r));
    const byProduct = new Map<string, Record<string, unknown>[]>();
    const rmById = new Map(rmRows.map((r) => [r['id'] as string, r]));
    for (const ri of ris) {
      const rm = rmById.get(ri['raw_material_id'] as string);
      if (!rm) continue;
      const pid = ri['product_id'] as string;
      if (!byProduct.has(pid)) byProduct.set(pid, []);
      byProduct.get(pid)!.push(rm);
    }
    for (const r of rows) r['raw_materials'] = byProduct.get(r['id'] as string) ?? [];
  }

  // Write helpers (column sets validated by the caller before reaching here).
  async insert(table: string, obj: Record<string, unknown>): Promise<{ id: string; changes: number }> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      cols.push(k);
      vals.push(v);
    }
    const id = (obj['id'] as string) ?? uuid();
    if (!cols.includes('id')) {
      cols.push('id');
      vals.push(id);
    }
    const q = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    const res = await this.db.prepare(q).bind(...vals).run();
    return { id, changes: res.meta.changes ?? 0 };
  }

  async update(table: string, id: string, obj: Record<string, unknown>): Promise<{ changes: number }> {
    const parts: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'id' || v === undefined) continue;
      parts.push(`${k} = ?`);
      vals.push(v);
    }
    if (!parts.length) return { changes: 0 };
    vals.push(id);
    const res = await this.db
      .prepare(`UPDATE ${table} SET ${parts.join(', ')} WHERE id = ?`)
      .bind(...vals)
      .run();
    return { changes: res.meta.changes ?? 0 };
  }

  async del(table: string, id: string): Promise<{ changes: number }> {
    const res = await this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    return { changes: res.meta.changes ?? 0 };
  }
}

function uniqueNonNull(vals: unknown[]): string[] {
  return [...new Set(vals.filter((v) => v !== null && v !== undefined) as string[])];
}

function groupBy<T>(items: T[], key: keyof T): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = it[key] as unknown as string;
    if (k === undefined || k === null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return m;
}