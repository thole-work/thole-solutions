export function uuid(): string {
  // RFC 4122 v4 from Web Crypto (workers-types lacks randomUUID on Crypto).
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function apiError(message: string, status = 400): Response {
  return jsonResponse({ message, code: status }, status);
}

export function parseBody(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    return null;
  } catch {
    return null;
  }
}

export function genInviteCode(): string {
  return uuid().replace(/-/g, '').slice(0, 14);
}

// Supabase-style query params: any key may be repeated, encode multiple
// values as comma-separated strings.
export function paramMap(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) out[k] = v;
  return out;
}

export function splitComma(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}