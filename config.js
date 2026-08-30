// Thole Solutions — runtime configuration.
// SUPABASE_URL points at the Cloudflare Workers backend (D1) that replaces
// Supabase; the anon key is unused by the shim but kept for compatibility.
window.THOLE_CONFIG = {
  SUPABASE_URL: "https://thole-d1-backend.workforce4115.workers.dev",
  SUPABASE_ANON_KEY: "public-anon-key-unused-by-shim",
};