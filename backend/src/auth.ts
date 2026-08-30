import type { Env, Ctx, Membership } from './types';
import { verifyJwt, hashPassword, verifyPassword, signJwt } from './jwt';
import { uuid, nowIso, apiError, parseBody } from './util';

export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? (m[1] ?? null) : null;
}

export async function loadCtx(env: Env, req: Request): Promise<Ctx> {
  const token = bearerToken(req);
  if (!token) return { userId: '', email: '', membership: null };
  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims) return { userId: '', email: '', membership: null };
  const userId = claims.sub as string;
  const row = await env.DB.prepare(
    `SELECT user_id, business_id, role FROM business_members
     WHERE user_id = ? AND status = 'active' LIMIT 1`
  )
    .bind(userId)
    .first<{ user_id: string; business_id: string; role: string }>();
  let membership: Membership | null = null;
  if (row) {
    membership = { user_id: row.user_id, business_id: row.business_id, role: row.role };
  } else {
    const a = await env.DB.prepare(
      `SELECT user_id, business_id, role FROM app_users WHERE user_id = ? LIMIT 1`
    )
      .bind(userId)
      .first<{ user_id: string; business_id: string; role: string }>();
    if (a) membership = { user_id: a.user_id, business_id: a.business_id, role: a.role };
  }
  return { userId, email: (claims.email as string) ?? '', membership };
}

export function requireAuth(ctx: Ctx): void {
  if (!ctx.userId) throw new HttpError(401, 'Not authenticated');
}

export function isOwner(ctx: Ctx): boolean {
  return ctx.membership?.role === 'owner';
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
export async function handleAuth(env: Env, url: URL, req: Request): Promise<Response> {
  const path = url.pathname.replace(/^\/auth\/v1\//, '');

  if (path === 'signup' && req.method === 'POST') {
    const body = parseBody(await req.text());
    const email = String(body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    const fullName = String(body?.full_name ?? '').trim() || null;
    if (!email || password.length < 8) throw new HttpError(400, 'Email required and password must be at least 8 characters');
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
    if (existing) throw new HttpError(409, 'User already registered');
    const id = uuid();
    const hash = await hashPassword(password);
    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)'
    )
      .bind(id, email, hash, fullName)
      .run();
    return authResponse(env, { id, email, full_name: fullName, created_at: nowIso() });
  }

  if (path === 'token' && req.method === 'POST') {
    const body = parseBody(await req.text());
    const email = String(body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<{ id: string; email: string; password_hash: string; full_name: string | null }>();
    if (!row) throw new HttpError(401, 'Invalid login credentials');
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) throw new HttpError(401, 'Invalid login credentials');
    return authResponse(env, { id: row.id, email: row.email, full_name: row.full_name, created_at: nowIso() });
  }

  if (path === 'user' && req.method === 'GET') {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'Not authenticated');
    const claims = await verifyJwt(token, env.JWT_SECRET);
    if (!claims) throw new HttpError(401, 'Not authenticated');
    const row = await env.DB.prepare('SELECT id, email, full_name, created_at FROM users WHERE id = ?')
      .bind(claims.sub)
      .first<{ id: string; email: string; full_name: string | null; created_at: string }>();
    if (!row) throw new HttpError(404, 'User not found');
    return authResponse(env, row);
  }

  throw new HttpError(404, 'Not found');
}

async function authResponse(env: Env, user: Record<string, unknown>): Promise<Response> {
  const token = await signJwt({ sub: user['id'] as string, email: user['email'] as string }, env.JWT_SECRET);
  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: 'bearer',
      expires_in: 60 * 60 * 24 * 7,
      user,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

export { apiError };