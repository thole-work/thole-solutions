/* =============================================================================
 * Thole D1 Backend — supabase-js compatible client shim.
 *
 * Drop-in replacement for @supabase/supabase-js@2 that talks to the local
 * Cloudflare Worker (REST + auth.go-compatible endpoints + realtime WS).
 * Usage: replace the CDN <script> for supabase-js with this file.
 *
 * Supported surface (whatever app.js actually uses):
 *   createClient(url, anonKey)
 *     .auth.signUp / signInWithPassword / signOut / getSession / getUser
 *     .auth.onAuthStateChange(cb)
 *     .from(t).select(...)[.eq|neq|in|gt|gte|lt|lte][.order][.range|.limit]
 *              [.single|.maybeSingle]
 *     .from(t).insert(obj|arr)[.select(...)[.single|.maybeSingle]]
 *     .from(t).update(obj).eq(...)      .from(t).delete().eq(...)
 *     .rpc(name, args)
 *     .channel(name).on('postgres_changes', {event, schema, table}, cb)
 *                   .subscribe()
 *     .removeChannel(channel)
 * ========================================================================== */
(function (global) {
  'use strict';

  const LS_SESSION_KEY = 'thole:d1:session';

  function createClient(url, _anonKey) {
    if (!url) throw new Error('SUPABASE_URL is required');

    let session = null;
    let authCallbacks = [];
    const token = () => (session && session.access_token) || '';

    function loadSession() {
      try {
        const raw = localStorage.getItem(LS_SESSION_KEY);
        if (raw) session = JSON.parse(raw);
      } catch (e) { session = null; }
      return session;
    }
    function saveSession(s) {
      session = s || null;
      try {
        if (s) localStorage.setItem(LS_SESSION_KEY, JSON.stringify(s));
        else localStorage.removeItem(LS_SESSION_KEY);
      } catch (e) { /* storage unavailable */ }
    }
    function emitAuth(event) {
      authCallbacks.forEach((cb) => { try { cb(event); } catch (e) { console.warn('auth callback error', e); } });
    }
    function storeAuthResponse(r) {
      const s = {
        access_token: r.access_token,
        expires_in: r.expires_in || (7 * 24 * 60 * 60),
        user: r.user,
      };
      saveSession(s);
      return s;
    }

    async function req(method, path, bodyObj, isAuth) {
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (!isAuth && token()) headers.authorization = 'Bearer ' + token();
      let res;
      try {
        res = await fetch(url + path, { method, headers, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
      } catch (e) {
        return { ok: false, error: { message: 'Network error: ' + (e && e.message ? e.message : e) } };
      }
      let parsed = null;
      try { parsed = await res.json(); } catch (e) { parsed = null; }
      if (!res.ok) return { ok: false, error: { message: (parsed && parsed.message) || ('HTTP ' + res.status), code: res.status, status: res.status } };
      return { ok: true, data: parsed };
    }

    function toSupabaseSession(inner) {
      return {
        access_token: inner.access_token,
        expires_in: inner.expires_in,
        token_type: 'bearer',
        user: inner.user,
      };
    }

    // ------------------------------------------------------------------ Auth
    const auth = {
      async signUp(credentials) {
        const fullName = credentials.options && credentials.options.data && credentials.options.data.full_name;
        const r = await req('POST', '/auth/v1/signup', {
          email: credentials.email,
          password: credentials.password,
          full_name: fullName || undefined,
        }, true);
        if (!r.ok) return { data: null, error: r.error };
        const s = storeAuthResponse(r.data);
        emitAuth('SIGNED_IN');
        return { data: { session: toSupabaseSession(s), user: s.user }, error: null };
      },
      async signInWithPassword(credentials) {
        const r = await req('POST', '/auth/v1/token', { email: credentials.email, password: credentials.password }, true);
        if (!r.ok) return { data: null, error: r.error };
        const s = storeAuthResponse(r.data);
        emitAuth('SIGNED_IN');
        return { data: { session: toSupabaseSession(s), user: s.user }, error: null };
      },
      async signOut() {
        saveSession(null);
        emitAuth('SIGNED_OUT');
        return { error: null };
      },
      async getSession() {
        loadSession();
        return { data: { session: session ? toSupabaseSession(session) : null }, error: null };
      },
      async getUser() {
        loadSession();
        if (!session) return { data: { user: null }, error: { message: 'No session' } };
        const r = await req('GET', '/auth/v1/user');
        if (!r.ok) return { data: { user: session.user }, error: null };
        session.user = r.data;
        saveSession(session);
        return { data: { user: r.data }, error: null };
      },
      onAuthStateChange(cb) {
        authCallbacks.push(cb);
        loadSession();
        cb('INITIAL_SESSION');
        return { data: { subscription: { unsubscribe() { authCallbacks = authCallbacks.filter((x) => x !== cb); } } } };
      },
    };

    // ------------------------------------------------------------ QueryBuilder
    const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];

    class QueryBuilder {
      constructor(table, verb) {
        this.table = table;
        this.verb = verb || 'select';
        this.params = new URLSearchParams();
        this.filters = {};
        this.body = null;
        this.selectMode = null; // null -> backend default (*)
        this.rowsMode = null;   // 'single' | 'maybeSingle' | null
        this.method = 'GET';
      }

      _clone() {
        const q = new QueryBuilder(this.table, this.verb);
        q.params = new URLSearchParams(this.params.toString());
        q.filters = Object.assign({}, this.filters);
        q.body = this.body;
        q.selectMode = this.selectMode;
        q.rowsMode = this.rowsMode;
        q.method = this.method;
        return q;
      }

      select(sel) { const q = this._clone(); q.selectMode = sel === undefined ? '*' : sel; return q; }
      order(col, opts) { const q = this._clone(); q.params.set('order', col); q.params.set('asc', !opts || opts.ascending === undefined ? 'true' : String(opts.ascending)); return q; }
      range(a, b) { const q = this._clone(); q.params.set('limit', String(b - a + 1)); q.params.set('offset', String(a)); return q; }
      limit(n) { const q = this._clone(); q.params.set('limit', String(n)); return q; }
      single() { const q = this._clone(); q.rowsMode = 'single'; return q; }
      maybeSingle() { const q = this._clone(); q.rowsMode = 'maybeSingle'; return q; }

      eq(col, val) { const q = this._clone(); q.filters['eq.' + col] = String(val); return q; }
      neq(col, val) { const q = this._clone(); q.filters['neq.' + col] = String(val); return q; }
      gt(col, val) { const q = this._clone(); q.filters['gt.' + col] = String(val); return q; }
      gte(col, val) { const q = this._clone(); q.filters['gte.' + col] = String(val); return q; }
      lt(col, val) { const q = this._clone(); q.filters['lt.' + col] = String(val); return q; }
      lte(col, val) { const q = this._clone(); q.filters['lte.' + col] = String(val); return q; }
      in(col, vals) { const q = this._clone(); q.filters['in.' + col] = (Array.isArray(vals) ? vals : [vals]).join(','); return q; }

      insert(payload) { const q = this._clone(); q.verb = 'insert'; q.method = 'POST'; q.body = safeClone(payload); return q; }
      update(payload) { const q = this._clone(); q.verb = 'update'; q.method = 'PATCH'; q.body = safeClone(payload); return q; }
      delete() { const q = this._clone(); q.verb = 'delete'; q.method = 'DELETE'; return q; }

      then(resolve, reject) { return this._execute().then(resolve, reject); }
      catch(reject) { return this._execute().then(() => {}, reject); }

      _buildUrl() {
        let p = '/rest/v1/' + this.table;
        const parts = [];
        if (this.selectMode !== null) parts.push('select=' + encodeURIComponent(this.selectMode));
        for (const [k, v] of Object.entries(this.filters)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        for (const [k, v] of this.params.entries()) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        if (parts.length) p += '?' + parts.join('&');
        return p;
      }

      async _execute() {
        let r;
        try {
          r = await fetch(url + this._buildUrl(), {
            method: this.method,
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...(token() ? { authorization: 'Bearer ' + token() } : {}),
            },
            body: this.body ? JSON.stringify(this.body) : undefined,
          });
        } catch (e) {
          return { data: null, error: { message: 'Network error: ' + (e && e.message ? e.message : e) } };
        }
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (!r.ok) return { data: null, error: { message: (data && data.message) || ('HTTP ' + r.status), code: r.status } };

        if (this.method === 'DELETE') return { data: (data && data.count) || 0, error: null };

        // Backend returns a plain object when the POST response is a single row.
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
          if (this.rowsMode === 'single') return { data, error: null };
          return { data, error: null };
        }
        if (!Array.isArray(data)) data = [];

        if (this.rowsMode === 'single') {
          if (data.length === 1) return { data: data[0], error: null };
          return { data: null, error: { message: data.length ? 'Multiple rows returned' : 'No rows found', code: 'PGRST116' } };
        }
        if (this.rowsMode === 'maybeSingle') {
          return { data: data.length ? data[0] : null, error: null };
        }
        return { data, error: null };
      }
    }

    function safeClone(v) {
      if (typeof structuredClone === 'function') { try { return structuredClone(v); } catch (e) { /* fall through */ } }
      return JSON.parse(JSON.stringify(v));
    }

    function from(table) { return new QueryBuilder(table); }

    async function rpc(name, args) {
      return req('POST', '/rest/v1/rpc/' + name, args || {});
    }

    // ------------------------------------------------------------- realtime
    let channels = [];
    function channel(name) {
      let socket = null;
      let subscriptions = [];
      const openSocket = () => {
        if (!token()) return;
        const wsUrl = url.replace(/^http/, 'ws') + '/realtime/v1/websocket?token=' + encodeURIComponent(token());
        let ws;
        try { ws = new WebSocket(wsUrl); } catch (e) { return; }
        socket = ws;
        ws.onopen = () => subscriptions.forEach((s) => ws.send(JSON.stringify({ event: 'subscribe', table: s.table })));
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (!msg || msg.type !== 'postgres_changes') return;
          subscriptions.filter((s) => s.table === msg.table).forEach((s) => {
            try {
              s.cb({ eventType: msg.eventType, schema: 'public', table: msg.table, new: {}, old: {} });
            } catch (e) { console.warn('realtime callback error', e); }
          });
        };
        ws.onclose = () => { socket = null; };
      };
      const ch = {
        name,
        on(event, config, cb) {
          if (event === 'postgres_changes' && config && config.table) subscriptions.push({ table: config.table, cb });
          return ch;
        },
        subscribe(cb) {
          channels.push(ch);
          openSocket();
          if (cb) cb('SUBSCRIBED');
          return ch;
        },
        unsubscribe() { if (socket) { try { socket.close(); } catch (e) {} } socket = null; },
      };
      return ch;
    }

    function removeChannel(ch) {
      if (ch && ch.unsubscribe) ch.unsubscribe();
      channels = channels.filter((c) => c !== ch);
    }

    loadSession();
    return { auth, from, rpc, channel, removeChannel, __getSession: () => session };
  }

  // Expose as window.supabase (matches the CDN global name the app uses)
  global.supabase = { createClient };
})(typeof window !== 'undefined' ? window : this);