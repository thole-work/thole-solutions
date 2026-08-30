# Thole D1 Backend

A self-hosted, zero-Vendor backend for **Thole Solutions** built on
Cloudflare Workers + D1 (SQLite) + TypeScript. It is a drop-in replacement for
the Supabase stack (PostgREST + GoTrue-style auth + Realtime) that the frontend
currently talks to via `@supabase/supabase-js@2`.

The frontend does **not** change. A small shim
([`supabase-min/supabase.js`](supabase-min/supabase.js)) exposes the same
`supabase` global the app already uses, pointed at this worker.

## Why / scope

- Full Supabase replacement: every table in `../database/database map.txt`,
  RLS-equivalent ownership scoping, realtime parity, and the app's RPCs
  (`create_business`, `redeem_invite_code`, `place_order`, `record_payments`,
  `dashboard_summary`).
- Zero runtime dependencies — Web Crypto (PBKDF2 + HS256 JWT), no auth crate,
  no ORM.
- Embedded (`select=a,b(child(c,d))`) relations are resolved in JS with batched
  `IN` queries so nested selects like the app's `MEMBERSHIP_SELECT` keep working.

## Layout

```
migrations/0001_schema.sql   full D1 schema + triggers + business-type/module seed
src/index.ts                 worker entry, routing, CORS, realtime fan-out
src/auth.ts                  signup/login/token/user + onboarding RPCs
src/crud.ts                  generic REST per table (ownership-scoped)
src/db.ts                    D1 + embedded-select resolver + write helpers
src/rpc.ts                   place_order / record_payments / dashboard_summary
src/realtime.ts              durable-object WebSocket hub (one global instance)
src/jwt.ts                   PBKDF2 password hashing + HS256 JWT
src/types.ts                 Env + column registry (identifier validation)
src/util.ts                  uuid, json, parsing helpers
supabase-min/supabase.js     browser shim replacing @supabase/supabase-js@2
```

## Local development

```bash
cd backend
npm install

# 1. Set a real JWT secret (this file is git-ignored)
echo 'JWT_SECRET=replace-with-a-long-random-string' > .dev.vars

# 2. Create the local D1 database and apply migrations
npx wrangler d1 migrate create thole-d1 --local   # first time only
npx wrangler d1 migrations apply thole-d1 --local

# 3. Run the worker
npm run dev                       # http://127.0.0.1:8787
```

The schema is designed to run on an **empty** database (it is one big
migration). Wipe with `npx wrangler d1 execute thole-d1 --local --command='DROP DATABASE thole-d1'`-style reset only if you need a do-over.

## Endpoints (all CORS-enabled)

| Path                              | Purpose                                |
| --------------------------------- | -------------------------------------- |
| `POST /auth/v1/signup`           | create account → session token         |
| `POST /auth/v1/token`            | email+password → session token         |
| `GET  /auth/v1/user`            | current user                           |
| `GET|POST|PATCH|DELETE /rest/v1/<table>[?select=...]` | CRUD            |
| `POST /rest/v1/rpc/<name>`       | RPCs                                  |
| `/realtime/v1/websocket?token=…` | realtime (postgres_changes events)     |
| `GET /health`                    | liveness                              |

Query parameters mirror supabase-js: `select`, `eq.<col>`, `neq.`, `gt.`,
`gte.`, `lt.`, `lte.`, `in.<col>=a,b,c`, `order=<col>`, `asc=true|false`,
`limit`, `offset`, `range=a-b`.

### Security model (RLS equivalent)

- Every request is scoped to the caller's **active** `business_members`/`app_users`
  membership; `business_id` on writes is always forced server-side.
- Child tables (`order_items`, `purchase_order_items`, `recipe_items`) are
  scoped through a subquery on their parent row's business.
- Column/table names in queries and filters are validated against a static
  registry — no dynamic SQL identifiers from clients.
- `users`, `businesses`, and counters are not client-writable; they flow through
  auth + RPCs + triggers.

## Pointing the frontend at this backend

1. Copy `supabase-min/supabase.js` next to the app's `index.html`.
2. In `index.html` replace the CDN script (line 12) with `<script src="supabase-min/supabase.js"></script>`.
3. In `config.js` set `SUPABASE_URL` to `http://127.0.0.1:8787` (local) or your
   deployed worker URL. The anon key is unused by the shim — keep the field for
   compatibility.
4. `localStorage` key used for the session: `thole:d1:session` (clear on first
   switch).

## Deploying

```bash
npx wrangler d1 create thole-d1                  # note the database_id
# put the id into wrangler.jsonc (database_id)
npx wrangler d1 migrations apply thole-d1 --remote
npx wrangler secret put JWT_SECRET
npm run deploy                                   # -> workers.dev URL
```

Then set `config.js` `SUPABASE_URL` to the deployed URL.

## Verified behaviour (smoke tests included)

- `npx tsc --noEmit` clean.
- Triggers verified on real SQLite (via Node's `node:sqlite`): `total_sold`
  add/subtract on item insert/delete, full subtract on void; `cost_price`
  recalculated from recipe ingredient costs.
- Receipt numbering runs in the API layer (SQLite can't modify `NEW` in
  triggers) as an atomic D1 batch on `orders` PATCH → `status='completed'`;
  sequential per business, never renumbering already-numbered orders.