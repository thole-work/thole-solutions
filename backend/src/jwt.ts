const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 === 0 ? '' : '='.repeat(4 - (b.length % 4));
  const raw = atob(b + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Password hashing — PBKDF2-SHA256 (Web Crypto, no deps)
// Stored format: pbkdf2$<iterations>$<saltB64>$<hashB64>
// ---------------------------------------------------------------------------
export async function hashPassword(password: string, iterations = 120_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(bits)}`;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const raw = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(raw);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [iterStr, saltB64, hashB64] = parts.slice(1) as [string, string, string];
  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const bits = await deriveBits(password, b64urlDecode(saltB64), iterations);
  return b64url(bits) === hashB64;
}

// ---------------------------------------------------------------------------
// HS256 JWT
// ---------------------------------------------------------------------------
export interface JwtClaims {
  sub: string;
  email: string;
  iat: number;
  exp: number;
  [k: string]: unknown;
}

async function hmacSign(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = { ...payload, iat: now, exp: now + 60 * 60 * 24 * 7 };
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(body)));
  const sig = await hmacSign(`${h}.${p}`, secret);
  return `${h}.${p}.${b64url(sig)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  const expected = b64url(await hmacSign(`${h}.${p}`, secret));
  if (expected !== sig) return null;
  try {
    const body = JSON.parse(dec.decode(b64urlDecode(p))) as JwtClaims;
    if (typeof body.exp !== 'number' || body.exp * 1000 < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}