  // ============================================================
  // CONFIG
  // ============================================================
  const CONFIG = window.THOLE_CONFIG || {};
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#A6432C;">Configuration missing: config.js failed to load.</div>';
    throw new Error("THOLE_CONFIG missing — check config.js");
  }

  const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  // Feature flags — flip to false to fall back to legacy flows.
  const FEATURES = {
    businessMembers: true, // read/write membership via business_members (falls back to app_users)
    typeModules: true, // derive raw-materials/production gating from business_type_modules (falls back to type_key strings)
    eventLogging: true, // fire-and-forget writes to audit_log / usage_events (Step 4)
    atomicRpc: true, // place_order/record_payments SQL RPCs; falls back to legacy await-chains on error (Step 5)
    serverAggregation: true, // dashboard_summary RPC instead of full-history fetches; falls back on error (Step 6)
  };

  let currentUser = null;
  let membership = null; // { business_id, role, full_name, businesses: {...} }
  let businessModules = null; // Set of module_key from business_type_modules — null = unknown/unavailable (legacy fallback)
  // BRANCH AWARENESS (Step 7) — selectedBranchId null = "All branches"
  let branches = [];
  let selectedBranchId = null;
  const BRANCH_SCOPED_TABLES = new Set(["orders", "payments", "expenses", "customers", "suppliers", "stock_movements", "labor_shifts", "restaurant_tables"]);
  function branchStorageKey() { return `thole:branch:${membership?.business_id || "unknown"}`; }
  // Read-path: narrow a query to the selected branch (tables whose rows carry branch_id)
  function applyBranchFilter(query, table) {
    if (selectedBranchId && table && BRANCH_SCOPED_TABLES.has(table)) return query.eq("branch_id", selectedBranchId);
    return query;
  }
  // Write-path: stamp the selected branch onto an insert payload (no-op when "All branches")
  function stampBranch(payload) {
    if (selectedBranchId && payload && typeof payload === "object" && !Array.isArray(payload)) payload.branch_id = selectedBranchId;
    return payload;
  }
  let cache = { products: [], customers: [], sales: [], payments: [], expenses: [], purchases: [], materials: [], suppliers: [], movements: [] };
  let editingRecord = null; // { table: 'products', id: '...' } — null means "adding new"
  let businessTypeKey = null;
  let pagination = { products: 0, customers: 0, sales: 0, payments: 0, expenses: 0, purchases: 0, materials: 0, suppliers: 0, movements: 0 };
  const PAGE_SIZE = 25;
  let reqVersion = { products: 0, customers: 0, sales: 0, payments: 0, expenses: 0, purchases: 0, materials: 0, suppliers: 0, movements: 0 };
  let loading = { products: false, customers: false, sales: false, payments: false, expenses: false, purchases: false, materials: false, suppliers: false, movements: false };

  const UNITS = [
    { value: 'pcs', label: 'Piece (pcs)', category: 'quantity' },
    { value: 'kg', label: 'Kilogram (kg)', category: 'weight' },
    { value: 'g', label: 'Gram (g)', category: 'weight' },
    { value: 'litre', label: 'Litre (litre)', category: 'volume' },
    { value: 'ml', label: 'Millilitre (ml)', category: 'volume' },
    { value: 'plate', label: 'Plate', category: 'serving' },
    { value: 'cup', label: 'Cup', category: 'serving' },
    { value: 'bowl', label: 'Bowl', category: 'serving' },
    { value: 'pack', label: 'Pack', category: 'packaging' },
    { value: 'bottle', label: 'Bottle', category: 'packaging' },
    { value: 'box', label: 'Box', category: 'packaging' },
    { value: 'sack', label: 'Sack', category: 'packaging' },
    { value: 'dozen', label: 'Dozen', category: 'quantity' },
    { value: 'pair', label: 'Pair', category: 'quantity' },
  ];
  function unitOptionsHtml(selected) {
    return UNITS.map(u => `<option value="${u.value}"${u.value === selected ? ' selected' : ''}>${u.label}</option>`).join('');
  }

  // ============================================================
  // i18n — INTERNATIONALIZATION
  // ============================================================
  const I18N_LANGS = ['en', 'am', 'om'];
  const I18N_NAMES = { en: 'English', am: 'አማርኛ', om: 'Afaan Oromoo' };
  let currentLang = localStorage.getItem('thole:lang') || 'en';
  let translations = {};

  async function loadTranslations(lang) {
    if (lang === 'en') {
      try {
        const r = await fetch('translations/en.json');
        if (r.ok) translations = await r.json();
      } catch(e) { console.warn('Failed to load translations', e); }
      return;
    }
    try {
      const [baseR, langR] = await Promise.all([
        fetch('translations/en.json'),
        fetch(`translations/${lang}.json`)
      ]);
      const base = baseR.ok ? await baseR.json() : {};
      const over = langR.ok ? await langR.json() : {};
      translations = deepMerge(base, over);
    } catch(e) { console.warn('Failed to load translations', e); }
  }

  function deepMerge(target, source) {
    const out = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
        out[key] = deepMerge(target[key], source[key]);
      } else {
        out[key] = source[key];
      }
    }
    return out;
  }

  function t(key, params) {
    const keys = key.split('.');
    let val = translations;
    for (const k of keys) {
      if (val && typeof val === 'object') val = val[k];
      else return key;
    }
    if (val === undefined || val === null) return key;
    if (typeof val !== 'string') return key;
    if (params) {
      for (const [pk, pv] of Object.entries(params)) {
        val = val.replace(new RegExp(`\\{${pk}\\}`, 'g'), pv);
      }
    }
    return val;
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translated = t(key);
      if (translated !== key) el.textContent = translated;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translated = t(key);
      if (translated !== key) el.placeholder = translated;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const translated = t(key);
      if (translated !== key) el.title = translated;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria');
      const translated = t(key);
      if (translated !== key) el.setAttribute('aria-label', translated);
    });
  }

  async function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('thole:lang', lang);
    document.documentElement.lang = lang;
    await loadTranslations(lang);
    applyTranslations();
    const activeTab = document.querySelector('.nav-item.active')?.dataset.tab || 'dashboard';
    updateTopbar(activeTab);
    const langSel = document.getElementById('lang-select');
    if (langSel) langSel.value = lang;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translated = t(key);
      if (translated !== key) el.textContent = translated;
    });
  }

  // HELPER: Translates Day/Week/Month/Year inputs into Supabase time ranges
  function applyTimeFilter(query, val, mode, col = "created_at") {
    if (mode === "all" || !val) return query;
    try {
      if (mode === "date") {
        if (col === "expense_date") return query.eq(col, val); 
        return query.gte(col, `${val}T00:00:00`).lte(col, `${val}T23:59:59`);
      } else if (mode === "month") {
        const [y, m] = val.split('-');
        const last = new Date(y, m, 0).getDate();
        return query.gte(col, `${y}-${m}-01T00:00:00`).lte(col, `${y}-${m}-${last}T23:59:59`);
      } else if (mode === "number") { // Year
        return query.gte(col, `${val}-01-01T00:00:00`).lte(col, `${val}-12-31T23:59:59`);
      } else if (mode === "week") {
        const [y, w] = val.split('-W');
        const simple = new Date(y, 0, 1 + (w - 1) * 7);
        const dow = simple.getDay();
        const start = new Date(simple);
        start.setDate(simple.getDate() - dow + (dow === 0 ? -6 : 1));
        const end = new Date(start);
        end.setDate(start.getDate() + 6);

        const pad = (n) => n.toString().padStart(2, '0');
        const d1 = `${start.getFullYear()}-${pad(start.getMonth()+1)}-${pad(start.getDate())}`;
        const d2 = `${end.getFullYear()}-${pad(end.getMonth()+1)}-${pad(end.getDate())}`;
        return query.gte(col, `${d1}T00:00:00`).lte(col, `${d2}T23:59:59`);
      }
    } catch (e) {
      console.error("Time filter error", e);
    }
    return query;
  }

  // Custom date-range filter helper (open start/end; apply only what's set)
  function applyTimeRange(query, start, end, col = "created_at") {
    if (start) query = query.gte(col, `${start}T00:00:00`);
    if (end) query = query.lte(col, `${end}T23:59:59`);
    return query;
  }

  function show(id) { document.getElementById(id).classList.remove("hidden"); }
  function hide(id) { document.getElementById(id).classList.add("hidden"); }
  function setError(id, msg) { const el = document.getElementById(id); el.textContent = msg; show(id); }
  function clearError(id) { hide(id); }
  function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }
  function escapeAttr(str) { return String(str ?? "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function appendPaginated(el, html, key, append = false) {
    if (!append) { el.innerHTML = html; }
    else {
      const loadMoreBtn = el.querySelector(".load-more-btn");
      if (loadMoreBtn) loadMoreBtn.remove();
      el.insertAdjacentHTML("beforeend", html);
    }
    if (pagination[key] > 0) {
      el.insertAdjacentHTML("beforeend", `<div style="text-align:center; padding:12px;"><button class="btn-ghost load-more-btn" onclick="loadMore('${key}')">Load more</button></div>`);
    }
  }
  async function loadMore(key) {
    await { products: loadProducts, customers: loadCustomers, sales: loadSales, payments: loadPayments, expenses: loadExpenses, purchases: loadPurchases, materials: loadMaterials, suppliers: loadSuppliers, movements: loadMovements }[key](true);
  }
  function money(n) { const sym = getSettings().currency_symbol || 'ETB'; return sym + ' ' + Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function abbreviateNumber(value) {
    const n = Number(value ?? 0);
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
    return n.toString();
  }
  function abbreviateCurrency(value) { return "ETB " + abbreviateNumber(value); }

  // --- 4. Toast notifications ---
  function showToast(msg, type = "success") {
    const c = document.getElementById("toast-container");
    const t = document.createElement("div");
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.classList.add("toast-out"); }, 2800);
    setTimeout(() => { t.remove(); }, 3100);
  }

  // --- 3. Button loading helpers ---
  function setBtnLoading(btn, loading) {
    if (!btn) return;
    if (loading) { btn.classList.add("loading"); btn.disabled = true; }
    else { btn.classList.remove("loading"); btn.disabled = false; }
  }

  // --- 8. Number counter animation ---
  function animateValue(el, end, duration = 500) {
    el.classList.remove("skeleton");
    const start = 0;
    const startTime = performance.now();
    const step = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = money(start + (end - start) * eased);
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function openModal(id) { show(id); document.getElementById("app-topbar").classList.add("topbar-dimmed"); const firstInput = document.querySelector(`#${id} .modal input:not([type=hidden]), #${id} .modal select`); if (firstInput) setTimeout(() => firstInput.focus(), 100); }
  function closeModal(id) {
    hide(id);
    document.getElementById("app-topbar").classList.remove("topbar-dimmed");
    document.querySelectorAll(`#${id} input`).forEach((i) => (i.value = ""));
    const errId = id.replace("-modal", "-error");
    if (document.getElementById(errId)) clearError(errId);
    editingRecord = null;
  }

  // ============================================================
  // POS STATE & HELPERS
  // ============================================================
  let posState = {
    cart: [],           // { product_id, name, price, qty, modifiers, discount, line_total }
    tableId: null,
    tableNumber: null,
    orderId: null,
    orderType: 'dine_in', // dine_in, takeout, delivery
    customerId: null,
    customerName: null,
    appliedDiscount: 0,
    discountType: 'amount', // amount, percent
    posSessionId: null,
  };

  function posReset() {
    posState = { cart: [], tableId: null, tableNumber: null, orderId: null, orderType: 'dine_in', customerId: null, customerName: null, appliedDiscount: 0, discountType: 'amount', posSessionId: null };
  }

  // ============================================================
  // STOCK HELPERS
  // ============================================================
  async function adjustStock(table, id, qtyChange, businessId) {
    return adjustStockColumn(table, id, 'stock_qty', qtyChange, businessId);
  }

  async function adjustStockColumn(table, id, column, qtyChange, businessId) {
    // Step 5: compare-and-set with retries — a concurrent writer between our read and
    // update makes the conditional update match 0 rows; re-read and try again.
    const CAS_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
      const { data: fresh, error: freshErr } = await sb.from(table).select(column).eq("id", id).eq("business_id", businessId).single();
      if (freshErr || !fresh || fresh[column] === null) return { error: freshErr || new Error("No stock data") };
      const current = Number(fresh[column]);
      const newQty = current + qtyChange;
      const { data, error } = await sb.from(table)
        .update({ [column]: newQty })
        .eq("id", id).eq(column, current).eq("business_id", businessId)
        .select();
      if (error) return { error };
      if (data && data.length > 0) return { oldQty: current, newQty, attempts: attempt };
      // 0 rows updated → another writer changed the value mid-flight; retry
    }
    return { error: new Error(`Stock update conflicted after ${CAS_ATTEMPTS} attempts`) };
  }

  async function logStockMovement({ itemType, productId, materialId, qtyChange, reason, refType, refId, location }) {
    const payload = {
      business_id: membership.business_id,
      item_type: itemType,
      quantity_change: qtyChange,
      reason: reason || '',
      reference_type: refType || null,
      reference_id: refId || null,
      created_by: currentUser.id,
      location: location || 'store',
    };
    if (itemType === "product") payload.product_id = productId;
    else if (itemType === "raw_material") payload.raw_material_id = materialId;
    stampBranch(payload);
    const { error } = await sb.from("stock_movements").insert(payload);
    if (error) console.error("stock movement log failed:", error.message);
    else logUsage("stock_movement", null, "stock_movement", null, { reason: payload.reason, quantity_change: qtyChange });
    return !error;
  }

  // Fire-and-forget audit/usage logging — never awaited, never blocks or fails the user action.
  // metadata is NOT NULL in both tables, so always send an object.
  function logAudit(action, entityType, entityId, beforeData = null, afterData = null, metadata = {}) {
    if (!FEATURES.eventLogging || !membership?.business_id || !currentUser?.id) return;
    sb.from("audit_log").insert({
      business_id: membership.business_id,
      user_id: currentUser.id,
      action,
      entity_type: entityType,
      entity_id: entityId || null,
      before_data: beforeData,
      after_data: afterData,
      metadata,
    }).then(({ error }) => { if (error) console.warn("audit_log write failed:", error.message); })
      .catch((e) => console.warn("audit_log write failed:", e?.message || e));
  }

  function logUsage(eventType, pageKey = null, entityType = null, entityId = null, metadata = {}) {
    if (!FEATURES.eventLogging || !membership?.business_id || !currentUser?.id) return;
    sb.from("usage_events").insert({
      business_id: membership.business_id,
      user_id: currentUser.id,
      event_type: eventType,
      page_key: pageKey,
      entity_type: entityType,
      entity_id: entityId || null,
      metadata,
    }).then(({ error }) => { if (error) console.warn("usage_events write failed:", error.message); })
      .catch((e) => console.warn("usage_events write failed:", e?.message || e));
  }

  function getDerivedAvailability(productId) {
    const product = (cache.products || []).find(p => p.id === productId);
    if (!product) return 0;
    if (product.product_type !== 'recipe') return Number(product.stock_qty) || 0;
    return (product.stock_limit != null && product.stock_limit !== '') ? Number(product.stock_limit) : Infinity;
  }

  // ============================================================
  // GENERIC CRUD HELPERS
  // ============================================================
  async function pagedLoad(key, { table, select, orderBy, ascending = true, extraFilters, timeFilterKey, timeCol = 'created_at', append = false } = {}) {
    if (loading[key] && !append) return null;
    loading[key] = true;
    const ver = ++reqVersion[key];
    const offset = append ? pagination[key] : 0;
    let query = applyBranchFilter(sb.from(table).select(select || '*').eq('business_id', membership.business_id), table);
    if (extraFilters) extraFilters.forEach(f => { query = query.eq(f[0], f[1]); });
    if (orderBy) query = query.order(orderBy, { ascending });
    query = query.range(offset, offset + PAGE_SIZE - 1);
    if (timeFilterKey) {
      const start = document.getElementById(`${timeFilterKey}-start-date`)?.value;
      const end = document.getElementById(`${timeFilterKey}-end-date`)?.value;
      if (start || end) {
        query = applyTimeRange(query, start, end, timeCol);
      } else {
        const val = document.getElementById(`${timeFilterKey}-date-filter`)?.value;
        const mode = document.getElementById(`${timeFilterKey}-filter-mode`)?.value || 'date';
        query = applyTimeFilter(query, val, mode, timeCol);
      }
    }
    const { data, error } = await query;
    loading[key] = false;
    if (error) { console.error(`pagedLoad(${key}) failed:`, error.message); showToast(error.message, 'error'); return null; }
    if (ver !== reqVersion[key]) return null;
    if (append) { cache[key] = [...cache[key], ...(data ?? [])]; } else { cache[key] = data ?? []; }
    pagination[key] = data?.length === PAGE_SIZE ? offset + PAGE_SIZE : 0;
    return data;
  }

  function genericEdit({ cacheKey, table, titleId, btnId, deleteId, modalId, fields }) {
    return function(recordId) {
      const record = cache[cacheKey].find(x => x.id === recordId);
      if (!record) return;
      editingRecord = { table, id: record.id };
      document.getElementById(titleId).textContent = `Edit ${cacheKey.replace(/s$/, '')}`;
      document.getElementById(btnId).textContent = 'Save changes';
      document.getElementById(deleteId).classList.remove('hidden');
      fields.forEach(({ id, key }) => { document.getElementById(id).value = record[key] ?? ''; });
      openModal(modalId);
    };
  }

  async function genericSubmit({ table, errId, btnId, modalId, fields, validate, extraInsert, postSubmit }) {
    clearError(errId);
    const btn = document.getElementById(btnId);
    const payload = {};
    let firstEmpty = null;
    fields.forEach(({ id, key, transform }) => {
      const el = document.getElementById(id);
      const val = transform ? transform(el) : (el.value.trim() || null);
      payload[key] = val;
      if (val === null && !firstEmpty) firstEmpty = el;
    });
    if (validate) {
      const vErr = validate(payload);
      if (vErr) return setError(errId, vErr);
    }
    setBtnLoading(btn, true);
    const insertPayload = { business_id: membership.business_id, ...payload, ...(extraInsert ? extraInsert() : {}) };
    const { error } = editingRecord
      ? await sb.from(table).update(payload).eq('id', editingRecord.id)
      : await sb.from(table).insert(insertPayload);
    setBtnLoading(btn, false);
    if (error) return setError(errId, error.message);
    closeModal(modalId);
    showToast(editingRecord ? 'Updated' : 'Added');
    if (postSubmit) await postSubmit();
  }

  // ========== OFFLINE DRAFT QUEUE ==========
  const OFFLINE_QUEUE_KEY = 'thole_pos_offline_queue';
  
  function getOfflineQueue() {
    try {
      return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
    } catch { return []; }
  }
  
  function saveOfflineQueue(queue) {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  }
  
  async function posSyncOfflineQueue() {
    const queue = getOfflineQueue();
    if (queue.length === 0) return;
    for (const draft of queue) {
      try {
        // Recreate posState from draft
        posState.cart = draft.cart;
        posState.tableId = draft.tableId;
        posState.tableNumber = draft.tableNumber;
        posState.orderType = draft.orderType;
        posState.customerId = draft.customerId;
        posState.appliedDiscount = draft.appliedDiscount;
        posState.discountType = draft.discountType;
        
        const { subtotal, discount, tax, total } = posCalcTotals();
        const { data: order } = await sb.from('orders').insert(stampBranch({
          business_id: membership.business_id,
          table_id: posState.tableId || null,
          customer_id: posState.customerId || null,
          order_type: posState.tableId ? 'dine_in' : (posState.orderType || 'takeout'),
          status: 'pending',
          subtotal,
          discount,
          discount_type: posState.discountType || 'amount',
          tax_rate: posCalcTotals().taxRate,
          tax,
          total_amount: total,
          payment_method: 'cash',
          created_by: currentUser.id,
        })).select().single();
        
        const items = posState.cart.map(item => ({
          order_id: order.id,
          product_id: item.product_id,
          quantity: item.qty,
          unit_price: item.price,
        }));
        await sb.from('order_items').insert(items);

        // Payment record
        await sb.from('payments').insert({
          business_id: membership.business_id,
          order_id: order.id,
          customer_id: posState.customerId,
          amount: total,
          method: 'cash',
          direction: 'in',
          created_by: currentUser.id,
        });
        logAudit("create", "order", order.id, null, order, { source: 'offline_sync' });
        logUsage("order_placed", "pos", "order", order.id, { source: 'offline_sync' });
        
        // Update table
        if (posState.tableId) {
          await sb.from('restaurant_tables').update({ status: 'available', current_order_id: null }).eq('id', posState.tableId).eq('business_id', membership.business_id);
        }
        
        // Remove from queue
        const updatedQueue = getOfflineQueue().filter(d => d.id !== draft.id);
        saveOfflineQueue(updatedQueue);
        showToast(`Synced order ${order.id.slice(0,8)}`);
      } catch (e) {
        console.error('Offline sync failed:', e);
        break; // Stop on first failure
      }
    }
    await loadProducts();
    await loadSales();
    renderDashboard();
  }
  
  // Auto-sync when online
  window.addEventListener('online', posSyncOfflineQueue);
  
  // ========== KITCHEN COMMAND CENTER ==========
  let kitchenChannel = null;
  let kitchenOrders = new Map();
  let kitchenOrderItemCounts = new Map();
  let kitchenReloadTimer = null;
  let kitchenAudioCtx = null;
  let kitchenSoundEnabled = true;
  let kitchenTimerInterval = null;

  // --- Sound ---
  function playKDSSound(type) {
    if (!kitchenSoundEnabled) return;
    try {
      if (!kitchenAudioCtx) kitchenAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (kitchenAudioCtx.state === 'suspended') kitchenAudioCtx.resume();
      const now = kitchenAudioCtx.currentTime;
      if (type === 'new') {
        // Two-tone ascending: C5 → E5
        const o1 = kitchenAudioCtx.createOscillator(); const g1 = kitchenAudioCtx.createGain();
        o1.connect(g1); g1.connect(kitchenAudioCtx.destination);
        o1.type = 'sine'; o1.frequency.value = 523; g1.gain.value = 0.2;
        o1.start(now); g1.gain.exponentialRampToValueAtTime(0.001, now + 0.12); o1.stop(now + 0.12);
        const o2 = kitchenAudioCtx.createOscillator(); const g2 = kitchenAudioCtx.createGain();
        o2.connect(g2); g2.connect(kitchenAudioCtx.destination);
        o2.type = 'sine'; o2.frequency.value = 659; g2.gain.value = 0.25;
        o2.start(now + 0.12); g2.gain.exponentialRampToValueAtTime(0.001, now + 0.28); o2.stop(now + 0.28);
      } else if (type === 'ready') {
        // Three-tone ascending: C5 → E5 → G5
        const freqs = [523, 659, 784];
        freqs.forEach((f, i) => {
          const o = kitchenAudioCtx.createOscillator(); const g = kitchenAudioCtx.createGain();
          o.connect(g); g.connect(kitchenAudioCtx.destination);
          o.type = 'sine'; o.frequency.value = f; g.gain.value = 0.25;
          o.start(now + i * 0.11); g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.12); o.stop(now + i * 0.11 + 0.12);
        });
      } else {
        // Two-tone descending warning: E5 → C5
        const o1 = kitchenAudioCtx.createOscillator(); const g1 = kitchenAudioCtx.createGain();
        o1.connect(g1); g1.connect(kitchenAudioCtx.destination);
        o1.type = 'sine'; o1.frequency.value = 659; g1.gain.value = 0.18;
        o1.start(now); g1.gain.exponentialRampToValueAtTime(0.001, now + 0.18); o1.stop(now + 0.18);
        const o2 = kitchenAudioCtx.createOscillator(); const g2 = kitchenAudioCtx.createGain();
        o2.connect(g2); g2.connect(kitchenAudioCtx.destination);
        o2.type = 'sine'; o2.frequency.value = 523; g2.gain.value = 0.15;
        o2.start(now + 0.18); g2.gain.exponentialRampToValueAtTime(0.001, now + 0.35); o2.stop(now + 0.35);
      }
    } catch(e) {}
  }

  function toggleKitchenSound() {
    kitchenSoundEnabled = !kitchenSoundEnabled;
    try { localStorage.setItem('thole:kitchen-sound', kitchenSoundEnabled ? '1' : '0'); } catch(_) {}
    const icon = document.getElementById('kitchen-sound-icon');
    if (icon) icon.textContent = kitchenSoundEnabled ? '🔊' : '🔇';
  }

  // --- Data loading ---
  async function loadKitchenOrders() {
    const { data } = await applyBranchFilter(sb.from('orders')
      .select('id, status, created_at, business_id, payment_method, order_items(id, quantity, product_id, products(name)), restaurant_tables!table_id(table_number, name)')
      .eq('business_id', membership.business_id)
      .in('status', ['pending', 'preparing', 'ready'])
      .order('created_at', { ascending: true })
      .limit(100), 'orders');
    const prev = new Map(kitchenOrders);
    kitchenOrders.clear();
    (data || []).forEach(o => kitchenOrders.set(o.id, o));
    renderKitchenAll(prev);
  }

  function scheduleKitchenReload() {
    if (kitchenReloadTimer) clearTimeout(kitchenReloadTimer);
    kitchenReloadTimer = setTimeout(() => { kitchenReloadTimer = null; loadKitchenOrders(); }, 300);
  }

  // --- Realtime ---
  function setupKitchenRealtime() {
    if (kitchenChannel) sb.removeChannel(kitchenChannel);
    kitchenChannel = sb.channel('kitchen-realtime');
    kitchenChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
      handleKitchenChange(payload);
    });
    kitchenChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, (payload) => {
      handleKitchenChange(payload);
    });
    kitchenChannel.subscribe();
  }

  function teardownKitchenRealtime() {
    if (kitchenChannel) { sb.removeChannel(kitchenChannel); kitchenChannel = null; }
  }

  function handleKitchenChange(payload) {
    if (payload.eventType === 'DELETE') return;
    if (payload.table === 'order_items') { playKDSSound('new'); scheduleKitchenReload(); return; }
    const order = payload.new;
    if (!order || order.business_id !== membership.business_id) return;
    if (['pending', 'preparing', 'ready'].includes(order.status)) {
      if (order.status === 'ready') playKDSSound('ready');
      else if (order.status === 'pending') playKDSSound('new');
    }
    scheduleKitchenReload();
  }

  // --- Render all kitchen sections ---
  function renderKitchenAll(prevOrders) {
    renderKitchenTables();
    renderKitchenPipeline(prevOrders);
    renderKitchenStock();
  }

  // --- Table Map ---
  async function renderKitchenTables() {
    const el = document.getElementById('kitchen-table-map');
    if (!el) return;
    try {
      const { data } = await sb.from('restaurant_tables')
        .select('id, table_number, name, capacity, status, current_order_id, orders!current_order_id(status, created_at, order_items(id))')
        .eq('business_id', membership.business_id)
        .order('table_number');
      if (!data || data.length === 0) {
        el.innerHTML = `<div class="kitchen-empty">${t('kds.no_tables')}</div>`;
        updateCount('kitchen-table-count', '');
        return;
      }
      updateCount('kitchen-table-count', data.length);
      el.innerHTML = data.map(tb => {
        const orderStatus = tb.orders?.status;
        const isActive = orderStatus && ['pending','preparing','ready'].includes(orderStatus);
        const isServed = orderStatus === 'served';
        const itemCount = tb.orders?.order_items?.length || 0;
        let statusClass = 'table-available';
        let statusText = t('kds.free');
        let metaText = '';
        if (isServed) { statusClass = 'table-served'; statusText = t('kds.awaiting_payment'); }
        else if (isActive) {
          statusClass = 'table-occupied';
          statusText = t('kds.occupied');
          const elapsed = tb.orders?.created_at ? formatElapsed(tb.orders.created_at) : '';
          metaText = `${itemCount} item${itemCount !== 1 ? 's' : ''} · ${elapsed}`;
        }
        return `<div class="kitchen-table-card ${statusClass}">
          <span class="kitchen-table-num">${escapeHtml(tb.table_number)}</span>
          ${tb.name ? `<span class="kitchen-table-name">${escapeHtml(tb.name)}</span>` : ''}
          <span class="kitchen-table-status">${statusText}</span>
          ${metaText ? `<span class="kitchen-table-meta">${metaText}</span>` : ''}
        </div>`;
      }).join('');
    } catch(e) {
      el.innerHTML = `<div class="kitchen-empty">${t('kds.no_tables')}</div>`;
    }
  }

  // --- Order Pipeline ---
  function renderKitchenPipeline(prevOrders) {
    const pendingEl = document.getElementById('pipeline-pending');
    const cookingEl = document.getElementById('pipeline-cooking');
    const readyEl = document.getElementById('pipeline-ready');
    const emptyEl = document.getElementById('kitchen-empty-pipeline');
    if (!pendingEl || !cookingEl || !readyEl) return;

    const orders = Array.from(kitchenOrders.values()).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const prevMap = prevOrders || new Map();

    if (orders.length === 0) {
      pendingEl.innerHTML = '';
      cookingEl.innerHTML = '';
      readyEl.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
      updateCount('kitchen-order-count', '');
      updateCount('pipeline-pending-count', '0');
      updateCount('pipeline-cooking-count', '0');
      updateCount('pipeline-ready-count', '0');
      kitchenOrderItemCounts.clear();
      stopKitchenTimers();
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    updateCount('kitchen-order-count', orders.length);

    const pending = orders.filter(o => o.status === 'pending');
    const cooking = orders.filter(o => o.status === 'preparing');
    const ready = orders.filter(o => o.status === 'ready');

    updateCount('pipeline-pending-count', pending.length);
    updateCount('pipeline-cooking-count', cooking.length);
    updateCount('pipeline-ready-count', ready.length);

    // Oldest pending order gets highlighted
    const oldestId = pending.length > 0 ? pending[0].id : null;

    pendingEl.innerHTML = pending.map(o => buildPipelineCard(o, 'pending', oldestId, prevMap)).join('');
    cookingEl.innerHTML = cooking.map(o => buildPipelineCard(o, 'preparing', null, prevMap)).join('');
    readyEl.innerHTML = ready.map(o => buildPipelineCard(o, 'ready', null, prevMap)).join('');

    // Update tracked counts
    orders.forEach(o => kitchenOrderItemCounts.set(o.id, (o.order_items || []).length));
    startKitchenTimers();
  }

  function buildPipelineCard(o, status, oldestId, prevMap) {
    const tableInfo = o.restaurant_tables
      ? `T${o.restaurant_tables.table_number}${o.restaurant_tables.name ? ' ' + o.restaurant_tables.name : ''}`
      : t('kds.walk_in');
    const prevCount = kitchenOrderItemCounts.get(o.id) || 0;
    const currentCount = (o.order_items || []).length;
    const hasNewItems = prevCount > 0 && currentCount > prevCount;
    const isOldest = o.id === oldestId;
    const isPaid = o.payment_method && o.payment_method !== '';
    const elapsed = formatElapsed(o.created_at);
    const orderIdShort = o.id.slice(0, 6).toUpperCase();

    // Progress dots: pending=1, preparing=2, ready=3
    const progressStep = status === 'pending' ? 1 : status === 'preparing' ? 2 : 3;
    const dots = [1, 2, 3].map(s => `<span class="pipeline-progress-dot ${s <= progressStep ? 'filled' : ''}"></span>`).join('');

    let actionBtn = '';
    if (status === 'pending') actionBtn = `<button class="pipeline-card-action pipeline-btn-cook" onclick="kitchenAdvanceStatus('${o.id}', 'preparing')">${t('kds.cook')}</button>`;
    else if (status === 'preparing') actionBtn = `<button class="pipeline-card-action pipeline-btn-ready" onclick="kitchenAdvanceStatus('${o.id}', 'ready')">${t('kds.mark_ready')}</button>`;
    else if (status === 'ready') actionBtn = `<button class="pipeline-card-action pipeline-btn-serve" onclick="kitchenAdvanceStatus('${o.id}', 'served')">${t('kds.serve')}</button>`;

    const items = (o.order_items || []).map((item, idx) => {
      const isNew = idx >= prevCount && hasNewItems;
      return `<div class="pipeline-item ${isNew ? 'kds-item-new' : ''}">
        <span class="pipeline-item-qty">${item.quantity}x</span>
        <span class="pipeline-item-name">${escapeHtml(item.products?.name || 'Unknown')}</span>
        ${isNew ? '<span class="kds-item-added">NEW</span>' : ''}
      </div>`;
    }).join('');

    return `<div class="pipeline-card ${isOldest ? 'pipeline-card-oldest' : ''}" data-order-id="${o.id}">
      <div class="pipeline-card-header">
        <span class="pipeline-order-id">#${orderIdShort}</span>
        <span class="pipeline-table-badge">${escapeHtml(tableInfo)}</span>
        ${hasNewItems ? '<span class="kds-new-badge">NEW</span>' : ''}
      </div>
      <div class="pipeline-items">${items}</div>
      <div class="pipeline-card-footer">
        <span class="pipeline-timer" data-created="${o.created_at}">${elapsed}</span>
        <span class="pipeline-progress">${dots}</span>
        <span class="pipeline-payment ${isPaid ? 'paid' : 'unpaid'}">${isPaid ? t('kds.paid') : t('kds.unpaid')}</span>
      </div>
      ${actionBtn}
    </div>`;
  }

  // --- Live Timers ---
  function startKitchenTimers() {
    if (kitchenTimerInterval) return;
    kitchenTimerInterval = setInterval(() => {
      document.querySelectorAll('.pipeline-timer[data-created]').forEach(el => {
        el.textContent = formatElapsed(el.dataset.created);
      });
      // Update table map elapsed times too
      document.querySelectorAll('.kitchen-table-meta').forEach(el => {
        // Tables don't have live timers, but pipeline cards do
      });
    }, 1000);
  }

  function stopKitchenTimers() {
    if (kitchenTimerInterval) { clearInterval(kitchenTimerInterval); kitchenTimerInterval = null; }
  }

  function formatElapsed(isoStr) {
    if (!isoStr) return '';
    const ms = Date.now() - new Date(isoStr).getTime();
    if (ms < 0) return '0:00';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }

  function updateCount(elId, count) {
    const el = document.getElementById(elId);
    if (el) el.textContent = count !== '' && count !== undefined && count !== null ? `(${count})` : '';
  }

  // --- Status update ---
  async function kitchenAdvanceStatus(orderId, newStatus) {
    if (newStatus === 'served') {
      const { data: order } = await sb.from('orders')
        .select('id, business_id, order_items(id, quantity, product_id, products(product_type))')
        .eq('id', orderId).eq('business_id', membership.business_id).single();
      if (order) {
        const stockOps = (order.order_items || [])
          .filter(item => item.products && item.products.product_type !== 'recipe')
          .map(item => Promise.all([
            adjustStock('products', item.product_id, -item.quantity, membership.business_id),
            logStockMovement({ itemType: 'product', productId: item.product_id, qtyChange: -item.quantity, reason: 'sale', refType: 'order', refId: order.id })
          ]));
        await Promise.all(stockOps);
      }
      await sb.from('orders').update({ status: 'served' }).eq('id', orderId).eq('business_id', membership.business_id);
      logAudit("update", "order", orderId, null, { status: 'served' });
      loadProducts();
    } else {
      await sb.from('orders').update({ status: newStatus }).eq('id', orderId).eq('business_id', membership.business_id);
      logAudit("update", "order", orderId, null, { status: newStatus });
    }
    await loadKitchenOrders();
  }

  function openStoreTab() {
    switchTab('materials');
  }

  // --- Kitchen Stock (visual cards) ---
  function renderKitchenStock() {
    const el = document.getElementById('kitchen-stock-grid');
    if (!el) return;
    const items = (cache.materials || []).filter(m => Number(m.kitchen_stock_qty || 0) > 0 || Number(m.stock_qty || 0) > 0);

    // Low stock alerts
    const lowStockEl = document.getElementById('kitchen-low-stock');
    if (lowStockEl) {
      const lowStockItems = (cache.materials || []).filter(m => {
        const threshold = Number(m.low_stock_threshold) || 10;
        return Number(m.kitchen_stock_qty || 0) > 0 && Number(m.kitchen_stock_qty || 0) <= threshold;
      });
      if (lowStockItems.length > 0) {
        lowStockEl.innerHTML = `<div style="background: rgba(217,119,6,0.08); border:1px solid rgba(217,119,6,0.25); border-radius:8px; padding:10px 12px; margin-bottom:12px;">
          <strong style="color:var(--amber); font-size:13px;">⚠ ${t('kds.low_stock')}</strong>
          ${lowStockItems.map(m => `<div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid rgba(217,119,6,0.1); font-size:12px;">
            <span>${escapeHtml(m.name)} — ${m.kitchen_stock_qty || 0} ${escapeHtml(m.unit)}</span>
            <button class="kitchen-stock-send-btn" onclick="openSendToKitchenModal('${m.id}')">${t('kds.send_to_kitchen')}</button>
          </div>`).join('')}
        </div>`;
      } else {
        lowStockEl.innerHTML = '';
      }
    }

    if (items.length === 0) {
      el.innerHTML = `<div class="kitchen-empty" style="grid-column:1/-1;">No stock in the kitchen yet.</div>`;
      updateCount('kitchen-stock-count', '');
      return;
    }

    updateCount('kitchen-stock-count', items.length);
    el.innerHTML = items
      .slice()
      .sort((a, b) => Number(b.kitchen_stock_qty || 0) - Number(a.kitchen_stock_qty || 0))
      .map(m => {
        const kitchenQty = Number(m.kitchen_stock_qty || 0);
        const storeQty = Number(m.stock_qty || 0);
        const threshold = Number(m.low_stock_threshold) || 10;
        const isLow = kitchenQty > 0 && kitchenQty <= threshold;
        const maxQty = Math.max(kitchenQty + storeQty, 1);
        const kitchenPct = (kitchenQty / maxQty) * 100;
        const storePct = (storeQty / maxQty) * 100;
        return `<div class="kitchen-stock-card ${isLow ? 'low-stock' : ''}">
          <span class="kitchen-stock-name">${escapeHtml(m.name)}</span>
          <div class="kitchen-stock-bar-container">
            <div class="kitchen-stock-bar-row">
              <span class="kitchen-stock-bar-label">${t('kds.kitchen_stock')}</span>
              <div class="kitchen-stock-bar-track"><div class="kitchen-stock-bar-fill fill-kitchen" style="width:${kitchenPct}%"></div></div>
              <span class="kitchen-stock-bar-value">${kitchenQty} ${escapeHtml(m.unit)}</span>
            </div>
            <div class="kitchen-stock-bar-row">
              <span class="kitchen-stock-bar-label">${t('kds.store_stock')}</span>
              <div class="kitchen-stock-bar-track"><div class="kitchen-stock-bar-fill fill-store" style="width:${storePct}%"></div></div>
              <span class="kitchen-stock-bar-value">${storeQty} ${escapeHtml(m.unit)}</span>
            </div>
          </div>
          ${storeQty > 0 ? `<div class="kitchen-stock-actions"><button class="kitchen-stock-send-btn" onclick="openSendToKitchenModal('${m.id}')">${t('kds.send_to_kitchen')} →</button></div>` : ''}
        </div>`;
      }).join('');
  }

  function posCalcTotals() {
    const subtotal = posState.cart.reduce((sum, item) => sum + item.line_total, 0);
    let discount = 0;
    if (posState.discountType === 'percent') {
      discount = subtotal * (posState.appliedDiscount / 100);
    } else {
      discount = posState.appliedDiscount;
    }
    const taxable = subtotal - discount;
    const settings = getSettings();
    const taxRate = (settings.tax_rate || 0) / 100;
    const tax = taxable * taxRate;
    const total = taxable + tax;
    return { subtotal, discount, tax, total, taxRate };
  }

  function posRenderCart() {
    const el = document.getElementById('pos-cart');
    if (!el) return;
    if (posState.cart.length === 0) {
      el.innerHTML = '<div class="pos-empty">Tap products to add to order</div>';
      posUpdateTotalsUI();
      return;
    }
    el.innerHTML = posState.cart.map((item, idx) => {
      const hasSplit = posState.cart.some(i => i.splitGroup && i.splitGroup > 1);
      return `
      <div class="pos-cart-item">
        <div class="pos-cart-main">
          <div class="pos-cart-name">${escapeHtml(item.name)}${hasSplit && item.splitGroup ? ` <span class="split-badge">#${item.splitGroup}</span>` : ''}</div>
          <div class="pos-cart-qty">
            <button class="qty-btn" onclick="posChangeQty(${idx}, -1)">−</button>
            <span>${item.qty}</span>
            <button class="qty-btn" onclick="posChangeQty(${idx}, 1)">+</button>
          </div>
        </div>
        <div class="pos-cart-right">
          <div class="pos-cart-line-total">${money(item.line_total)}</div>
          <button class="pos-remove" onclick="posRemoveItem(${idx})" aria-label="Remove">✕</button>
        </div>
      </div>`;
    }).join('');
    posUpdateTotalsUI();
  }

  function posUpdateTotalsUI() {
    const { subtotal, discount, tax, total } = posCalcTotals();
    const subEl = document.getElementById('pos-subtotal');
    const discEl = document.getElementById('pos-discount');
    const taxEl = document.getElementById('pos-tax');
    const totalEl = document.getElementById('pos-grand-total');
    if (subEl) subEl.textContent = money(subtotal);
    if (discEl) discEl.textContent = discount > 0 ? `-${money(discount)}` : money(0);
    if (taxEl) taxEl.textContent = money(tax);
    if (totalEl) totalEl.textContent = money(total);
    const countEl = document.getElementById('pos-cart-count');
    if (countEl) {
      const count = posState.cart.reduce((s, i) => s + (Number(i.qty) || 1), 0);
      const panel = document.getElementById('pos-right');
      const expandedIcon = panel && panel.classList.contains('expanded') ? '✕' : '⛶';
      countEl.innerHTML = `${count} item${count === 1 ? '' : 's'}<span class="pos-cart-expand-icon" id="pos-cart-expand-icon">${expandedIcon}</span>`;
    }
  }

  function posAddProduct(productId) {
    const product = cache.products.find(p => p.id === productId);
    if (!product) return;
    if (product.product_type === 'recipe') {
      const avail = getDerivedAvailability(product.id);
      if (avail <= 0) { showToast('Currently unavailable — ingredients out of stock', 'error'); return; }
    }
    const existing = posState.cart.find(i => i.product_id === product.id);
    if (existing) {
      existing.qty += 1;
      existing.line_total = existing.qty * existing.price;
    } else {
      posState.cart.push({
        product_id: product.id,
        name: product.name,
        price: product.price,
        qty: 1,
        modifiers: [],
        discount: 0,
        line_total: product.price,
      });
    }
    posRenderCart();
  }

  function posChangeQty(idx, delta) {
    const item = posState.cart[idx];
    if (!item) return;
    item.qty = Math.max(1, item.qty + delta);
    item.line_total = item.qty * item.price;
    posRenderCart();
  }

  function posRemoveItem(idx) {
    posState.cart.splice(idx, 1);
    posRenderCart();
  }

  function posClearCart() {
    if (!confirm('Clear entire cart?')) return;
    posState.cart = [];
    posRenderCart();
  }

  function posOpenTableMap() {
    posReset();
    openModal('table-map-modal');
    posLoadTables();
  }

  async function posLoadTables() {
    const { data } = await sb.from('restaurant_tables')
      .select('*, orders!current_order_id(status, id)')
      .eq('business_id', membership.business_id)
      .order('table_number');
    const grid = document.getElementById('table-grid');
    if (!data || data.length === 0) {
      grid.innerHTML = `<div class="pos-empty">${t('pos.no_tables')}</div>`;
      return;
    }
    grid.innerHTML = data.map(tb => {
      const orderStatus = tb.orders?.status;
      const orderId = tb.orders?.id;
      const isServed = orderStatus === 'served';
      const isActive = orderStatus && ['pending','preparing','ready'].includes(orderStatus);
      return `
        <button class="table-btn ${isServed ? 'served' : isActive ? 'occupied' : ''}" 
          onclick="${isServed ? `payTableOrder('${escapeAttr(orderId)}')` : isActive ? `addTableOrder('${escapeAttr(orderId)}', '${escapeAttr(tb.id)}', '${escapeAttr(tb.table_number)}')` : `posSelectTable('${escapeAttr(tb.id)}', '${escapeAttr(tb.table_number)}')`}">
          <span class="table-num">${escapeHtml(tb.table_number)}</span>
          ${tb.name ? `<span class="table-name">${escapeHtml(tb.name)}</span>` : ''}
          ${isServed ? `<span class="table-status served-status">${t('pos.ready_to_pay')}</span>` : isActive ? `<span class="table-status">${t('pos.occupied')} — Tap to add</span>` : ''}
        </button>
      `;
    }).join('');
  }

  function posSelectTable(tableId, tableNumber) {
    posState.tableId = tableId;
    posState.tableNumber = tableNumber;
    closeModal('table-map-modal');
    posOpenCart();
  }

  function posNewWalkIn() {
    posState.orderType = 'takeout';
    closeModal('table-map-modal');
    posOpenCart();
  }

  async function addTableOrder(orderId, tableId, tableNumber) {
    const { data: order, error } = await sb.from('orders')
      .select('*, order_items(*, products(name, price, product_type))')
      .eq('id', orderId)
      .eq('business_id', membership.business_id)
      .single();
    if (error || !order) return showToast('Order not found', 'error');
    posState.orderId = orderId;
    posState.tableId = tableId;
    posState.tableNumber = tableNumber;
    posState.cart = (order.order_items || []).map(item => ({
      product_id: item.product_id,
      name: item.products?.name || 'Unknown',
      price: item.unit_price,
      qty: item.quantity,
      modifiers: [],
      discount: 0,
      line_total: item.line_total || item.unit_price * item.quantity,
    }));
    posState.appliedDiscount = order.discount || 0;
    posState.discountType = order.discount_type || 'amount';
    closeModal('table-map-modal');
    posOpenCart();
    showToast(`Table ${tableNumber} — adding to existing order`, 'info');
  }

  function posOpenCart() {
    openModal('pos-modal');
    posRenderProducts();
    posRenderCart();
    updateCustomerDisplay();
    updateHeldOrdersBar();
    posSetupCartDrag();
  }

  let posActiveCategory = null;
  let posSearchQuery = '';

  function posRenderProductList(products) {
    const el = document.getElementById('pos-products');
    if (!el) return;
    if (products.length === 0) {
      el.innerHTML = '<div class="pos-empty">No products found</div>';
      return;
    }
    el.innerHTML = products.map(p => {
      let stockHtml = '';
      if (p.product_type === 'recipe') {
        const avail = getDerivedAvailability(p.id);
        if (avail <= 0) stockHtml = '<span class="pos-prod-stock" style="color:var(--danger)">Unavailable</span>';
      } else if (p.stock_qty !== null && p.stock_qty <= 0) {
        stockHtml = '<span class="pos-prod-stock" style="color:var(--danger)">Out of stock</span>';
      }
      return `<button class="pos-product-btn" onclick="posAddProduct('${escapeAttr(p.id)}')">
        <span class="pos-prod-name">${escapeHtml(p.name)}</span>
        <span class="pos-prod-price">${money(p.price)}</span>
        ${stockHtml}
      </button>`;
    }).join('');
  }

  async function posRenderProducts() {
    const catEl = document.getElementById('pos-categories');
    if (!catEl) return;
    const types = [{ key: null, label: 'All' }, { key: 'resale', label: 'Buy & Sell' }, { key: 'recipe', label: 'Made to Order' }];
    if (businessUsesRawMaterials()) types.push({ key: 'manufactured', label: 'Manufactured' });
    catEl.innerHTML = types.map(t =>
      `<button class="pos-cat-btn" onclick="posFilterType(${t.key ? `'${escapeAttr(t.key)}'` : 'null'})">${escapeHtml(t.label)}</button>`
    ).join('');
    catEl.querySelector('.pos-cat-btn').classList.add('active');
    posRenderProductList(cache.products);
  }

  function posFilterType(type) {
    posActiveCategory = type;
    posSearchQuery = '';
    const searchInput = document.getElementById('pos-search-input');
    if (searchInput) searchInput.value = '';
    document.querySelectorAll('.pos-cat-btn').forEach(b => {
      const btnType = b.getAttribute('onclick')?.includes('null') ? null : b.getAttribute('onclick')?.match(/'(\w+)'/)?.[1];
      b.classList.toggle('active', btnType === type);
    });
    const filtered = type ? cache.products.filter(p => p.product_type === type) : cache.products;
    posRenderProductList(filtered);
  }

  function posSearchProducts(query) {
    posSearchQuery = query.trim().toLowerCase();
    if (posSearchQuery) {
      document.querySelectorAll('.pos-cat-btn').forEach(b => b.classList.remove('active'));
      posActiveCategory = null;
      posRenderProductList(cache.products.filter(p => p.name.toLowerCase().includes(posSearchQuery)));
    } else if (posActiveCategory) {
      posFilterType(posActiveCategory);
    } else {
      posRenderProductList(cache.products);
    }
  }

  function posToggleCart() {
    const panel = document.getElementById('pos-right');
    if (!panel) return;
    panel.style.height = '';
    panel.style.transition = '';
    panel.classList.toggle('expanded');
    const icon = document.getElementById('pos-cart-expand-icon');
    if (icon) icon.textContent = panel.classList.contains('expanded') ? '✕' : '⛶';
  }

  function posSetupCartDrag() {
    const handle = document.getElementById('pos-cart-drag');
    const panel = document.getElementById('pos-right');
    if (!handle || !panel || handle.dataset.dragSetup) return;
    handle.dataset.dragSetup = '1';
    let startY = 0;
    let startH = 0;
    let dragging = false;

    const onStart = (e) => {
      if (window.innerWidth > 720) return;
      dragging = true;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startH = panel.getBoundingClientRect().height;
      panel.style.transition = 'none';
      panel.style.height = startH + 'px';
      handle.classList.add('dragging');
      e.stopPropagation();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const dh = y - startY;
      let h = startH - dh;
      h = Math.max(80, Math.min(window.innerHeight * 0.95, h));
      panel.style.height = h + 'px';
      e.preventDefault();
      e.stopPropagation();
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      panel.style.transition = '';
      const h = panel.getBoundingClientRect().height;
      panel.style.height = h + 'px';
      const expanded = h > window.innerHeight * 0.45;
      panel.classList.toggle('expanded', expanded);
      const icon = document.getElementById('pos-cart-expand-icon');
      if (icon) icon.textContent = expanded ? '✕' : '⛶';
    };

    handle.addEventListener('touchstart', onStart, { passive: false });
    handle.addEventListener('touchmove', onMove, { passive: false });
    handle.addEventListener('touchend', onEnd);
    handle.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
  }

  // --- POS Cart Modal Actions ---

  // ========== SPLIT PAYMENTS ==========
  let paymentState = { orderId: null, baseTotal: 0, tip: 0, lines: [] };

  function paymentTotalDue() {
    return paymentState.baseTotal + paymentState.tip;
  }

  function paymentSumLines() {
    return paymentState.lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  }

  function posUpdatePaymentTotal(newTotal) {
    const el = document.getElementById('payment-total-due');
    if (el) el.textContent = money(newTotal);
  }

  function renderPaymentSummary() {
    posUpdatePaymentTotal(paymentTotalDue());
    const remaining = paymentTotalDue() - paymentSumLines();
    const row = document.getElementById('payment-remaining-row');
    const completeBtn = document.getElementById('complete-payment-btn');
    if (!row || !completeBtn) return;
    if (remaining > 0.01) {
      row.textContent = `${t('payment_screen.remaining') !== 'payment_screen.remaining' ? t('payment_screen.remaining') : 'Remaining'}: ${money(remaining)}`;
      row.className = 'payment-remaining due';
      completeBtn.disabled = true;
    } else if (remaining < -0.01) {
      row.textContent = `${t('payment_screen.change') !== 'payment_screen.change' ? t('payment_screen.change') : 'Change'}: ${money(-remaining)}`;
      row.className = 'payment-remaining change';
      completeBtn.disabled = false;
    } else {
      row.textContent = '';
      row.className = 'payment-remaining';
      completeBtn.disabled = false;
    }
  }

  function paymentMethodOptions(selected) {
    return ['cash', 'card'].map(m => {
      const label = m === 'cash' ? 'Cash' : 'Card / Bank Transfer';
      const i18nKey = m === 'cash' ? 'payment_screen.cash' : 'payment_screen.card';
      const text = t(i18nKey) !== i18nKey ? t(i18nKey) : label;
      return `<option value="${m}" ${m === selected ? 'selected' : ''}>${escapeHtml(text)}</option>`;
    }).join('');
  }

  function renderPaymentLines() {
    const el = document.getElementById('payment-lines');
    if (!el) return;
    el.innerHTML = paymentState.lines.map((line, idx) => `
      <div class="payment-line">
        <select class="payment-line-method" onchange="updatePaymentLineMethod(${idx}, this.value)">
          ${paymentMethodOptions(line.method)}
        </select>
        <input type="number" class="payment-line-amount num" step="0.01" min="0" value="${line.amount}" oninput="updatePaymentLineAmount(${idx}, this.value)" />
        ${paymentState.lines.length > 1 ? `<button type="button" class="payment-line-remove" onclick="removePaymentLine(${idx})">✕</button>` : `<span class="payment-line-spacer"></span>`}
      </div>
    `).join('');
    renderPaymentSummary();
  }

  function updatePaymentLineMethod(idx, val) {
    if (!paymentState.lines[idx]) return;
    paymentState.lines[idx].method = val;
  }

  function updatePaymentLineAmount(idx, val) {
    if (!paymentState.lines[idx]) return;
    paymentState.lines[idx].amount = parseFloat(val) || 0;
    renderPaymentSummary();
  }

  function addPaymentLine() {
    const remaining = Math.max(0, paymentTotalDue() - paymentSumLines());
    const usedMethods = paymentState.lines.map(l => l.method);
    const nextMethod = ['cash', 'card'].find(m => !usedMethods.includes(m)) || 'cash';
    paymentState.lines.push({ method: nextMethod, amount: remaining });
    renderPaymentLines();
  }

  function removePaymentLine(idx) {
    if (paymentState.lines.length <= 1) return;
    paymentState.lines.splice(idx, 1);
    renderPaymentLines();
  }

  // Step 5: atomic order write via SQL RPC. Returns {ok, data} — caller falls back to the
  // legacy await-chain when the RPC is missing/fails (safety rule: keep legacy flows alive).
  async function placeOrderViaRpc(orderId, orderFields, cartItems) {
    if (!FEATURES.atomicRpc) return { ok: false };
    const items = cartItems.map(item => ({ product_id: item.product_id, quantity: item.qty, unit_price: item.price }));
    try {
      const { data, error } = await sb.rpc('place_order', {
        p_business_id: membership.business_id,
        p_order: orderFields,
        p_items: items,
        p_order_id: orderId || null,
      });
      if (error) throw error;
      return { ok: true, data };
    } catch (e) {
      console.warn('place_order RPC failed, using legacy flow:', e?.message || e);
      return { ok: false };
    }
  }

  async function submitOrder() {
    if (posState.cart.length === 0) return showToast('Cart is empty', 'error');
    const btn = document.getElementById('pos-pay-btn');
    setBtnLoading(btn, true);

    const { subtotal, discount, tax, total, taxRate } = posCalcTotals();

    // APPENDING TO EXISTING TABLE ORDER
    if (posState.orderId) {
      const orderId = posState.orderId;

      // Recalc totals on the order (keep current status — don't reset)
      const orderSubtotal = posState.cart.reduce((s, i) => s + i.line_total, 0);
      let orderDiscount = 0;
      if (posState.discountType === 'percent') {
        orderDiscount = orderSubtotal * (posState.appliedDiscount / 100);
      } else {
        orderDiscount = posState.appliedDiscount;
      }
      const orderTaxable = orderSubtotal - orderDiscount;
      const orderTax = orderTaxable * taxRate;
      const orderTotal = orderTaxable + orderTax;

      const rpcResult = await placeOrderViaRpc(orderId, {
        branch_id: selectedBranchId || '',
        subtotal: orderSubtotal, discount: orderDiscount, discount_type: posState.discountType || 'amount',
        tax_rate: taxRate, tax: orderTax, total_amount: orderTotal,
      }, posState.cart);

      if (!rpcResult.ok) {
        // Legacy path: replace all order_items with the current cart
        // (order_items has no business_id column — orderId is verified as
        // business-owned when it was loaded into posState via payTableOrder).
        const { error: delErr } = await sb.from('order_items').delete().eq('order_id', orderId);
        if (delErr) { setBtnLoading(btn, false); return showToast(delErr.message, 'error'); }

        const newItems = posState.cart.map(item => ({
          order_id: orderId,
          product_id: item.product_id,
          quantity: item.qty,
          unit_price: item.price,
        }));
        const { error: insErr } = await sb.from('order_items').insert(newItems);
        if (insErr) { setBtnLoading(btn, false); return showToast(insErr.message, 'error'); }

        await sb.from('orders').update({
          subtotal: orderSubtotal,
          discount: orderDiscount,
          discount_type: posState.discountType || 'amount',
          tax_rate: taxRate,
          tax: orderTax,
          total_amount: orderTotal,
        }).eq('id', orderId).eq('business_id', membership.business_id);
      }
      logAudit("update", "order", orderId, null, { subtotal: orderSubtotal, discount: orderDiscount, tax: orderTax, total_amount: orderTotal }, { items_replaced: posState.cart.length });

      showToast('Order updated — kitchen notified', 'success');
      playKDSSound('new');
      setBtnLoading(btn, false);
      closeModal('pos-modal');
      posReset();
      await loadProducts();
      return;
    }

    // NEW ORDER (no existing order)
    const hasSplit = posState.cart.some(i => i.splitGroup && i.splitGroup > 1);
    const groups = {};
    posState.cart.forEach(item => {
      const g = item.splitGroup || 1;
      if (!groups[g]) groups[g] = [];
      groups[g].push(item);
    });

    const orderIds = [];
    for (const [group, items] of Object.entries(groups)) {
      const groupSubtotal = items.reduce((s, i) => s + i.line_total, 0);
      const groupDiscount = subtotal > 0 ? discount * (groupSubtotal / subtotal) : 0;
      const groupTax = (groupSubtotal - groupDiscount) * taxRate;
      const groupTotal = groupSubtotal - groupDiscount + groupTax;

      // Step 5: atomic insert of order + items (+ table occupancy) in one transaction
      const rpcResult = await placeOrderViaRpc(null, {
        branch_id: selectedBranchId || '',
        table_id: posState.tableId || '',
        customer_id: posState.customerId || '',
        order_type: posState.tableId ? 'dine_in' : (posState.orderType || 'takeout'),
        subtotal: groupSubtotal, discount: groupDiscount, discount_type: posState.discountType || 'amount',
        tax_rate: taxRate, tax: groupTax, tip: 0, total_amount: groupTotal,
      }, items);

      if (rpcResult.ok) {
        orderIds.push(rpcResult.data.order_id);
        logAudit("create", "order", rpcResult.data.order_id, null, { status: 'pending', total_amount: groupTotal });
        logUsage("order_placed", "pos", "order", rpcResult.data.order_id);
        continue;
      }

      // Legacy await-chain fallback
      const { data: order, error: orderErr } = await sb.from('orders').insert(stampBranch({
        business_id: membership.business_id,
        table_id: posState.tableId || null,
        customer_id: posState.customerId || null,
        order_type: posState.tableId ? 'dine_in' : (posState.orderType || 'takeout'),
        status: 'pending',
        subtotal: groupSubtotal,
        discount: groupDiscount,
        discount_type: posState.discountType || 'amount',
        tax_rate: taxRate,
        tax: groupTax,
        tip: 0,
        total_amount: groupTotal,
        payment_method: null,
        created_by: currentUser.id,
      })).select().single();
      if (orderErr) { setBtnLoading(btn, false); return showToast(orderErr.message, 'error'); }
      orderIds.push(order.id);
      logAudit("create", "order", order.id, null, order);
      logUsage("order_placed", "pos", "order", order.id);

      const orderItems = items.map(item => ({
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.qty,
        unit_price: item.price,
      }));
      const { error: itemsErr } = await sb.from('order_items').insert(orderItems);
      if (itemsErr) { setBtnLoading(btn, false); return showToast(itemsErr.message, 'error'); }
    }

    if (hasSplit) {
      showToast(`${Object.keys(groups).length} orders placed`, 'success');
    } else {
      showToast(t('pos.order_placed'), 'success');
    }

    // Mark table as occupied (use first order id)
    if (posState.tableId && orderIds.length > 0) {
      await sb.from('restaurant_tables').update({ status: 'occupied', current_order_id: orderIds[0] }).eq('id', posState.tableId).eq('business_id', membership.business_id);
    }

    setBtnLoading(btn, false);
    closeModal('pos-modal');
    posReset();
    await loadProducts();
  }

  async function payTableOrder(orderId) {
    const { data: order } = await sb.from('orders')
      .select('*, order_items(*, products(name))')
      .eq('id', orderId).eq('business_id', membership.business_id).single();
    if (!order) return showToast('Order not found', 'error');

    // Store current order for payment processing
    posState.orderId = orderId;
    posState.tableId = order.table_id;

    const total = order.total_amount || 0;
    paymentState = { orderId, baseTotal: total, tip: 0, lines: [{ method: 'cash', amount: total }] };
    document.getElementById('payment-error')?.classList.add('hidden');
    document.getElementById('custom-tip').value = '';
    document.querySelectorAll('.tip-btn').forEach(b => b.classList.remove('active'));
    renderPaymentLines();

    // Tip changes reset to a single line for the new total; user re-splits after if needed
    const resetLinesToSingle = () => {
      const method = paymentState.lines[0]?.method || 'cash';
      paymentState.lines = [{ method, amount: paymentTotalDue() }];
      renderPaymentLines();
    };

    const tipBtns = document.getElementById('tip-buttons');
    tipBtns.innerHTML = '';
    [10, 15, 20].forEach(pct => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tip-btn';
      btn.textContent = `${pct}%`;
      btn.onclick = () => {
        document.querySelectorAll('.tip-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('custom-tip').value = '';
        paymentState.tip = paymentState.baseTotal * (pct / 100);
        resetLinesToSingle();
      };
      tipBtns.appendChild(btn);
    });
    document.getElementById('custom-tip').oninput = (e) => {
      document.querySelectorAll('.tip-btn').forEach(b => b.classList.remove('active'));
      paymentState.tip = parseFloat(e.target.value) || 0;
      resetLinesToSingle();
    };

    closeModal('table-map-modal');
    openModal('payment-modal');
  }

  async function completePayment() {
    const orderId = paymentState.orderId;
    if (!orderId) return showToast('No order to pay', 'error');

    const finalTotal = paymentTotalDue();
    const sumLines = paymentSumLines();
    const remaining = finalTotal - sumLines;
    if (remaining > 0.01) return; // guard — Complete button should already be disabled

    const btn = document.getElementById('complete-payment-btn');
    setBtnLoading(btn, true);
    clearError('payment-error');

    const { data: order } = await sb.from('orders').select('*').eq('id', orderId).single();
    if (!order) { setBtnLoading(btn, false); return showToast('Order not found', 'error'); }

    const changeGiven = Math.max(0, -remaining);
    const linesUsed = paymentState.lines.filter(l => (parseFloat(l.amount) || 0) > 0);
    const methodSummary = linesUsed.length > 1
      ? 'split'
      : (linesUsed[0]?.method || 'cash');

    // 1. Update order with tip, payment method, mark completed
    const { error: orderErr } = await sb.from('orders').update({
      status: 'completed',
      tip: paymentState.tip,
      total_amount: finalTotal,
      payment_method: methodSummary,
      change_given: changeGiven,
    }).eq('id', orderId).eq('business_id', membership.business_id);
    if (orderErr) { setBtnLoading(btn, false); return setError('payment-error', orderErr.message); }
    logAudit("update", "order", orderId, null, { status: 'completed', tip: paymentState.tip, total_amount: finalTotal, payment_method: methodSummary });

    // 2. Create one payment record per method used (capped so change isn't counted as revenue)
    const paymentRows = [];
    let remainingToAllocate = finalTotal;
    for (const line of linesUsed) {
      let amt = parseFloat(line.amount) || 0;
      if (amt > remainingToAllocate) amt = remainingToAllocate; // trims the overpaid/change portion
      if (amt <= 0) continue;
      paymentRows.push(stampBranch({ order_id: orderId, customer_id: order.customer_id, amount: amt, method: line.method }));
      remainingToAllocate -= amt;
    }
    let paymentsOk = false;
    if (FEATURES.atomicRpc && paymentRows.length > 0) {
      try {
        const { data: payData, error: payErr } = await sb.rpc('record_payments', {
          p_business_id: membership.business_id,
          p_payments: paymentRows,
        });
        if (payErr) throw payErr;
        paymentsOk = true;
      } catch (e) {
        console.warn('record_payments RPC failed, using legacy flow:', e?.message || e);
      }
    }
    if (!paymentsOk) {
      for (const row of paymentRows) {
        await sb.from('payments').insert({
          business_id: membership.business_id,
          branch_id: row.branch_id || null,
          order_id: row.order_id,
          customer_id: row.customer_id,
          amount: row.amount,
          method: row.method,
          direction: 'in',
          created_by: currentUser.id,
        });
      }
    }
    logUsage("payment_completed", "pos", "order", orderId, { methods: paymentRows.map((r) => r.method), total: finalTotal });

    // 3. Free table
    if (order.table_id) {
      await sb.from('restaurant_tables').update({ status: 'available', current_order_id: null }).eq('id', order.table_id).eq('business_id', membership.business_id);
    }

    setBtnLoading(btn, false);
    closeModal('payment-modal');

    await posShowReceipt(orderId);
    posState.orderId = null;
    posState.tableId = null;
    paymentState = { orderId: null, baseTotal: 0, tip: 0, lines: [] };
    await loadSales();
    renderDashboard();
  }

  async function posShowReceipt(orderId) {
    const { data: order } = await sb.from('orders')
      .select('*, customers(name), restaurant_tables!table_id(table_number, name), order_items(*, products(name))')
      .eq('id', orderId).single();
    if (!order) return;
    const { data: orderPayments } = await sb.from('payments')
      .select('amount, method')
      .eq('order_id', orderId)
      .eq('direction', 'in');
    const { data: business } = await sb.from('businesses')
      .select('name, address, phone, tax_id')
      .eq('id', membership.business_id).single();
    const biz = business || membership.businesses || {};
    const cashierName = membership.full_name || currentUser.email;
    const receiptNum = order.receipt_number ? `#${order.receipt_number}` : `#${order.id.slice(0,8).toUpperCase()}`;
    const settings = getSettings();
    const receiptFooter = settings.receipt_footer || 'Thank you!';
    const content = document.getElementById('receipt-content');
    content.innerHTML = `
      <div class="receipt-header">
        <h3>${escapeHtml(biz.name || 'Thole Solutions')}</h3>
        ${biz.address ? `<p>${escapeHtml(biz.address)}</p>` : ''}
        ${biz.phone ? `<p>${escapeHtml(biz.phone)}</p>` : ''}
        ${biz.tax_id ? `<p>Tax ID: ${escapeHtml(biz.tax_id)}</p>` : ''}
        <p>Receipt ${receiptNum}</p>
        <p>${new Date(order.created_at).toLocaleString()}</p>
        ${order.order_type ? `<p>${escapeHtml(order.order_type.replace('_',' '))}</p>` : ''}
        ${order.customers ? `<p>${escapeHtml(order.customers.name)}</p>` : `<p>Walk-in</p>`}
        ${order.restaurant_tables ? `<p>Table ${order.restaurant_tables.table_number}${order.restaurant_tables.name ? ' — ' + escapeHtml(order.restaurant_tables.name) : ''}</p>` : ''}
        <p>Cashier: ${escapeHtml(cashierName)}</p>
      </div>
      <div class="receipt-items">
        ${(order.order_items || []).map(item => `
          <div class="receipt-line">
            <span>${escapeHtml(item.products?.name || 'Item')} x${item.quantity}</span>
            <span>${money(item.line_total || (item.quantity * item.unit_price))}</span>
          </div>
        `).join('')}
      </div>
      <div class="receipt-totals">
        <div><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
        ${order.discount > 0 ? `<div><span>Discount</span><span>-${money(order.discount)}</span></div>` : ''}
        ${order.tax > 0 ? `<div><span>Tax (${((order.tax_rate || 0) * 100).toFixed(0)}%)</span><span>${money(order.tax)}</span></div>` : ''}
        ${order.tip > 0 ? `<div><span>Tip</span><span>${money(order.tip)}</span></div>` : ''}
        <div class="receipt-total"><span>Total</span><span>${money(order.total_amount)}</span></div>
        ${(orderPayments && orderPayments.length > 1)
          ? orderPayments.map(p => `<div><span>${escapeHtml((p.method || 'cash').replace('_',' '))}</span><span>${money(p.amount)}</span></div>`).join('')
          : `<div><span>Payment</span><span>${escapeHtml((order.payment_method || 'cash').replace('_',' '))}</span></div>`}
        ${order.change_given > 0 ? `<div><span>Change</span><span>${money(order.change_given)}</span></div>` : ''}
      </div>
      <div class="receipt-footer">${escapeHtml(receiptFooter)}</div>
    `;
    openModal('receipt-modal');
  }

  async function showOrderPreview(orderId) {
    const { data: order } = await sb.from('orders')
      .select('*, customers(name), restaurant_tables!table_id(table_number, name), order_items(*, products(name))')
      .eq('id', orderId).single();
    if (!order) return showToast(t('error.order_not_found'), 'error');
    const custName = order.customers ? escapeHtml(order.customers.name) : t('sales.walk_in');
    const tableLabel = order.restaurant_tables ? `${t('pos.table')} ${order.restaurant_tables.table_number}${order.restaurant_tables.name ? ' — ' + escapeHtml(order.restaurant_tables.name) : ''}` : '';
    const statusColor = order.status === 'voided' ? 'var(--danger)' : order.status === 'completed' ? 'var(--accent)' : 'var(--amber)';
    const el = document.getElementById('order-preview-content');
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <div style="font-size:18px; font-weight:700; margin-bottom:2px;">${custName}</div>
        ${tableLabel ? `<div style="font-size:13px; color:var(--ink-soft);">${tableLabel}</div>` : ''}
        <div style="font-size:12px; color:var(--ink-faint); margin-top:4px;">${new Date(order.created_at).toLocaleString()} · <span style="color:${statusColor}; font-weight:600;">${order.status.toUpperCase()}</span></div>
      </div>
      <div style="border-top:1px solid var(--line); padding-top:8px;">
        ${(order.order_items || []).map(item => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--line);">
            <div>
              <span style="font-weight:600;">${escapeHtml(item.products?.name || t('pos.item'))}</span>
              <span style="color:var(--ink-faint); font-size:13px; margin-left:4px;">× ${item.quantity}</span>
            </div>
            <div style="font-weight:500;">${money(item.line_total || (item.quantity * item.unit_price))}</div>
          </div>
        `).join('')}
      </div>
      <div style="border-top:1px solid var(--line); padding-top:8px; margin-top:4px;">
        <div style="display:flex; justify-content:space-between; padding:3px 0; font-size:13px;"><span>${t('pos.subtotal')}</span><span>${money(order.subtotal)}</span></div>
        ${order.discount > 0 ? `<div style="display:flex; justify-content:space-between; padding:3px 0; font-size:13px;"><span>${t('pos.discount')}</span><span style="color:var(--danger);">-${money(order.discount)}</span></div>` : ''}
        ${order.tax > 0 ? `<div style="display:flex; justify-content:space-between; padding:3px 0; font-size:13px;"><span>${t('pos.tax')} (${((order.tax_rate || 0) * 100).toFixed(0)}%)</span><span>${money(order.tax)}</span></div>` : ''}
        ${order.tip > 0 ? `<div style="display:flex; justify-content:space-between; padding:3px 0; font-size:13px;"><span>${t('payment_screen.tip')}</span><span>${money(order.tip)}</span></div>` : ''}
        <div style="display:flex; justify-content:space-between; padding:6px 0; font-size:16px; font-weight:700; border-top:2px solid var(--line); margin-top:4px;"><span>${t('pos.total')}</span><span>${money(order.total_amount)}</span></div>
      </div>
      <div style="display:flex; gap:8px; margin-top:16px;">
        ${order.status === 'served' ? `<button class="btn-primary" style="flex:1;" onclick="closeModal('order-preview-modal'); payTableOrder('${escapeAttr(order.id)}')">${t('pos.pay')}</button>` : ''}
        <button class="btn-ghost" style="flex:1;" onclick="closeModal('order-preview-modal')">${t('modal.close')}</button>
      </div>
    `;
    openModal('order-preview-modal');
  }

  function printReceipt() {
    const content = document.getElementById('receipt-content');
    if (!content) return;
    const win = window.open('', '_blank', 'width=320,height=600');
    win.document.write(`<html><head><title>Receipt</title><style>
      body{font-family:'Courier New',monospace;font-size:13px;padding:16px;max-width:300px;margin:0 auto;}
      .receipt-header{text-align:center;margin-bottom:12px;}
      .receipt-header h3{margin:0 0 4px;font-size:16px;}
      .receipt-header p{margin:2px 0;font-size:12px;}
      .receipt-items{border-top:1px dashed #333;padding-top:8px;margin-bottom:8px;}
      .receipt-line{display:flex;justify-content:space-between;padding:3px 0;font-size:12px;}
      .receipt-totals{border-top:1px dashed #333;padding-top:8px;}
      .receipt-totals div{display:flex;justify-content:space-between;padding:2px 0;font-size:12px;}
      .receipt-total{font-weight:bold;font-size:14px;border-top:1px solid #333;padding-top:4px;margin-top:4px;}
      .receipt-footer{text-align:center;margin-top:12px;font-size:11px;color:#666;}
    </style></head><body>${content.innerHTML}</body></html>`);
    win.document.close();
    win.print();
    setTimeout(() => win.close(), 1000);
  }

  function downloadReceiptCSV() {
    const content = document.getElementById('receipt-content');
    if (!content) return;
    const rows = content.querySelectorAll('.receipt-line');
    let csv = 'Item,Qty,Total\n';
    rows.forEach(r => {
      const spans = r.querySelectorAll('span');
      if (spans.length >= 2) {
        const parts = spans[0].textContent.match(/^(.+)\s+x(\d+)$/);
        if (parts) csv += `"${parts[1].replace(/"/g,'""')}",${parts[2]},${spans[1].textContent}\n`;
      }
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `receipt_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ========== WASTE LOG ==========
  async function loadWaste() {
    try {
      const { data } = await sb.from('waste_log').select('id, product_id, raw_material_id, quantity, unit_cost, reason, notes, created_at').eq('business_id', membership.business_id).order('created_at', { ascending: false }).limit(50);
      const el = document.getElementById('waste-ledger');
      if (!el) return;
      if (!data || data.length === 0) { el.innerHTML = '<div class="empty-state">No waste recorded.</div>'; return; }
      el.innerHTML = `
        <div class="ledger">
          <div class="ledger-head" style="grid-template-columns: 1.5fr 1fr 1fr 1fr;"><div>Item</div><div>Qty</div><div>Reason</div><div>Date</div></div>
          ${data.map(w => {
            const prod = w.product_id ? cache.products.find(p => p.id === w.product_id) : null;
            const mat = w.raw_material_id ? cache.materials.find(m => m.id === w.raw_material_id) : null;
            const itemName = prod ? escapeHtml(prod.name) : (mat ? escapeHtml(mat.name) : '—');
            return `
            <div class="ledger-row" style="grid-template-columns: 1.5fr 1fr 1fr 1fr;">
              <div>${itemName}</div>
              <div>${w.quantity}</div>
              <div><span class="cat-badge">${w.reason}</span></div>
              <div style="color:var(--ink-faint); font-size:12px;">${new Date(w.created_at).toLocaleDateString()}</div>
            </div>`;
          }).join('')}
        </div>
      `;
    } catch(e) { console.error('loadWaste', e); }
  }

  // ========== LABOR SHIFTS ==========
  async function loadShifts() {
    try {
      const { data } = await sb.from('labor_shifts').select('id, user_id, role, hourly_rate, clock_in, clock_out, break_minutes, business_id').eq('business_id', membership.business_id).order('clock_in', { ascending: false }).limit(50);
      const el = document.getElementById('shifts-ledger');
      if (!el) return;
      if (!data || data.length === 0) { el.innerHTML = '<div class="empty-state">No shifts recorded.</div>'; return; }
      el.innerHTML = `
        <div class="toolbar"><button class="btn-small" onclick="openShiftModal()">+ Clock In</button></div>
        <div class="ledger">
          <div class="ledger-head" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr;"><div>Staff</div><div>Role</div><div>Hours</div><div>Cost</div><div>Status</div></div>
          ${data.map(s => {
            const hours = s.clock_out ? (new Date(s.clock_out) - new Date(s.clock_in)) / 36e5 - s.break_minutes/60 : (Date.now() - new Date(s.clock_in)) / 36e5 - s.break_minutes/60;
            const cost = Math.max(0, hours) * s.hourly_rate;
            return `
              <div class="ledger-row" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr;">
                <div>${s.user_id ? s.user_id.slice(0,8) + '…' : '—'}</div>
                <div>${s.role}</div>
                <div>${hours.toFixed(2)}h</div>
                <div>${money(cost)}</div>
                <div><span class="cat-badge">${s.clock_out ? 'Completed' : 'Active'}</span></div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } catch(e) { console.error('loadShifts', e); }
  }

  // ========== PRODUCE BATCHES ==========
  async function loadProduceBatches() {
    try {
      const { data } = await sb.from('produce_batches').select('id, product_id, batch_qty, actual_yield, status, created_at, business_id').eq('business_id', membership.business_id).order('created_at', { ascending: false }).limit(50);
      const el = document.getElementById('produce-batches-ledger');
      if (!el) return;
      if (!data || data.length === 0) { el.innerHTML = '<div class="empty-state">No production batches.</div>'; return; }
      el.innerHTML = `
        <div class="ledger">
          <div class="ledger-head" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr;"><div>Product</div><div>Planned</div><div>Actual</div><div>Yield</div><div>Status</div></div>
          ${data.map(b => {
            const prod = b.product_id ? cache.products.find(p => p.id === b.product_id) : null;
            return `
            <div class="ledger-row" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr;">
              <div>${prod ? escapeHtml(prod.name) : '—'}</div>
              <div>${b.batch_qty}</div>
              <div>${b.actual_yield ?? '—'}</div>
              <div>${b.actual_yield ? ((b.actual_yield / b.batch_qty) * 100).toFixed(1) + '%' : '—'}</div>
              <div><span class="cat-badge">${b.status}</span></div>
            </div>`;
          }).join('')}
        </div>
      `;
    } catch(e) { console.error('loadProduceBatches', e); }
  }

  // ========== WASTE MODAL HELPERS ==========
  async function getAvgProductCost(productId) {
    const { data } = await sb.from('purchase_order_items').select('unit_cost, quantity').eq('product_id', productId);
    if (!data || data.length === 0) return null;
    let totalCost = 0, totalQty = 0;
    data.forEach(i => { totalCost += Number(i.unit_cost || 0) * Number(i.quantity || 0); totalQty += Number(i.quantity || 0); });
    return totalQty > 0 ? totalCost / totalQty : null;
  }

  function openWasteModal() {
    const type = document.getElementById('waste-type').value;
    const prodSel = document.getElementById('waste-product');
    const matSel = document.getElementById('waste-material');
    prodSel.innerHTML = cache.products.map(p => {
      const isRecipe = p.product_type === 'recipe';
      const avail = getDerivedAvailability(p.id);
      const stockLabel = isRecipe ? `avail: ${isFinite(avail) ? avail : '∞'}` : `stock: ${p.stock_qty ?? '—'}`;
      return `<option value="${p.id}">${escapeHtml(p.name)} (${stockLabel})</option>`;
    }).join('');
    matSel.innerHTML = cache.materials.map(m => `<option value="${m.id}">${escapeHtml(m.name)} (stock: ${m.stock_qty})</option>`).join('');
    document.getElementById('waste-qty').value = '';
    document.getElementById('waste-cost').value = '';
    document.getElementById('waste-notes').value = '';
    document.getElementById('waste-reason').selectedIndex = 0;
    toggleWasteFields();
    openModal('waste-modal');
  }

  function toggleWasteFields() {
    const type = document.getElementById('waste-type').value;
    document.getElementById('waste-product').style.display = type === 'product' ? '' : 'none';
    document.getElementById('waste-material').style.display = type === 'raw_material' ? '' : 'none';
    document.getElementById('waste-cost').value = '';
    const sel = type === 'product' ? document.getElementById('waste-product') : document.getElementById('waste-material');
    if (sel.options.length > 0) {
      if (type === 'product') {
        getAvgProductCost(sel.value).then(c => { if (c != null) document.getElementById('waste-cost').value = c; });
      } else {
        const item = cache.materials.find(m => m.id === sel.value);
        if (item && item.cost_per_unit != null) document.getElementById('waste-cost').value = item.cost_per_unit;
      }
    }
    sel.onchange = function() {
      if (type === 'product') {
        getAvgProductCost(sel.value).then(c => { if (c != null) document.getElementById('waste-cost').value = c; });
      } else {
        const it = cache.materials.find(m => m.id === sel.value);
        if (it && it.cost_per_unit != null) document.getElementById('waste-cost').value = it.cost_per_unit;
      }
    };
  }

  async function submitWaste() {
    clearError('waste-error');
    const btn = document.getElementById('waste-submit-btn');
    const type = document.getElementById('waste-type').value;
    const qty = parseFloat(document.getElementById('waste-qty').value);
    const cost = parseFloat(document.getElementById('waste-cost').value) || 0;
    const reason = document.getElementById('waste-reason').value;
    const notes = document.getElementById('waste-notes').value.trim();
    if (isNaN(qty) || qty <= 0) return setError('waste-error', 'Enter a valid quantity.');

    const payload = {
      business_id: membership.business_id,
      quantity: qty,
      unit_cost: cost,
      reason,
      notes
    };
    if (type === 'product') {
      const prodId = document.getElementById('waste-product').value;
      payload.product_id = prodId;
      const prod = cache.products.find(p => p.id === prodId);
      if (prod && prod.product_type === 'recipe') {
        // Recipe waste: sale-count only, no kitchen stock deduction
      } else {
        await adjustStock('products', prodId, -qty, membership.business_id);
        await logStockMovement({ itemType: 'product', productId: prodId, qtyChange: -qty, reason: 'waste', refType: 'waste', refId: null });
      }
    } else {
      const matId = document.getElementById('waste-material').value;
      payload.raw_material_id = matId;
      await adjustStock('raw_materials', matId, -qty, membership.business_id);
      await logStockMovement({ itemType: 'raw_material', materialId: matId, qtyChange: -qty, reason: 'waste', refType: 'waste', refId: null });
    }

    setBtnLoading(btn, true);
    const { error } = await sb.from('waste_log').insert(payload);
    setBtnLoading(btn, false);
    if (error) return setError('waste-error', error.message);
    closeModal('waste-modal');
    showToast('Waste logged');
    await loadWaste();
    renderEfficiency();
  }

  async function openShiftModal() {
    const sel = document.getElementById('shift-staff');
    const { data: users } = await sb.from('app_users').select('id, full_name').eq('business_id', membership.business_id);
    sel.innerHTML = (users || []).map(u => `<option value="${u.id}">${escapeHtml(u.full_name)}</option>`).join('');
    document.getElementById('shift-rate').value = '';
    document.getElementById('shift-break').value = '0';
    document.getElementById('shift-clock-out').value = '';
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById('shift-clock-in').value = now.toISOString().slice(0, 16);
    openModal('shift-modal');
  }

  async function submitShift() {
    clearError('shift-error');
    const btn = document.getElementById('shift-submit-btn');
    const staffId = document.getElementById('shift-staff').value;
    const role = document.getElementById('shift-role').value;
    const rate = parseFloat(document.getElementById('shift-rate').value);
    const clockIn = document.getElementById('shift-clock-in').value;
    const clockOut = document.getElementById('shift-clock-out').value || null;
    const breakMin = parseInt(document.getElementById('shift-break').value) || 0;
    if (!staffId) return setError('shift-error', 'Select a staff member.');
    if (isNaN(rate) || rate < 0) return setError('shift-error', 'Enter a valid hourly rate.');
    if (!clockIn) return setError('shift-error', 'Clock in time is required.');

    const payload = {
      business_id: membership.business_id,
      user_id: staffId,
      role,
      hourly_rate: rate,
      clock_in: new Date(clockIn).toISOString(),
      break_minutes: breakMin
    };
    if (clockOut) payload.clock_out = new Date(clockOut).toISOString();

    setBtnLoading(btn, true);
    const { error } = await sb.from('labor_shifts').insert(stampBranch(payload));
    setBtnLoading(btn, false);
    if (error) return setError('shift-error', error.message);
    closeModal('shift-modal');
    showToast('Shift saved');
    await loadShifts();
    renderEfficiency();
  }

  // ========== EFFICIENCY METRICS ==========
  async function renderEfficiency() {
    try {
      const summary = await fetchDashboardSummary();
      let revenue, totalLaborCost = 0, wasteCost = 0, avgYield = null;
      if (summary) {
        revenue = Number(summary.revenue || 0);
        totalLaborCost = Number(summary.labor_cost || 0);
        wasteCost = Number(summary.waste_cost || 0);
        avgYield = summary.avg_yield_pct === null ? null : Number(summary.avg_yield_pct);
      } else {
        const { data: allSales } = await applyBranchFilter(sb.from('orders').select('total_amount, status, created_at').eq('business_id', membership.business_id), 'orders');
        revenue = (allSales || []).filter(o => o.status === 'completed').reduce((s, o) => s + Number(o.total_amount || 0), 0);
      }
      const materialCost = cache.materials.reduce((s, m) => s + (Number(m.stock_qty) * Number(m.cost_per_unit || 0)), 0);
      const foodCostPct = revenue > 0 ? ((materialCost / revenue) * 100).toFixed(1) : '—';
      document.getElementById('eff-food-cost').textContent = foodCostPct === '—' ? '—' : foodCostPct + '%';

      if (!summary) {
        const { data: shifts } = await applyBranchFilter(sb.from('labor_shifts').select('hourly_rate, clock_in, clock_out, break_minutes').eq('business_id', membership.business_id), 'labor_shifts');
        if (shifts) {
          shifts.forEach(s => {
            if (s.clock_out) {
              const hours = (new Date(s.clock_out) - new Date(s.clock_in)) / 36e5 - (s.break_minutes || 0) / 60;
              totalLaborCost += Math.max(0, hours) * Number(s.hourly_rate || 0);
            }
          });
        }
        const { data: waste } = await sb.from('waste_log').select('quantity, unit_cost').eq('business_id', membership.business_id);
        wasteCost = (waste || []).reduce((s, w) => s + Number(w.quantity || 0) * Number(w.unit_cost || 0), 0);
        const { data: batches } = await sb.from('produce_batches').select('batch_qty, actual_yield').eq('business_id', membership.business_id).not('actual_yield', 'is', null);
        if (batches && batches.length > 0) {
          avgYield = batches.reduce((s, b) => s + (Number(b.actual_yield) / Number(b.batch_qty) * 100), 0) / batches.length;
        }
      }
      const laborPct = revenue > 0 ? ((totalLaborCost / revenue) * 100).toFixed(1) : '—';
      document.getElementById('eff-labor-cost').textContent = laborPct === '—' ? '—' : laborPct + '%';

      document.getElementById('eff-waste-cost').textContent = money(wasteCost);

      if (avgYield !== null && !isNaN(avgYield)) {
        document.getElementById('eff-yield').textContent = avgYield.toFixed(1) + '%';
      } else {
        document.getElementById('eff-yield').textContent = '—';
      }
    } catch(e) { console.error('renderEfficiency', e); }
  }

  // ========== SETTINGS ==========
  async function saveSettings() {
    clearError('settings-error');
    const btn = document.getElementById('settings-save-btn');
    const taxRate = parseFloat(document.getElementById('setting-tax-rate').value) || 0;
    const currency = document.getElementById('setting-currency').value.trim() || 'ETB';
    const receiptFooter = document.getElementById('setting-receipt-footer').value.trim();
    const bizName = document.getElementById('setting-biz-name').value.trim();
    const address = document.getElementById('setting-address').value.trim();
    const phone = document.getElementById('setting-phone').value.trim();
    const taxId = document.getElementById('setting-tax-id').value.trim();

    const settings = { tax_rate: taxRate, currency_symbol: currency, receipt_footer: receiptFooter };
    setBtnLoading(btn, true);
    try {
      const { error } = await sb.from('businesses').update({
        name: bizName || undefined,
        address: address || null,
        phone: phone || null,
        tax_id: taxId || null,
        settings
      }).eq('id', membership.business_id);
      if (error) throw error;
      if (membership.businesses) membership.businesses.settings = settings;
    } catch(e) {
      console.error('Failed to save settings:', e);
      setTimeout(() => {
        setBtnLoading(btn, false);
        setError('settings-error', e?.message || 'Could not save settings. Please try again.');
        showToast(e?.message || 'Could not save settings', 'error');
      }, 300);
      return;
    }
    setTimeout(() => {
      setBtnLoading(btn, false);
      showToast('Settings saved');
      const succEl = document.getElementById('settings-success');
      succEl.textContent = 'Settings saved.';
      succEl.classList.remove('hidden');
      setTimeout(() => succEl.classList.add('hidden'), 3000);
    }, 300);
  }

  function loadSettings() {
    try {
      const s = getSettings();
      if (s.tax_rate != null) document.getElementById('setting-tax-rate').value = s.tax_rate;
      if (s.currency_symbol) document.getElementById('setting-currency').value = s.currency_symbol;
      if (s.receipt_footer) document.getElementById('setting-receipt-footer').value = s.receipt_footer;
    } catch(e) {}
    if (membership?.businesses) {
      const b = membership.businesses;
      document.getElementById('setting-biz-name').value = b.name || '';
      document.getElementById('setting-address').value = b.address || '';
      document.getElementById('setting-phone').value = b.phone || '';
      document.getElementById('setting-tax-id').value = b.tax_id || '';
    }
    loadTablesSettings();
  }

  function getSettings() {
    try {
      const dbSettings = membership?.businesses?.settings || {};
      const localSettings = JSON.parse(localStorage.getItem('thole:settings')) || {};
      return { ...localSettings, ...dbSettings };
    } catch(e) { return {}; }
  }

  // ========== TABLE SETTINGS (Settings tab) ==========
  let editingTableId = null;

  async function loadTablesSettings() {
    const { data } = await sb.from('restaurant_tables').select('*').eq('business_id', membership.business_id).order('table_number');
    const el = document.getElementById('settings-tables-list');
    if (!el) return;
    if (!data || data.length === 0) {
      el.innerHTML = '<div style="padding:12px 0; color:var(--ink-faint); font-size:13px;">No tables yet.</div>';
      return;
    }
    el.innerHTML = data.map(t => {
      const statusLabel = t.status === 'occupied' ? 'Occupied' : t.status === 'reserved' ? 'Reserved' : 'Available';
      return `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);">
        <div>
          <strong>Table ${escapeHtml(t.table_number)}</strong>
          ${t.name ? `<span style="color:var(--ink-faint); font-size:12px;"> — ${escapeHtml(t.name)}</span>` : ''}
          ${t.capacity ? `<span style="color:var(--ink-faint); font-size:12px;"> (${t.capacity} seats)</span>` : ''}
          <br><span style="font-size:11px; color:${t.status === 'occupied' ? 'var(--danger)' : t.status === 'reserved' ? 'var(--amber)' : 'var(--ink-faint)'};">${statusLabel}</span>
        </div>
        <button class="btn-ghost" style="font-size:12px; padding:4px 10px;" onclick="editTableSettings('${t.id}')" data-i18n="settings.edit_table">Edit</button>
      </div>`;
    }).join('');
  }

  function openTableSettingsModal() {
    editingTableId = null;
    document.getElementById('table-settings-modal-title').textContent = 'Add Table';
    document.getElementById('ts-table-number').value = '';
    document.getElementById('ts-table-name').value = '';
    document.getElementById('ts-table-capacity').value = '';
    document.getElementById('table-settings-delete-btn').style.display = 'none';
    document.getElementById('table-settings-error').classList.add('hidden');
    openModal('table-settings-modal');
  }

  function editTableSettings(tableId) {
    editingTableId = tableId;
    const tables = document.querySelectorAll('#settings-tables-list > div');
    // Refetch to get the record
    sb.from('restaurant_tables').select('*').eq('id', tableId).eq('business_id', membership.business_id).single().then(({ data, error }) => {
      if (error || !data) return showToast('Table not found', 'error');
      document.getElementById('table-settings-modal-title').textContent = 'Edit Table';
      document.getElementById('ts-table-number').value = data.table_number;
      document.getElementById('ts-table-name').value = data.name || '';
      document.getElementById('ts-table-capacity').value = data.capacity || '';
      document.getElementById('table-settings-delete-btn').style.display = 'block';
      document.getElementById('table-settings-error').classList.add('hidden');
      openModal('table-settings-modal');
    });
  }

  async function saveTableSettings() {
    const number = document.getElementById('ts-table-number').value.trim();
    if (!number) return showToast('Table number is required', 'error');
    const name = document.getElementById('ts-table-name').value.trim() || null;
    const capacity = parseInt(document.getElementById('ts-table-capacity').value) || null;

    const payload = { business_id: membership.business_id, table_number: number, name, capacity };

    if (editingTableId) {
      const { error } = await sb.from('restaurant_tables').update(payload).eq('id', editingTableId).eq('business_id', membership.business_id);
      if (error) return showToast(error.message, 'error');
    } else {
      payload.status = 'available';
      const { error } = await sb.from('restaurant_tables').insert(stampBranch(payload));
      if (error) return showToast(error.message, 'error');
    }

    closeModal('table-settings-modal');
    showToast(editingTableId ? 'Table updated' : 'Table added', 'success');
    loadTablesSettings();
  }

  async function deleteTableSettings() {
    if (!editingTableId) return;
    if (!confirm('Delete this table? This cannot be undone.')) return;
    const { error } = await sb.from('restaurant_tables').delete().eq('id', editingTableId).eq('business_id', membership.business_id);
    if (error) return showToast(error.message, 'error');
    closeModal('table-settings-modal');
    showToast('Table deleted', 'success');
    loadTablesSettings();
  }

  // ========== CUSTOMER PICKER (POS) ==========
  function updateCustomerDisplay() {
    const label = document.getElementById('pos-customer-label');
    const tableInfo = document.getElementById('pos-customer-table');
    if (!label) return;
    if (posState.customerId && posState.customerName) {
      label.textContent = posState.customerName;
    } else {
      label.textContent = 'Walk-in';
    }
    if (posState.tableNumber) {
      tableInfo.textContent = ` — Table ${posState.tableNumber}`;
    } else {
      tableInfo.textContent = '';
    }
  }

  async function openCustomerPicker() {
    const { data } = await sb.from('customers').select('id, name, phone').eq('business_id', membership.business_id).order('name').limit(50);
    const list = document.getElementById('cust-picker-list');
    if (!data || data.length === 0) {
      list.innerHTML = '<div style="padding:12px; color:var(--ink-faint); font-size:13px;">No customers yet.</div>';
    } else {
      list.innerHTML = data.map(c => `<div class="ledger-row" style="cursor:pointer;" onclick="selectCustomer('${c.id}', '${escapeAttr(c.name)}')">
        <div><strong>${escapeHtml(c.name)}</strong>${c.phone ? `<br><span style="font-size:11px; color:var(--ink-faint);">${escapeHtml(c.phone)}</span>` : ''}</div>
      </div>`).join('');
    }
    document.getElementById('cust-picker-search').value = '';
    document.getElementById('cust-picker-new-form').style.display = 'none';
    openModal('customer-picker-modal');
  }

  function searchCustomers(q) {
    const items = document.querySelectorAll('#cust-picker-list .ledger-row');
    const search = q.toLowerCase();
    items.forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = text.includes(search) ? 'flex' : 'none';
    });
  }

  function selectCustomer(id, name) {
    posState.customerId = id;
    posState.customerName = name || null;
    closeModal('customer-picker-modal');
    updateCustomerDisplay();
  }

  function showAddCustomerForm() {
    const form = document.getElementById('cust-picker-new-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
    if (form.style.display === 'block') document.getElementById('cust-picker-new-name').focus();
  }

  async function createAndSelectCustomer() {
    const name = document.getElementById('cust-picker-new-name').value.trim();
    if (!name) return showToast('Name is required', 'error');
    const phone = document.getElementById('cust-picker-new-phone').value.trim() || null;
    const { data, error } = await sb.from('customers').insert(stampBranch({
      business_id: membership.business_id, name, phone
    })).select().single();
    if (error) return showToast(error.message, 'error');
    selectCustomer(data.id, data.name);
    showToast('Customer created', 'success');
  }

  // ========== SPLIT BILL ==========
  function posSplitBill() {
    if (posState.cart.length === 0) return showToast('Cart is empty', 'error');
    document.getElementById('split-count').value = Math.min(2, posState.cart.length);
    renderSplitItems();
    openModal('split-modal');
  }

  function renderSplitItems() {
    const count = parseInt(document.getElementById('split-count').value) || 2;
    const el = document.getElementById('split-items');
    el.innerHTML = posState.cart.map((item, idx) => {
      const currentGroup = item.splitGroup || 1;
      const group = Math.min(currentGroup, count);
      return `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);">
        <div style="flex:1;">
          <div style="font-weight:600;">${escapeHtml(item.name)}</div>
          <div style="font-size:12px; color:var(--ink-faint);">x${item.qty} — ${money(item.line_total)}</div>
        </div>
        <select data-idx="${idx}" onchange="updateSplitGroup(this)">
          ${Array.from({length: count}, (_, i) => `<option value="${i+1}" ${group === i+1 ? 'selected' : ''}>Split ${i+1}</option>`).join('')}
        </select>
      </div>`;
    }).join('');
    updateSplitTotals(count);
  }

  function updateSplitGroup(sel) {
    const idx = parseInt(sel.dataset.idx);
    posState.cart[idx].splitGroup = parseInt(sel.value);
    const count = parseInt(document.getElementById('split-count').value) || 2;
    updateSplitTotals(count);
  }

  function updateSplitTotals(count) {
    const totals = {};
    for (let i = 1; i <= count; i++) totals[i] = 0;
    posState.cart.forEach(item => {
      const g = item.splitGroup || 1;
      totals[g] = (totals[g] || 0) + item.line_total;
    });
    document.getElementById('split-totals').innerHTML = Object.entries(totals).map(([g, t]) =>
      `<div style="display:flex; justify-content:space-between;"><span>Split ${g}</span><span>${money(t)}</span></div>`
    ).join('');
  }

  function confirmSplit() {
    const count = parseInt(document.getElementById('split-count').value) || 2;
    posState.cart.forEach(item => {
      if (!item.splitGroup || item.splitGroup > count) item.splitGroup = 1;
    });
    closeModal('split-modal');
    posRenderCart();
  }

  // ========== HOLD / RESUME ORDERS ==========
  function getHeldOrdersKey() { return `thole:held:${membership.business_id}`; }

  function getHeldOrders() {
    try { return JSON.parse(localStorage.getItem(getHeldOrdersKey())) || []; } catch(e) { return []; }
  }

  function saveHeldOrders(orders) {
    localStorage.setItem(getHeldOrdersKey(), JSON.stringify(orders));
  }

  function updateHeldOrdersBar() {
    const held = getHeldOrders();
    const bar = document.getElementById('pos-held-bar');
    const count = document.getElementById('pos-held-count');
    if (!bar || !count) return;
    if (held.length > 0) {
      bar.style.display = 'flex';
      count.textContent = held.length;
    } else {
      bar.style.display = 'none';
    }
  }

  function posHoldOrder() {
    if (posState.cart.length === 0) return showToast('Cart is empty', 'error');
    const held = getHeldOrders();
    held.push({
      id: Date.now().toString(),
      items: JSON.parse(JSON.stringify(posState.cart)),
      tableId: posState.tableId,
      tableNumber: posState.tableNumber,
      customerId: posState.customerId,
      customerName: posState.customerName,
      createdAt: new Date().toISOString(),
    });
    saveHeldOrders(held);
    posReset();
    posRenderCart();
    updateHeldOrdersBar();
    showToast('Order held', 'success');
  }

  function showHeldOrders() {
    const held = getHeldOrders();
    const list = document.getElementById('held-orders-list');
    if (held.length === 0) {
      list.innerHTML = '<div style="padding:12px; color:var(--ink-faint);">No held orders.</div>';
    } else {
      list.innerHTML = held.map((o, idx) => {
        const itemCount = o.items.reduce((s, i) => s + i.qty, 0);
        const total = o.items.reduce((s, i) => s + i.line_total, 0);
        const time = new Date(o.createdAt).toLocaleTimeString();
        return `<div class="ledger-row" style="cursor:pointer;" onclick="posResumeOrder(${idx})">
          <div>
            <strong>${itemCount} item${itemCount === 1 ? '' : 's'}</strong> — ${money(total)}
            <br><span style="font-size:11px; color:var(--ink-faint);">${o.tableNumber ? `Table ${o.tableNumber}` : 'Takeout'} @ ${time}</span>
          </div>
          <div style="color:var(--accent); font-size:12px;">Resume ▸</div>
          <div><button class="btn-ghost" style="font-size:11px; padding:2px 8px; color:var(--danger);" onclick="event.stopPropagation(); deleteHeldOrder(${idx})">✕</button></div>
        </div>`;
      }).join('');
    }
    openModal('held-orders-modal');
  }

  function posResumeOrder(idx) {
    const held = getHeldOrders();
    const o = held[idx];
    if (!o) return showToast('Order not found', 'error');
    posState.cart = o.items || [];
    posState.tableId = o.tableId || null;
    posState.tableNumber = o.tableNumber || null;
    posState.customerId = o.customerId || null;
    posState.customerName = o.customerName || null;
    held.splice(idx, 1);
    saveHeldOrders(held);
    closeModal('held-orders-modal');
    posRenderCart();
    updateCustomerDisplay();
    updateHeldOrdersBar();
    showToast('Order resumed', 'success');
  }

  function deleteHeldOrder(idx) {
    const held = getHeldOrders();
    held.splice(idx, 1);
    saveHeldOrders(held);
    showHeldOrders();
    updateHeldOrdersBar();
  }

  // ========== POS BUTTON IN TOOLBAR ==========
  // Add POS button to products tab toolbar
  document.addEventListener('DOMContentLoaded', () => {
    const productsToolbar = document.querySelector('#tab-products .toolbar');
    if (productsToolbar) {
      const posBtn = document.createElement('button');
      posBtn.className = 'btn-small';
      posBtn.style.background = 'var(--accent)';
      posBtn.textContent = '🛒 Open POS';
      posBtn.onclick = posOpenTableMap;
      productsToolbar.appendChild(posBtn);
    }
  });

  async function deleteRecord(table, modalId) {
    if (!editingRecord || editingRecord.table !== table) return;
    if (membership.role === "staff") { showToast("Staff cannot delete records.", "error"); return; }
    if (!confirm("Delete this record? It can be restored later by an admin.")) return;
    const payload = table === "products" ? { is_active: false } : { status: "voided" };
    const { error } = await sb.from(table).update(payload).eq("id", editingRecord.id).eq("business_id", membership.business_id);
    if (error) return setError(modalId.replace("-modal", "-error"), error.message);
    logAudit(table === "products" ? "soft_delete" : "void", table, editingRecord.id, null, payload);
    closeModal(modalId);
    showToast("Record deleted");
    await loadEverything();
  }

  function setDefaultDateFilters() {
    ['sales', 'payments', 'expenses', 'purchases', 'movements'].forEach(prefix => {
      const input = document.getElementById(`${prefix}-date-filter`);
      const mode = document.getElementById(`${prefix}-filter-mode`);
      if (input) { input.value = ''; input.style.display = 'none'; }
      if (mode && !mode.value) mode.value = 'all';
    });
  }

  // ============================================================
  // BOOT
  // ============================================================
  function revealAuth() {
    document.getElementById("auth-spinner").classList.add("done");
    document.getElementById("auth-content").classList.add("ready");
  }

  async function boot() {
    try {
      // Restore kitchen sound preference
      try { kitchenSoundEnabled = localStorage.getItem('thole:kitchen-sound') !== '0'; } catch(_) {}

      // Restore sidebar state
      try {
        if (localStorage.getItem("thole:sidebar-collapsed") === "true") {
          const sidebar = document.getElementById("sidebar");
          if (sidebar) {
            sidebar.classList.add("collapsed");
            const icon = document.querySelector("#sidebar-toggle svg");
            if (icon) icon.innerHTML = '<polyline points="9 18 15 12 9 6"/>';
          }
        }
      } catch (_) {}

      bindAuthStateWatcher();
      await setLanguage(currentLang);
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { revealAuth(); showLogin(); return; }
      currentUser = session.user;
      await checkMembership();
    } catch(err) {
      console.error("boot error:", err);
      revealAuth();
      showLogin();
    }
  }

  const MEMBERSHIP_SELECT = "business_id, role, full_name, businesses(name, invite_code, settings, business_types(display_name, type_key, business_type_modules(module_key)))";

  async function fetchActiveMembership() {
    if (FEATURES.businessMembers) {
      const { data, error } = await sb
        .from("business_members")
        .select(MEMBERSHIP_SELECT)
        .eq("user_id", currentUser.id)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!error && data) return data;
      if (error) console.warn("business_members read failed, falling back to app_users:", error.message);
    }
    const { data, error } = await sb
      .from("app_users")
      .select(MEMBERSHIP_SELECT)
      .eq("user_id", currentUser.id)
      .maybeSingle();
    if (error) console.error("app_users membership read failed:", error.message);
    return (!error && data) ? data : null;
  }

  async function listTeamMembers() {
    if (FEATURES.businessMembers) {
      const { data, error } = await sb
        .from("business_members")
        .select("user_id, role, full_name")
        .eq("business_id", membership.business_id)
        .eq("status", "active")
        .order("created_at");
      // Fall back on error OR empty result — the table may not be backfilled yet.
      if (!error && data && data.length > 0) return data;
      if (error) console.warn("business_members team read failed, falling back to app_users:", error.message);
    }
    const { data } = await sb
      .from("app_users")
      .select("user_id, role, full_name")
      .eq("business_id", membership.business_id)
      .order("created_at");
    return data || [];
  }

  async function checkMembership() {
    try {
      const data = await fetchActiveMembership();
      if (!data) {
        hide("auth-screen"); hide("app-screen"); show("onboarding-screen");
        return;
      }
      membership = data;
      const moduleRows = data.businesses?.business_types?.business_type_modules;
      businessModules = (FEATURES.typeModules && Array.isArray(moduleRows) && moduleRows.length > 0)
        ? new Set(moduleRows.map((row) => row.module_key))
        : null;
      document.getElementById("biz-name").textContent = data.businesses.name;
      document.getElementById("biz-type").textContent = data.businesses.business_types?.display_name ?? "";
      const userName = data.full_name || currentUser.email;
      document.getElementById("user-name-display").textContent = userName;
      document.getElementById("user-role-display").textContent = data.role;
      document.getElementById("user-name-top").textContent = userName;
      document.getElementById("user-role-top").textContent = data.role;
      updateProfileAvatar(userName);
      applyRolePermissions(data.role);
      applyBusinessTypeVisibility(data.businesses.business_types?.type_key);
      await loadBranches();
      hide("auth-screen"); hide("onboarding-screen"); show("app-screen");
      setDefaultDateFilters();
      logUsage("session_start", "dashboard");
      switchTab(document.querySelector('.nav-item.active')?.dataset.tab || 'dashboard');
      await loadEverything();
    } catch(err) {
      console.error("checkMembership error:", err);
      hide("auth-screen"); hide("app-screen"); show("onboarding-screen");
    }
  }

  function applyBusinessTypeVisibility(typeKey) {
    businessTypeKey = typeKey || null;
    for (const tab of Object.keys(TAB_MODULES)) {
      const hidden = !tabEnabled(tab);
      document.querySelectorAll(`.nav-item[data-tab="${tab}"]`).forEach((el) => el.classList.toggle("hidden", hidden));
      const panel = document.getElementById(`tab-${tab}`);
      if (panel) panel.classList.toggle("hidden", hidden);
    }
    // If the current tab just got hidden, land somewhere always available.
    const active = document.querySelector(".nav-item.active")?.dataset.tab;
    if (active && !tabEnabled(active)) switchTab("dashboard");
  }

  // ============================================================
  // BRANCH SELECTOR (Step 7)
  // ============================================================
  async function loadBranches() {
    try {
      const { data, error } = await sb.from("branches").select("id, name")
        .eq("business_id", membership.business_id).eq("is_active", true)
        .order("created_at");
      if (error) throw error;
      branches = data || [];
    } catch (e) {
      console.warn("branch load failed:", e?.message || e);
      branches = [];
    }
    // Restore persisted choice; validate it still exists. Default per plan:
    // first active branch once the business is genuinely multi-branch (>=2),
    // otherwise "All branches" so single-branch businesses see zero change.
    const stored = localStorage.getItem(branchStorageKey());
    selectedBranchId = branches.some((b) => b.id === stored)
      ? stored
      : (branches.length >= 2 ? branches[0].id : null);
    renderBranchSelector();
  }

  function renderBranchSelector() {
    const wrap = document.getElementById("branch-wrapper");
    const sel = document.getElementById("branch-select");
    if (!wrap || !sel) return;
    const canPick = branches.length >= 2 && ["owner", "manager"].includes(membership?.role);
    wrap.classList.toggle("show", canPick);
    if (!canPick) return; // selection state stays valid for read/write filtering
    sel.innerHTML = '<option value="">All branches</option>' +
      branches.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
    sel.value = selectedBranchId || "";
  }

  async function onBranchChange(val) {
    selectedBranchId = val || null;
    try { localStorage.setItem(branchStorageKey(), val); } catch (e) {}
    logUsage("branch_switched", null, "branch", selectedBranchId);
    showToast(selectedBranchId
      ? `Showing ${(branches.find((b) => b.id === selectedBranchId) || {}).name || "branch"}`
      : "Showing all branches");
    await loadEverything();
  }

  function hasModule(moduleKey) {
    return businessModules !== null && businessModules.has(moduleKey);
  }

  function businessUsesRawMaterials() {
    if (businessModules) return businessModules.has("inventory"); // inventory module = raw_materials + stock_movements
    return businessTypeKey === "restaurant" || businessTypeKey === "factory"; // legacy fallback when module list unavailable
  }

  function isProductionBusiness() {
    if (businessModules) return businessModules.has("production");
    return businessTypeKey === "factory";
  }

  // ============================================================
  // MODULE-BASED WORKSPACE GATING (Step 3 extension)
  // ============================================================
  // Tabs absent from TAB_MODULES are universal — every business type sees
  // them. Binding a tab to a module_key hides its nav item + panel unless the
  // business's business_type_modules includes that module. When the module
  // list is unavailable (businessModules === null) LEGACY_TAB_TYPE_KEYS
  // reproduces the old type_key-based gating; a tab missing from both maps
  // stays visible (unknown business types regress to "show everything").
  // Add a line here to customize another tab for any business type, then seed
  // the module in database/business_type_modules_seed.sql.
  const TAB_MODULES = {
    kitchen: "kitchen",              // restaurant_tables, dine_in, KDS
    materials: "inventory",          // raw_materials, recipe_items
    "stock-movements": "inventory",  // stock_movements
    efficiency: "production",        // produce_batches, waste_log, labor_shifts
    // Business-growth gates — uncomment once business_type_modules is seeded
    // for every type (the seed file already assigns them):
    //   sales: "pos",                      // orders, order_items
    //   customers: "crm", suppliers: "crm",// customers, suppliers
    //   payments: "finance", expenses: "finance", reports: "finance",
    //   purchases: "procurement",          // purchase_orders
  };

  const LEGACY_TAB_TYPE_KEYS = {
    kitchen: ["restaurant"],
    materials: ["restaurant", "factory"],
    "stock-movements": ["restaurant", "factory"],
    efficiency: ["restaurant", "factory"],
  };

  function tabModule(tab) {
    return TAB_MODULES[tab] || null;
  }

  function tabEnabled(tab) {
    const mod = tabModule(tab);
    if (!mod) return true; // universal tab
    if (businessModules !== null) return businessModules.has(mod);
    const legacy = LEGACY_TAB_TYPE_KEYS[tab];
    return legacy ? legacy.includes(businessTypeKey) : true;
  }

  // ============================================================
  // ROLE PERMISSIONS
  // ============================================================
  function applyRolePermissions(role) {
    const isStaff = role === "staff";
    document.querySelectorAll('.nav-item[data-tab="payments"], .nav-item[data-tab="expenses"], .nav-item[data-tab="purchases"], .nav-item[data-tab="reports"], .nav-item[data-tab="settings"]').forEach((el) => {
      el.classList.toggle("hidden", isStaff);
    });
    document.querySelectorAll('.nav-item[data-tab="team"]').forEach((el) => {
      el.classList.toggle("hidden", role !== "owner");
    });
    if (isStaff) {
      const activeTab = document.querySelector(".nav-item.active")?.dataset.tab;
      if (["payments","expenses","purchases","team","reports","settings"].includes(activeTab)) switchTab("dashboard");
    }
    const addProductBtn = document.querySelector('button[onclick="openModal(\'product-modal\')"]');
    if (addProductBtn) addProductBtn.classList.toggle("hidden", isStaff);
    const addMaterialBtn = document.querySelector('button[onclick="openAddMaterial()"]');
    if (addMaterialBtn) addMaterialBtn.classList.toggle("hidden", isStaff);
  }

  // ============================================================
  // ONBOARDING
  // ============================================================
  async function handleRedeem() {
    const errEl = "ob-error";
    clearError(errEl);
    const fullName = document.getElementById("ob-name").value.trim();
    const code = document.getElementById("ob-code").value.trim();
    if (!fullName || !code) return setError(errEl, "Please fill in both fields.");

    const { error } = await sb.rpc("redeem_invite_code", { p_invite_code: code, p_full_name: fullName });
    if (error) return setError(errEl, error.message);
    await checkMembership();
  }

  // ============================================================
  // AUTH
  // ============================================================
  function showSignup() {
    document.getElementById("auth-title").textContent = t("auth.join_business");
    document.getElementById("auth-sub").textContent = t("auth.join_subtitle");
    hide("login-form"); hide("newbiz-form"); show("signup-form"); clearError("auth-error");
  }
  function showNewBusiness() {
    document.getElementById("auth-title").textContent = t("auth.start_business");
    document.getElementById("auth-sub").textContent = t("auth.new_here");
    hide("login-form"); hide("signup-form"); show("newbiz-form"); clearError("auth-error");
  }
  function showLogin() {
    document.getElementById("auth-title").textContent = t("auth.sign_in");
    document.getElementById("auth-sub").textContent = t("auth.subtitle");
    hide("signup-form"); hide("newbiz-form"); show("login-form"); clearError("auth-error");
  }

  async function handleCreateBusiness() {
    clearError("auth-error");
    const btn = document.getElementById("nb-create-btn");
    const fullName = document.getElementById("nb-name").value.trim();
    const businessName = document.getElementById("nb-business-name").value.trim();
    const businessType = document.getElementById("nb-business-type").value;
    const email = document.getElementById("nb-email").value.trim();
    const password = document.getElementById("nb-password").value;
    if (!fullName || !businessName) return setError("auth-error", "Your name and a business name are required.");

    setBtnLoading(btn, true);
    try {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) return setError("auth-error", error.message);
      if (!data.session) return setError("auth-error", "Account created but not signed in — check if email confirmation is required.");

      currentUser = data.user;
      const { data: code, error: rpcErr } = await sb.rpc("create_business", {
        p_business_name: businessName, p_business_type_key: businessType, p_full_name: fullName,
      });
      if (rpcErr) return setError("auth-error", `Account created, but business setup failed: ${rpcErr.message}`);

      hide("auth-screen");
      document.getElementById("invite-code-display").textContent = code;
      show("invite-reveal-screen");
    } catch (err) {
      console.error("handleCreateBusiness error:", err);
      setError("auth-error", "Something went wrong creating your business. Please try again.");
    } finally {
      setBtnLoading(btn, false);
    }
  }

  async function finishInviteReveal() {
    hide("invite-reveal-screen");
    await checkMembership();
  }
  async function handleLogin() {
    clearError("auth-error");
    const btn = document.getElementById("login-submit-btn");
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    setBtnLoading(btn, true);
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return setError("auth-error", error.message);
      currentUser = data.user;
      await checkMembership();
    } catch (err) {
      console.error("handleLogin error:", err);
      setError("auth-error", "Something went wrong signing in. Please try again.");
    } finally {
      setBtnLoading(btn, false);
    }
  }
  async function handleSignup() {
    clearError("auth-error");
    const btn = document.getElementById("signup-submit-btn");
    const fullName = document.getElementById("signup-name").value.trim();
    const code = document.getElementById("signup-code").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    if (!fullName || !code) return setError("auth-error", "Full name and invite code are required.");

    setBtnLoading(btn, true);
    try {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) return setError("auth-error", error.message);
      if (!data.session) return setError("auth-error", "Account created but not signed in — check if email confirmation is required.");

      currentUser = data.user;
      const { error: rpcErr } = await sb.rpc("redeem_invite_code", { p_invite_code: code, p_full_name: fullName });
      if (rpcErr) {
        hide("auth-screen"); show("onboarding-screen");
        return setError("ob-error", rpcErr.message);
      }
      await checkMembership();
    } catch (err) {
      console.error("handleSignup error:", err);
      setError("auth-error", "Something went wrong redeeming your invite. Please try again.");
    } finally {
      setBtnLoading(btn, false);
    }
  }
  function toggleProfileMenu(e) {
    e.stopPropagation();
    const dd = document.getElementById("profile-dropdown");
    dd.classList.toggle("open");
  }
  document.addEventListener("click", function(e) {
    const dd = document.getElementById("profile-dropdown");
    if (dd && !dd.contains(e.target) && !document.getElementById("profile-avatar").contains(e.target)) {
      dd.classList.remove("open");
    }
  });
  function updateProfileAvatar(name) {
    const initial = (name || "—").trim().charAt(0).toUpperCase();
    document.getElementById("profile-initial").textContent = initial;
  }
  function updateThemeIcon() {
    const icon = document.getElementById("theme-icon");
    if (icon) icon.textContent = document.documentElement.classList.contains('theme-dark') ? '☀️' : '🌙';
  }
  function confirmSignOut() {
    if (!confirm("Are you sure you want to sign out?")) return;
    handleLogout();
  }

  async function handleLogout() {
    teardownRealtime();
    await sb.auth.signOut();
    resetToAuthScreen();
  }

  function resetToAuthScreen() {
    currentUser = null; membership = null;
    hide("app-screen"); hide("onboarding-screen");
    // Reset auth screen spinner for next login
    document.getElementById("auth-spinner").classList.remove("done");
    document.getElementById("auth-content").classList.remove("ready");
    show("auth-screen");
    // Briefly show spinner, then reveal form
    setTimeout(() => revealAuth(), 400);
    showLogin();
  }

  let authWatcherBound = false;
  function bindAuthStateWatcher() {
    if (authWatcherBound) return;
    authWatcherBound = true;
    sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        if (currentUser || membership) resetToAuthScreen();
      } else if (event === "TOKEN_REFRESH_FAILED") {
        sb.auth.signOut().catch(() => {});
      }
    });
  }

  // ============================================================
  // TABS
  // ============================================================
  function switchTab(tab) {
    if (!tabEnabled(tab)) tab = "dashboard"; // module-less tabs can't be navigated into
    document.querySelectorAll(".tab-panel").forEach((el) => el.classList.add("hidden"));
    const section = document.getElementById(`tab-${tab}`);
    section.classList.remove("hidden");
    section.classList.add("is-entering");
    setTimeout(() => section.classList.remove("is-entering"), 260);
    document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
    updateTopbar(tab);
    logUsage("page_view", tab);
    if (tab === "efficiency") { renderEfficiency(); loadWaste(); loadShifts(); loadProduceBatches(); }
    if (tab === "suppliers") loadSuppliers();
    if (tab === "stock-movements") loadMovements();
    if (tab === "kitchen") { loadKitchenOrders(); setupKitchenRealtime(); }
    if (tab === "settings") loadSettings();
  }

  function bindPullToRefresh() {
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      if (panel.dataset.pullBound === '1') return;
      panel.dataset.pullBound = '1';

      let startY = 0;
      let currentY = 0;
      let dragging = false;
      let triggered = false;
      const indicator = document.getElementById('pull-refresh-indicator');

      const resetIndicator = () => {
        if (!indicator) return;
        indicator.classList.remove('show', 'active');
        indicator.querySelector('.label').textContent = t('topbar.pull_to_sync');
        indicator.style.transform = 'translate(-50%, -120%)';
      };

      const updateIndicator = (distance) => {
        if (!indicator) return;
        const eased = Math.min(distance * 0.6, 92);
        indicator.classList.toggle('show', eased > 4);
        indicator.classList.toggle('active', eased >= 84);
        indicator.querySelector('.label').textContent = eased >= 84 ? t('topbar.release_to_sync') : t('topbar.pull_to_sync');
        indicator.style.transform = `translate(-50%, ${Math.min(eased * 0.4, 28)}px)`;
      };

      const refreshActiveView = async () => {
        if (!indicator) return;
        indicator.querySelector('.label').textContent = t('topbar.syncing');
        indicator.classList.add('active');
        indicator.style.transform = 'translate(-50%, 0)';
        try {
          await loadEverything();
          const activeTab = document.querySelector('.nav-item.active')?.dataset.tab || 'dashboard';
          updateTopbar(activeTab);
        } catch (err) {
          console.error('Pull refresh failed', err);
        } finally {
          resetIndicator();
        }
      };

      panel.addEventListener('touchstart', (e) => {
        if (panel.scrollTop > 0 || panel.classList.contains('hidden') || e.touches.length !== 1) return;
        startY = e.touches[0].clientY;
        currentY = startY;
        dragging = true;
        triggered = false;
      }, { passive: true });

      panel.addEventListener('touchmove', (e) => {
        if (!dragging || panel.scrollTop > 0 || panel.classList.contains('hidden') || e.touches.length !== 1) return;
        currentY = e.touches[0].clientY;
        const distance = currentY - startY;
        if (distance > 0) {
          e.preventDefault();
          updateIndicator(distance);
        }
      }, { passive: false });

      panel.addEventListener('touchend', () => {
        if (!dragging) return;
        dragging = false;
        const distance = currentY - startY;
        if (distance >= 84 && !triggered) {
          triggered = true;
          refreshActiveView();
        } else {
          resetIndicator();
        }
      });
    });
  }

  function updateTopbar(tab) {
    const section = document.getElementById(`tab-${tab}`);
    const header = section?.querySelector('.page-header');
    if (!header) return;
    const title = header.querySelector('h2')?.textContent ?? '';
    const sub = header.querySelector('p')?.textContent ?? '';
    const titleEl = document.getElementById('page-title');
    const subEl = document.getElementById('page-sub');
    titleEl.classList.add("fading");
    subEl.classList.add("fading");
    setTimeout(() => {
      titleEl.textContent = title;
      subEl.textContent = sub;
      titleEl.classList.remove("fading");
      subEl.classList.remove("fading");
    }, 150);
  }

  function toggleSidebar() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    sidebar.classList.toggle("collapsed");
    const icon = document.querySelector("#sidebar-toggle svg");
    if (icon) {
      const collapsed = sidebar.classList.contains("collapsed");
      icon.innerHTML = collapsed
        ? '<polyline points="9 18 15 12 9 6"/>'
        : '<polyline points="15 18 9 12 15 6"/>';
    }
    try { localStorage.setItem("thole:sidebar-collapsed", sidebar.classList.contains("collapsed")); } catch (_) {}
  }

  function toggleMoreMenu() {
    document.getElementById("mobile-more-panel").classList.toggle("open");
    document.getElementById("mobile-more-backdrop").classList.toggle("open");
  }

  // ============================================================
  // LOAD EVERYTHING
  // ============================================================
  async function loadEverything() {
    try {
      const jobs = [loadProducts(), loadCustomers(), loadSales(), loadPayments(), loadExpenses(), loadPurchases(), loadSuppliers()];
      if (tabEnabled("materials")) jobs.push(loadMaterials()); // skip raw_materials for types without the inventory module
      await Promise.all(jobs);
      if (membership.role === "owner") await loadTeam();
      if (membership.role === "owner" || membership.role === "manager") await loadReports();
      if (tabEnabled("efficiency")) await Promise.all([loadWaste(), loadShifts(), loadProduceBatches()]); // waste_log/labor_shifts/produce_batches
      renderDashboard();
      setupRealtimeSubscriptions();
      loadSettings();
    } catch(err) {
      console.error("loadEverything error:", err);
      renderDashboard();
    }
  }

  let realtimeChannel = null;
  let kitchenBadgeChannel = null;
  function teardownRealtime() {
    if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
    if (kitchenChannel) { sb.removeChannel(kitchenChannel); kitchenChannel = null; }
    if (kitchenBadgeChannel) { sb.removeChannel(kitchenBadgeChannel); kitchenBadgeChannel = null; }
  }
  function setupRealtimeSubscriptions() {
    if (realtimeChannel) { sb.removeChannel(realtimeChannel); }
    realtimeChannel = sb.channel("business-realtime");
    const tables = ["products", "orders", "order_items", "customers", "payments", "expenses", "purchase_orders"];
    if (tabEnabled("materials")) tables.push("raw_materials", "stock_movements");
    if (tabEnabled("efficiency")) tables.push("waste_log", "labor_shifts", "produce_batches");
    tables.forEach((table) => {
      realtimeChannel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
        handleRealtimeEvent(table);
      });
    });
    realtimeChannel.subscribe();
    setupKitchenBadgeRealtime();
  }

  // Live count of active kitchen orders (pending/preparing/ready) shown as a
  // badge on the Kitchen nav item. A dedicated channel keeps it updated for
  // every logged-in user the instant an order changes, regardless of the tab.
  function setupKitchenBadgeRealtime() {
    if (kitchenBadgeChannel) { sb.removeChannel(kitchenBadgeChannel); kitchenBadgeChannel = null; }
    kitchenBadgeChannel = sb.channel("kitchen-nav-badge");
    kitchenBadgeChannel.on("postgres_changes", { event: "*", schema: "public", table: "orders" }, (payload) => {
      refreshKitchenBadge();
    });
    kitchenBadgeChannel.subscribe();
    refreshKitchenBadge();
  }

  async function refreshKitchenBadge() {
    const badgeEl = document.getElementById('kitchen-nav-badge');
    if (!badgeEl) return;
    try {
      let q = sb.from('orders').select('id, status').eq('business_id', membership.business_id).in('status', ['pending', 'preparing', 'ready']);
      q = applyBranchFilter(q, 'orders');
      const { data, error } = await q;
      if (error) return;
      const active = data || [];
      const pending = active.filter(o => o.status === 'pending').length;
      const ready = active.filter(o => o.status === 'ready').length;
      const total = active.length;
      if (total > 0) {
        badgeEl.style.display = 'inline-flex';
        badgeEl.textContent = total;
        badgeEl.classList.toggle('has-ready', ready > 0 && pending === 0);
      } else {
        badgeEl.style.display = 'none';
      }
    } catch (e) { /* non-fatal */ }
  }

  const debounceTimers = {};
  function handleRealtimeEvent(table) {
    if (debounceTimers[table]) return;
    debounceTimers[table] = setTimeout(() => { delete debounceTimers[table]; }, 1000);
    const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
    if (table === "products" || table === "order_items") { loadProducts(); }
    if (table === "orders" && (activeTab === "sales" || activeTab === "dashboard")) { loadSales(); renderDashboard(); }
    if (table === "customers") { loadCustomers(); }
    if (table === "payments") { loadPayments(); }
    if (table === "expenses") { loadExpenses(); }
    if (table === "purchase_orders") { loadPurchases(); }
    if (table === "raw_materials") { loadMaterials(); if (activeTab === "kitchen") renderKitchenStock(); }
    if (table === "orders" && activeTab === "kitchen") { loadKitchenOrders(); }
    if (table === "order_items" && activeTab === "kitchen") { loadKitchenOrders(); }
    if (table === "waste_log" && activeTab === "efficiency") { loadWaste(); renderEfficiency(); }
    if (table === "labor_shifts" && activeTab === "efficiency") { loadShifts(); renderEfficiency(); }
    if (table === "produce_batches" && activeTab === "efficiency") { loadProduceBatches(); renderEfficiency(); }
  }

  // Step 6: one-round-trip aggregates for dashboard + efficiency tab.
  // Returns null when the flag is off or the RPC is missing/fails — callers fall back
  // to the legacy full-history fetches (safety rule: keep legacy flows alive).
  async function fetchDashboardSummary() {
    if (!FEATURES.serverAggregation) return null;
    try {
      const { data, error } = await sb.rpc('dashboard_summary', {
        p_business_id: membership.business_id,
        p_branch_id: selectedBranchId || null,
      });
      if (error) throw error;
      return data;
    } catch (e) {
      console.warn('dashboard_summary RPC failed, using legacy aggregation:', e?.message || e);
      return null;
    }
  }

  async function renderDashboard() {
    const bid = membership.business_id;
    try {
    const summary = await fetchDashboardSummary();
    let revenue, todaySales, todayOrders, salesCount, expenseTotal, purchaseTotal, wasteCost;
    if (summary) {
      revenue = Number(summary.revenue || 0);
      todaySales = Number(summary.today_sales || 0);
      todayOrders = Number(summary.today_orders || 0);
      salesCount = Number(summary.sales_count || 0);
      expenseTotal = Number(summary.expense_total || 0);
      purchaseTotal = Number(summary.purchase_total || 0);
      wasteCost = Number(summary.waste_cost || 0);
    } else {
    const [{ data: allSales }, { data: allExpenses }, { data: allPurchases }] = await Promise.all([
      applyBranchFilter(sb.from('orders').select('total_amount, status, created_at').eq('business_id', bid), 'orders'),
      applyBranchFilter(sb.from('expenses').select('amount').eq('business_id', bid), 'expenses'),
      sb.from('purchase_orders').select('total_amount, status').eq('business_id', bid),
    ]);
    revenue = (allSales || []).filter(o => o.status === 'completed').reduce((s, o) => s + Number(o.total_amount || 0), 0);
    const todayStr = new Date().toISOString().slice(0, 10);
    todaySales = (allSales || []).filter(o => o.status === 'completed' && o.created_at && o.created_at.slice(0, 10) === todayStr).reduce((s, o) => s + Number(o.total_amount || 0), 0);
    todayOrders = (allSales || []).filter(o => o.status === 'completed' && o.created_at && o.created_at.slice(0, 10) === todayStr).length;
    expenseTotal = (allExpenses || []).reduce((s, e) => s + Number(e.amount || 0), 0);
    purchaseTotal = (allPurchases || []).filter(p => p.status !== 'voided').reduce((s, p) => s + Number(p.total_amount || 0), 0);

    wasteCost = 0;
    try {
      const { data: waste } = await sb.from('waste_log').select('quantity, unit_cost').eq('business_id', bid);
      wasteCost = (waste || []).reduce((s, w) => s + Number(w.quantity || 0) * Number(w.unit_cost || 0), 0);
    } catch(e) {}
    salesCount = allSales ? allSales.filter(o => o.status === 'completed').length : 0;
    }

    const totalCosts = expenseTotal + purchaseTotal + wasteCost;
    const materialValue = cache.materials.reduce((s, m) => s + (Number(m.stock_qty) * Number(m.cost_per_unit || 0)), 0);

    const lowStockProducts = cache.products.filter(
      (p) => p.product_type !== 'recipe' && p.stock_qty !== null && p.low_stock_threshold !== null && Number(p.stock_qty) <= Number(p.low_stock_threshold)
    );
    const lowStockMaterials = cache.materials.filter(
      (m) => m.stock_qty !== null && m.low_stock_threshold !== null && Number(m.stock_qty) <= Number(m.low_stock_threshold)
    );
    const constrainedRecipes = cache.products
      .filter(p => p.product_type === 'recipe')
      .map(p => {
        const avail = getDerivedAvailability(p.id);
        return { ...p, derivedAvail: avail };
      })
      .filter(p => p.derivedAvail <= 0);
    const lowStockCount = lowStockProducts.length + lowStockMaterials.length + constrainedRecipes.length;
    const worstStockItems = [...lowStockProducts.map(p => ({ name: p.name, qty: Number(p.stock_qty) })), ...lowStockMaterials.map(m => ({ name: m.name + ' (material)', qty: Number(m.stock_qty) }))];
    worstStockItems.sort((a, b) => a.qty - b.qty);
    const worstStock = worstStockItems.length > 0 ? worstStockItems[0].name : "All items healthy";

    // Top product by stock count (simplest available metric)
    const topProduct = cache.products.length > 0
      ? cache.products.reduce((best, p) => Number(p.stock_qty || 0) > Number(best.stock_qty || 0) ? p : best, cache.products[0])
      : null;

    // Most popular category
    const catCounts = {};
    cache.products.forEach(p => { if (p.category) catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
    const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0];

    // Metrics
    try {
    const mLowstock = document.getElementById("m-lowstock"); if(mLowstock){mLowstock.textContent = lowStockCount; mLowstock.classList.remove("skeleton");}
    const mSales = document.getElementById("m-sales"); if(mSales){mSales.textContent = salesCount; mSales.classList.remove("skeleton");}
    animateValue(document.getElementById("m-revenue"), revenue);
    const mTodaySales = document.getElementById("m-today-sales"); if(mTodaySales){mTodaySales.textContent = money(todaySales); mTodaySales.classList.remove("skeleton");}
    const mTodayNote = document.getElementById("m-today-note"); if(mTodayNote) mTodayNote.textContent = todayOrders ? `${todayOrders} order${todayOrders === 1 ? '' : 's'} today` : 'No orders yet today';
    const mTotalCosts = document.getElementById("m-total-costs"); if(mTotalCosts){mTotalCosts.textContent = money(totalCosts); mTotalCosts.classList.remove("skeleton");}
    animateValue(document.getElementById("m-profit"), revenue - totalCosts);
    } catch(e) { console.error('Dashboard metric error', e); }

    // Action needed
    try {
    const alerts = [];
    if (lowStockCount > 0) alerts.push(`${lowStockCount} low-stock item${lowStockCount === 1 ? '' : 's'} need attention.`);
    if (lowStockMaterials.length > 0 && businessUsesRawMaterials()) alerts.push(`${lowStockMaterials.length} raw material${lowStockMaterials.length === 1 ? '' : 's'} running low.`);
    if (constrainedRecipes.length > 0) alerts.push(`${constrainedRecipes.length} recipe product${constrainedRecipes.length === 1 ? '' : 's'} unavailable — ingredients out.`);
    if (wasteCost > 0) alerts.push(`${money(wasteCost)} in waste logged.`);
    if (revenue > 0 && totalCosts > revenue) alerts.push("Costs exceed revenue — review spending.");
    if (purchaseTotal === 0 && cache.materials.length > 0) alerts.push("No purchase orders recorded — costs may be incomplete.");
    if (alerts.length === 0) alerts.push("All systems healthy. Keep up the good work!");
    document.getElementById("dashboard-top-priority").textContent = alerts.join(' ');
    } catch(e) { console.error('Dashboard alerts error', e); }

    // Cost breakdown
    try {
    document.getElementById("d-expenses").textContent = money(expenseTotal);
    document.getElementById("d-purchases").textContent = money(purchaseTotal);
    document.getElementById("d-waste").textContent = money(wasteCost);
    document.getElementById("d-material-value").textContent = money(materialValue);
    } catch(e) { console.error('Dashboard cost breakdown error', e); }

    // Efficiency
    try {
    const grossMargin = revenue > 0 ? (((revenue - purchaseTotal) / revenue) * 100).toFixed(1) + '%' : '—';
    const costPerOrder = salesCount > 0 ? money(totalCosts / salesCount) : '—';
    const profitMargin = revenue > 0 ? (((revenue - totalCosts) / revenue) * 100).toFixed(1) + '%' : '—';
    const wasteRate = revenue > 0 ? ((wasteCost / revenue) * 100).toFixed(1) + '%' : '—';
    document.getElementById("d-margin").textContent = grossMargin;
    document.getElementById("d-cost-per-order").textContent = costPerOrder;
    document.getElementById("d-profit-margin").textContent = profitMargin;
    document.getElementById("d-waste-rate").textContent = wasteRate;
    } catch(e) { console.error('Dashboard efficiency error', e); }

    // Snapshot
    try {
    document.getElementById("dashboard-low-stock-item").textContent = escapeHtml(worstStock);
    document.getElementById("d-top-product").textContent = topProduct ? escapeHtml(topProduct.name) : '—';
    document.getElementById("d-top-category").textContent = topCat ? escapeHtml(topCat[0]) + ' (' + topCat[1] + ')' : '—';
    } catch(e) { console.error('Dashboard snapshot error', e); }
    } catch(e) { console.error('Dashboard top-level error', e); }
  }

  // ============================================================
  // PRODUCTS
  // ============================================================
  async function loadProducts(append = false) {
    await pagedLoad('products', { table: 'products', orderBy: 'category', extraFilters: [['is_active', true]], append });
    const cats = [...new Set(cache.products.map((p) => p.category).filter(Boolean))];
    document.getElementById("cat-filter").innerHTML =
      `<option value="">All categories</option>` + cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    const tf = document.getElementById("inv-type-filter");
    if (tf) {
      const cur = tf.value;
      const isFactory = isProductionBusiness();
      tf.innerHTML = '<option value="">All</option><option value="resale">Resale</option><option value="recipe">Recipe</option>';
      if (isFactory) tf.innerHTML += '<option value="manufactured">Manufactured</option>';
      if ([...tf.options].some(o => o.value === cur)) tf.value = cur;
    }
    renderProducts();
  }

  function renderProducts() {
    const typeFilter = document.getElementById('inv-type-filter')?.value || '';
    const categoryFilter = document.getElementById("cat-filter").value;
    const search = (document.getElementById("product-search")?.value ?? "").trim().toLowerCase();

    let list = cache.products;
    if (typeFilter) list = list.filter(p => p.product_type === typeFilter);
    if (categoryFilter) list = list.filter(p => p.category === categoryFilter);
    if (search) list = list.filter(p => p.name.toLowerCase().includes(search));

    const el = document.getElementById("products-ledger");
    if (list.length === 0) { el.innerHTML = `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">📦</div>No products yet.<br><span style="font-size:12px;">Add your first product.</span></div>`; return; }

    el.innerHTML = `<div class="card-grid">` +
      list.map((p) => {
        const isRecipe = p.product_type === 'recipe';
        const isManufactured = p.product_type === 'manufactured';
        const isResale = p.product_type === 'resale';
        const typeBadge = isRecipe
          ? '<span style="font-size:9px; padding:1px 5px; border-radius:4px; background:var(--accent-soft); color:var(--accent); font-weight:600;">RECIPE</span>'
          : isManufactured
            ? '<span style="font-size:9px; padding:1px 5px; border-radius:4px; background:#8b5cf620; color:#8b5cf6; font-weight:600;">MANUFACTURED</span>'
            : '<span style="font-size:9px; padding:1px 5px; border-radius:4px; background:var(--sky-soft); color:var(--sky); font-weight:600;">RESALE</span>';
        let stockHtml;
        if (isRecipe) {
          const avail = getDerivedAvailability(p.id);
          const limitStr = p.stock_limit != null ? ` / ${p.stock_limit}` : '';
          const display = `${isFinite(avail) ? avail : '∞'}${limitStr}`;
          const cls = avail <= 0 ? 'out' : '';
          stockHtml = `<div class="card-stock ${cls}">${display}</div>`;
        } else {
          const qty = p.stock_qty !== null ? Number(p.stock_qty) : null;
          const threshold = p.low_stock_threshold !== null ? Number(p.low_stock_threshold) : null;
          if (qty === null || qty === 0) stockHtml = `<div class="card-stock out">Out of Stock</div>`;
          else if (threshold !== null && qty <= threshold) stockHtml = `<div class="card-stock low">${qty} ${escapeHtml(p.unit)} — Low</div>`;
          else stockHtml = `<div class="card-stock ok">${qty} ${escapeHtml(p.unit)}</div>`;
        }
        const actionBtn = isResale
          ? `<button class="card-action" onclick="event.stopPropagation(); openPurchaseModal()">Buy</button>`
          : isRecipe
            ? `<button class="card-action" onclick="event.stopPropagation(); openRecipeModal('${escapeAttr(p.id)}')">Recipe</button>`
            : `<button class="card-action" onclick="event.stopPropagation(); openProduceModal()">Make</button>`;
        return `<div class="item-card" onclick="openEditProduct('${escapeAttr(p.id)}')">
          <div class="card-name">${escapeHtml(p.name)} ${typeBadge}</div>
          ${p.category ? `<div class="card-meta">${escapeHtml(p.category)}</div>` : ''}
          ${stockHtml}
          <div class="card-bottom">
            <span class="card-price">${money(p.price)}</span>
            ${actionBtn}
          </div>
        </div>`;
      }).join("") +
      `</div>`;
  }

  function populateCategorySelect(selectId, currentVal) {
    const sel = document.getElementById(selectId);
    const cats = [...new Set(cache.products.map(p => p.category).filter(Boolean))].sort();
    const newInput = document.getElementById(selectId + '-new');
    if (newInput) newInput.classList.add('hidden');
    sel.innerHTML = `<option value="">None</option>` +
      cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('') +
      `<option value="__new__">+ New category</option>`;
    if (currentVal && cats.includes(currentVal)) sel.value = currentVal;
    else if (currentVal) { sel.value = '__new__'; if (newInput) { newInput.classList.remove('hidden'); newInput.value = currentVal; } }
    else sel.value = '';
  }

  function toggleProductTypeFields() {
    const type = document.getElementById("p-type").value;
    const isRecipe = type === "recipe";
    const isResale = type === "resale";
    document.getElementById("p-stock-row").style.display = isRecipe ? "none" : "";
    document.getElementById("p-threshold-row").style.display = isRecipe ? "none" : "";
    document.getElementById("p-limit-row").classList.toggle("hidden", !isRecipe);
  }

  function populateProductTypeOptions(selected) {
    const sel = document.getElementById("p-type");
    const isFactory = isProductionBusiness();
    sel.innerHTML =
      '<option value="resale" data-i18n="product_modal.resale">Buy & Sell</option>' +
      '<option value="recipe">Recipe</option>';
    if (isFactory) sel.innerHTML += '<option value="manufactured" data-i18n="product_modal.manufactured">Manufactured</option>';
    if (selected && [...sel.options].some(o => o.value === selected)) sel.value = selected;
    else sel.value = 'resale';
  }

  function openAddProduct() {
    editingRecord = null;
    document.getElementById("product-modal-title").textContent = "Add product";
    document.getElementById("product-submit-btn").textContent = "Add product";
    document.getElementById("product-delete-btn").classList.add("hidden");
    document.getElementById("product-duplicate-btn").classList.add("hidden");
    document.getElementById("p-name").value = "";
    populateCategorySelect('p-category', '');
    document.getElementById("p-price").value = "";
    document.getElementById("p-unit").innerHTML = '<option value="">Select unit</option>' + unitOptionsHtml('');
    document.getElementById("p-stock").value = "";
    document.getElementById("p-threshold").value = "";
    document.getElementById("p-stock-limit").value = "";
    document.getElementById("p-type-row").style.display = "";
    populateProductTypeOptions('resale');
    toggleProductTypeFields();
    openModal("product-modal");
  }

  function openEditProduct(productId) {
    const p = cache.products.find((x) => x.id === productId);
    if (!p) return;
    editingRecord = { table: "products", id: p.id };
    document.getElementById("product-modal-title").textContent = "Edit product";
    document.getElementById("product-submit-btn").textContent = "Save changes";
    document.getElementById("product-delete-btn").classList.remove("hidden");
    document.getElementById("product-duplicate-btn").classList.remove("hidden");
    document.getElementById("p-name").value = p.name;
    populateCategorySelect('p-category', p.category);
    document.getElementById("p-price").value = p.price;
    document.getElementById("p-unit").innerHTML = '<option value="">Select unit</option>' + unitOptionsHtml(p.unit);
    if (!document.getElementById("p-unit").value && p.unit) {
      document.getElementById("p-unit").innerHTML += `<option value="${escapeAttr(p.unit)}" selected>${escapeHtml(p.unit)} (custom)</option>`;
    }
    document.getElementById("p-stock").value = p.stock_qty ?? "";
    document.getElementById("p-threshold").value = p.low_stock_threshold ?? "";
    document.getElementById("p-type-row").style.display = "";
    populateProductTypeOptions(p.product_type || "resale");
    document.getElementById("p-stock-limit").value = p.stock_limit ?? "";
    toggleProductTypeFields();
    openModal("product-modal");
  }

  async function duplicateProduct() {
    if (!editingRecord) return;
    const p = cache.products.find((x) => x.id === editingRecord.id);
    if (!p) return;
    const { error } = await sb.from("products").insert({
      business_id: membership.business_id, name: `${p.name} (copy)`, category: p.category,
      price: p.price, unit: p.unit, stock_qty: p.product_type === 'recipe' ? 0 : (p.stock_qty || 0), low_stock_threshold: p.low_stock_threshold, product_type: p.product_type || 'resale', stock_limit: p.stock_limit || null,
    }).select().single();
    if (error) return setError("product-error", error.message);
    logAudit("create", "product", null, null, { name: `${p.name} (copy)`, duplicated_from: p.id });
    closeModal("product-modal");
    await loadProducts();
  }

  async function submitProduct() {
    clearError("product-error");
    const btn = document.getElementById("product-submit-btn");
    const name = document.getElementById("p-name").value.trim();
    const catVal = document.getElementById("p-category").value;
    const category = catVal === '__new__' ? (document.getElementById("p-category-new").value.trim() || null) : (catVal || null);
    const price = parseFloat(document.getElementById("p-price").value);
    const unit = document.getElementById("p-unit").value || "pcs";
    const stock = document.getElementById("p-stock").value === "" ? 0 : parseFloat(document.getElementById("p-stock").value);
    const threshold = document.getElementById("p-threshold").value === "" ? null : parseFloat(document.getElementById("p-threshold").value);
    const productType = document.getElementById("p-type").value || 'resale';
    const isRecipe = productType === 'recipe';
    const stockLimit = isRecipe ? (document.getElementById("p-stock-limit").value === "" ? null : parseFloat(document.getElementById("p-stock-limit").value)) : null;

    if (!name || isNaN(price)) return setError("product-error", "Name and price are required.");
    if (price < 0) return setError("product-error", "Price cannot be negative.");
    if (!isRecipe && stock < 0) return setError("product-error", "Stock cannot be negative.");
    if (threshold !== null && threshold < 0) return setError("product-error", "Threshold cannot be negative.");

    const payload = { name, category, price, unit, stock_qty: productType === 'recipe' ? 0 : stock, low_stock_threshold: isRecipe ? null : threshold, product_type: productType, stock_limit: stockLimit };
    setBtnLoading(btn, true);

    if (editingRecord) {
      const original = cache.products.find((p) => p.id === editingRecord.id);
      const { error } = await sb.from("products").update(payload).eq("id", editingRecord.id).eq("business_id", membership.business_id);
      setBtnLoading(btn, false);
      if (error) return setError("product-error", error.message);
      logAudit("update", "product", editingRecord.id,
        original ? { name: original.name, category: original.category, price: original.price, unit: original.unit, stock_qty: original.stock_qty, low_stock_threshold: original.low_stock_threshold, product_type: original.product_type } : null,
        payload);
    } else {
      const { error, data } = await sb.from("products").insert({ business_id: membership.business_id, ...payload }).select().single();
      setBtnLoading(btn, false);
      if (error) return setError("product-error", error.message);
      logAudit("create", "product", data?.id || null, null, data || payload);
    }

    closeModal("product-modal");
    showToast(editingRecord ? "Product updated" : "Product added");
    await loadProducts();
    renderDashboard();
  }

  // ============================================================
  // LEDGER: generic List / Day / Month / Year grouping engine
  // ============================================================
  const ledgerState = {
    sales: { group: 'list', expanded: null },
    payments: { group: 'list', expanded: null },
    expenses: { group: 'list', expanded: null },
    purchases: { group: 'list', expanded: null },
  };
  let ledgerTabConfig = {};
  const ledgerLoaders = { sales: loadSales, payments: loadPayments, expenses: loadExpenses, purchases: loadPurchases };

  function setLedgerGroup(key, group) {
    const st = ledgerState[key];
    if (st && st.group !== group) { st.group = group; st.expanded = null; }
    ledgerLoaders[key]();
  }
  function ledgerExpand(key, kind, periodKey) {
    const st = ledgerState[key];
    st.expanded = { kind, key: periodKey };
    ledgerLoaders[key]();
  }
  function ledgerGoBack(key) {
    ledgerState[key].expanded = null;
    ledgerLoaders[key]();
  }
  function periodKeyOf(kind, dateStr) {
    if (!dateStr) dateStr = '';
    if (kind === 'month') return dateStr.slice(0, 7);
    if (kind === 'year') return dateStr.slice(0, 4);
    return dateStr.slice(0, 10);
  }
  function periodLabel(kind, key) {
    if (kind === 'month') return new Date(key + '-01T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (kind === 'year') return key;
    return new Date(key + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function isCurrentPeriod(kind, key) {
    const now = new Date().toISOString();
    if (kind === 'month') return key === now.slice(0, 7);
    if (kind === 'year') return key === now.slice(0, 4);
    return key === now.slice(0, 10);
  }
  function periodBounds(kind, key, timeless) {
    let start, end;
    if (kind === 'day') { start = key; end = key; }
    else if (kind === 'month') {
      const [y, m] = key.split('-');
      const last = new Date(y, Number(m), 0).getDate();
      start = `${key}-01`; end = `${key}-${String(last).padStart(2, '0')}`;
    }
    else { start = `${key}-01-01`; end = `${key}-12-31`; }
    if (!timeless) { start += 'T00:00:00'; end += 'T23:59:59'; }
    return { start, end };
  }
  function headHtml(labels) {
    const cells = labels.map(([t, align]) => `<div${align === 'right' ? ' style="text-align:right"' : ''}>${t}</div>`).join("");
    return `<div class="ledger-head" style="grid-template-columns: 2fr 1fr 1fr 1fr 0.6fr;">${cells}</div>`;
  }
  async function fetchPeriodRows(cfg, kind, key) {
    const { start, end } = periodBounds(kind, key, cfg.timeless);
    let q = applyBranchFilter(sb.from(cfg.table).select(cfg.select || '*').eq('business_id', membership.business_id), cfg.table);
    if (cfg.extraFilters) cfg.extraFilters.forEach(f => { q = q.eq(f[0], f[1]); });
    if (cfg.excludeVoided) q = q.neq(cfg.voidStatusField || 'status', 'voided');
    q = q.gte(cfg.timeCol, start).lte(cfg.timeCol, end).order(cfg.orderBy, { ascending: false });
    const { data } = await q;
    return data || [];
  }
  async function fetchAllGrouped(key, cfg) {
    let q = applyBranchFilter(sb.from(cfg.table).select(cfg.select || '*').eq('business_id', membership.business_id), cfg.table);
    if (cfg.extraFilters) cfg.extraFilters.forEach(f => { q = q.eq(f[0], f[1]); });
    if (cfg.excludeVoided) q = q.neq(cfg.voidStatusField || 'status', 'voided');
    const start = document.getElementById(`${key}-start-date`)?.value;
    const end = document.getElementById(`${key}-end-date`)?.value;
    q = applyTimeRange(q, start, end, cfg.timeCol);
    q = q.order(cfg.orderBy, { ascending: false });
    const { data } = await q;
    return data || [];
  }
  async function renderLedger(key, append) {
    const cfg = ledgerTabConfig[key];
    const st = ledgerState[key];
    const el = document.getElementById(cfg.ledgerId);
    if (!el) return;
    const isExpanded = st.expanded && !append;
    if (isExpanded) {
      const data = await fetchPeriodRows(cfg, st.expanded.kind, st.expanded.key);
      const label = periodLabel(st.expanded.kind, st.expanded.key);
      const total = (data || []).reduce((s, r) => s + Number(r[cfg.moneyField] || 0), 0);
      const backBtn = `<div style="padding:8px 0 12px;"><button class="btn-ghost" onclick="ledgerGoBack('${key}')" style="font-size:13px;">← Back to summary</button> <span style="color:var(--ink-faint); font-size:13px; margin-left:8px;">${escapeHtml(label)} — ${money(total)}</span></div>`;
      if (!data || data.length === 0) { el.innerHTML = backBtn + `<div class="empty-state">No ${cfg.entityPlural} for this period.</div>`; return; }
      el.innerHTML = backBtn + cfg.headHtml() + data.map(cfg.rowRender).join("");
      return;
    }
    if (st.group !== 'list' && !append) {
      const cacheArr = await fetchAllGrouped(key, cfg);
      if (cacheArr.length === 0) { el.innerHTML = cfg.emptyHtml; return; }
      const groups = {};
      const filtered = cfg.excludeVoided ? cacheArr.filter(r => r[cfg.voidStatusField || 'status'] !== 'voided') : cacheArr;
      filtered.forEach(r => {
        const pk = periodKeyOf(st.group, r[cfg.dateField]);
        if (!groups[pk]) groups[pk] = { total: 0, count: 0 };
        groups[pk].total += Number(r[cfg.moneyField] || 0);
        groups[pk].count++;
      });
      const sorted = Object.entries(groups).sort((a, b) => String(b[0]).localeCompare(String(a[0])));
      const grandTotal = sorted.reduce((s, [, g]) => s + g.total, 0);
      const head = headHtml([['Date', ''], [cfg.entityPlural, ''], ['Total', 'right'], ['', 'right'], ['', 'right']]);
      const rows = sorted.map(([pk, g]) => {
        const isNow = isCurrentPeriod(st.group, pk);
        const tag = st.group === 'day' ? 'CURRENT' : 'THIS ' + st.group.toUpperCase();
        return `<div class="ledger-row" style="grid-template-columns: 2fr 1fr 1fr 1fr 0.6fr; cursor:pointer; ${isNow ? 'background:var(--accent-soft);' : ''}" onclick="ledgerExpand('${key}','${st.group}','${pk}')">
          <div style="font-weight:600;">${periodLabel(st.group, pk)}${isNow ? ` <span style="font-size:10px; padding:2px 6px; border-radius:999px; background:var(--accent); color:#fff;">${tag}</span>` : ''}</div>
          <div>${g.count} ${g.count === 1 ? cfg.entity : cfg.entityPlural}</div>
          <div class="num" style="text-align:right; font-weight:600;">${money(g.total)}</div>
          <div style="text-align:right; color:var(--accent); font-size:12px;">Expand ▸</div>
          <div></div>
        </div>`;
      }).join("");
      const unit = st.group === 'year' ? 'year' : st.group + 's';
      const totalBar = `<div style="padding:10px 0; text-align:right; font-size:13px; color:var(--ink-faint); border-top:1px solid var(--line); margin-top:4px;"><strong style="color:var(--ink);">${sorted.length} ${unit}</strong> — Total: <strong style="color:var(--accent);">${money(grandTotal)}</strong></div>`;
      el.innerHTML = head + rows + totalBar;
      return;
    }
    const flatHead = cfg.listLabels;
    await pagedLoad(key, { table: cfg.table, select: cfg.select || '*', orderBy: cfg.orderBy, ascending: false, timeFilterKey: key, timeCol: cfg.timeCol, extraFilters: cfg.extraFilters, append });
    if (cache[key].length === 0) { el.innerHTML = cfg.emptyHtml; return; }
    appendPaginated(el, headHtml(flatHead) + cache[key].map(cfg.rowRender).join(""), key, append);
  }

  // ---- SALES ----
  const salesCfg = {
    ledgerId: 'sales-ledger',
    table: 'orders',
    select: '*, customers(name), restaurant_tables!table_id(table_number, name)',
    timeCol: 'created_at',
    dateField: 'created_at',
    orderBy: 'created_at',
    moneyField: 'total_amount',
    entity: 'order',
    entityPlural: 'orders',
    excludeVoided: true,
    emptyHtml: `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">💰</div>No sales recorded yet.<br><span style="font-size:13px;">Tap "New Sale" to open the POS.</span></div>`,
    listLabels: [['Table / Customer', ''], ['Date', ''], ['Total', 'right'], ['', 'right'], ['', 'right']],
    headHtml: () => headHtml([['Table / Customer', ''], ['Date', ''], ['Total', 'right'], ['', 'right'], ['', 'right']]),
    rowRender: (o) => {
      const primaryLabel = o.restaurant_tables ? `T${o.restaurant_tables.table_number}${o.restaurant_tables.name ? ' — ' + escapeHtml(o.restaurant_tables.name) : ''}` : (o.customers ? escapeHtml(o.customers.name) : 'Walk-in');
      const nonCompleted = new Set(['pending', 'preparing', 'ready', 'served', 'voided']);
      const statusBadge = nonCompleted.has(o.status) ? ` <span class="sales-status ${o.status}">${o.status.toUpperCase()}</span>` : '';
      return `<div class="ledger-row" style="grid-template-columns: 2fr 1fr 1fr 1fr 0.6fr;">
        <div style="cursor:pointer; color:var(--accent);" onclick="showOrderPreview('${escapeAttr(o.id)}')">${primaryLabel}${statusBadge}</div>
        <div style="color:var(--ink-faint); font-size:12px;">${new Date(o.created_at).toLocaleDateString()}</div>
        <div class="num" style="text-align:right">${money(o.total_amount)}</div>
        <div style="text-align:right;">${o.status === 'served' ? `<span style="color:#16a34a; font-size:12px; text-decoration:underline; cursor:pointer; font-weight:600;" onclick="payTableOrder('${escapeAttr(o.id)}')">Pay</span>` : `<span style="color:var(--accent); font-size:12px; text-decoration:underline; cursor:pointer;" onclick="posShowReceipt('${escapeAttr(o.id)}')">Receipt</span>`}</div>
        <div style="text-align:right;"><span style="color:var(--danger); font-size:12px; text-decoration:underline; cursor:pointer;" onclick="voidSale('${escapeAttr(o.id)}')">Void</span></div>
      </div>`;
    },
  };
  ledgerTabConfig = Object.assign(ledgerTabConfig || {}, { sales: salesCfg });
  async function loadSales(append = false) { await renderLedger('sales', append); }

  function downloadCSV(filename, header, rows) {
    const csv = header + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click(); URL.revokeObjectURL(url);
    showToast('CSV downloaded');
  }

  function exportSalesCSV() {
    if (cache.sales.length === 0) return showToast('No sales to export', 'error');
    const header = 'Date,Customer,Total,Status,Payment\n';
    const rows = cache.sales.map(o => {
      const date = new Date(o.created_at).toLocaleDateString();
      const customer = o.customers ? o.customers.name : 'Walk-in';
      return `"${date}","${customer.replace(/"/g,'""')}",${o.total_amount || 0},${o.status || 'completed'},${o.payment_method || ''}`;
    });
    downloadCSV(`sales_${new Date().toISOString().slice(0,10)}.csv`, header, rows);
  }

  function exportCustomersCSV() {
    if (cache.customers.length === 0) return showToast('No customers to export', 'error');
    const header = 'Name,Phone,Email,Total Spent,Visits\n';
    const rows = cache.customers.map(c => `"${(c.name||'').replace(/"/g,'""')}","${c.phone||''}","${c.email||''}",${c.total_spent||0},${c.visit_count||0}`);
    downloadCSV(`customers_${new Date().toISOString().slice(0,10)}.csv`, header, rows);
  }

  async function exportReportsCSV() {
    const sales = (window._reportSales || []).filter(o => o.status !== 'voided');
    if (sales.length === 0) return showToast('No report data to export', 'error');

    const mode = document.getElementById("reports-filter-mode")?.value || "all";
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [];
    const section = (title) => lines.push(esc(title));
    const blank = () => lines.push("");

    // --- Fetch order items for top-product / top-category breakdowns ---
    const validOrderIds = sales.map(o => o.id);
    let orderItems = [];
    if (validOrderIds.length > 0) {
      const { data } = await sb.from("order_items").select("product_id, quantity, unit_price").in("order_id", validOrderIds);
      orderItems = data ?? [];
    }

    const totalRevenue = sales.reduce((s, o) => s + Number(o.total_amount || 0), 0);
    const orderCount = sales.length;
    const avgOrder = orderCount ? totalRevenue / orderCount : 0;
    const lowStockCount = cache.products.filter(p => p.product_type !== 'manufactured' && p.stock_qty !== null && p.low_stock_threshold !== null && Number(p.stock_qty) <= Number(p.low_stock_threshold)).length;

    const productAgg = {};
    const catRev = {};
    for (const it of orderItems) {
      const rev = Number(it.quantity) * Number(it.unit_price);
      productAgg[it.product_id] = (productAgg[it.product_id] || 0) + rev;
      const cat = cache.products.find(p => p.id === it.product_id)?.category || "Uncategorized";
      catRev[cat] = (catRev[cat] || 0) + rev;
    }
    const topProducts = Object.entries(productAgg)
      .map(([pid, rev]) => ({ name: cache.products.find(p => p.id === pid)?.name || "Deleted product", qty: orderItems.filter(i => i.product_id === pid).reduce((s, i) => s + Number(i.quantity), 0), rev }))
      .sort((a, b) => b.rev - a.rev);

    const payTotals = {};
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayTotals = [0, 0, 0, 0, 0, 0, 0];
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];
    const dateTotals = {};

    for (const o of sales) {
      const amt = Number(o.total_amount || 0);
      const method = o.payment_method || "Unknown";
      payTotals[method] = (payTotals[method] || 0) + amt;
      const d = new Date(o.created_at);
      dayTotals[d.getDay()] += amt;
      dayCounts[d.getDay()]++;
      const dk = d.toLocaleDateString();
      dateTotals[dk] = (dateTotals[dk] || 0) + amt;
    }

    const minDate = sales.reduce((m, o) => Math.min(m, new Date(o.created_at).getTime()), Infinity);
    const maxDate = sales.reduce((m, o) => Math.max(m, new Date(o.created_at).getTime()), 0);
    const rangeLabel = mode === 'all' ? 'All Time' : `${new Date(minDate).toLocaleDateString()} - ${new Date(maxDate).toLocaleDateString()}`;

    section("Thole Solutions Report");
    lines.push(esc("Period"), esc(rangeLabel));
    blank();
    section("Summary");
    lines.push(esc("Metric"), esc("Value"));
    lines.push(esc("Total Revenue"), esc(money(totalRevenue)));
    lines.push(esc("Orders"), esc(orderCount));
    lines.push(esc("Avg Order Value"), esc(money(avgOrder)));
    lines.push(esc("Top Seller"), esc(topProducts[0]?.name || "—"));
    lines.push(esc("Low Stock Items"), esc(lowStockCount));
    blank();

    section("Revenue Trend");
    lines.push(esc("Date"), esc("Revenue"));
    Object.entries(dateTotals).sort((a, b) => new Date(a[0]) - new Date(b[0])).forEach(([d, v]) => lines.push(esc(d), esc(v.toFixed(2))));
    blank();

    section("Top Selling Products");
    lines.push(esc("Product"), esc("Qty Sold"), esc("Revenue"));
    topProducts.forEach(p => lines.push(esc(p.name), esc(p.qty), esc(p.rev.toFixed(2))));
    blank();

    section("Top Categories");
    lines.push(esc("Category"), esc("Revenue"));
    Object.entries(catRev).sort((a, b) => b[1] - a[1]).forEach(([c, v]) => lines.push(esc(c), esc(v.toFixed(2))));
    blank();

    section("Sales by Payment Method");
    lines.push(esc("Method"), esc("Revenue"));
    Object.entries(payTotals).sort((a, b) => b[1] - a[1]).forEach(([m, v]) => lines.push(esc(m), esc(v.toFixed(2))));
    blank();

    section("Sales by Day of Week");
    lines.push(esc("Day"), esc("Orders"), esc("Revenue"));
    dayTotals.map((t, i) => ({ name: dayNames[i], count: dayCounts[i], total: t })).sort((a, b) => b.total - a.total).forEach(d => lines.push(esc(d.name), esc(d.count), esc(d.total.toFixed(2))));
    blank();

    lines.push(esc(`Total Revenue: ${money(totalRevenue)} · Orders: ${orderCount} · Avg: ${money(avgOrder)}`));

    downloadCSV(`report_${new Date().toISOString().slice(0, 10)}.csv`, "", lines.map(l => l + "\n").join(""));
  }

  function exportExpensesCSV() {
    if (cache.expenses.length === 0) return showToast('No expenses to export', 'error');
    const header = 'Date,Category,Description,Amount\n';
    const rows = cache.expenses.map(e => {
      return `"${new Date(e.created_at).toLocaleDateString()}","${(e.category||'').replace(/"/g,'""')}","${(e.description||'').replace(/"/g,'""')}",${e.amount||0}`;
    });
    downloadCSV(`expenses_${new Date().toISOString().slice(0,10)}.csv`, header, rows);
  }

  function exportPurchasesCSV() {
    if (cache.purchases.length === 0) return showToast('No purchases to export', 'error');
    const header = 'Date,Status,Total\n';
    const rows = cache.purchases.map(p => `"${new Date(p.created_at).toLocaleDateString()}","${p.status||''}",${p.total_amount||0}`);
    downloadCSV(`purchases_${new Date().toISOString().slice(0,10)}.csv`, header, rows);
  }

  function exportMaterialsCSV() {
    if (cache.materials.length === 0) return showToast('No materials to export', 'error');
    const header = 'Name,Unit,Cost/Unit,Stock,Low Threshold\n';
    const rows = cache.materials.map(m => `"${(m.name||'').replace(/"/g,'""')}","${m.unit||''}",${m.cost_per_unit||0},${m.stock_qty||0},${m.low_stock_threshold||''}`);
    downloadCSV(`materials_${new Date().toISOString().slice(0,10)}.csv`, header, rows);
  }

  async function voidSale(orderId) {
    if (!confirm("Void this sale? This can't be undone.")) return;
    if (membership.role === "staff") { showToast("Staff cannot void sales.", "error"); return; }

    // Only restore stock if the order was served or completed (stock was already deducted)
    const { data: order } = await sb.from("orders").select("status, table_id").eq("id", orderId).eq("business_id", membership.business_id).single();
    if (order && ['completed', 'served'].includes(order.status)) {
      const { data: items } = await sb.from("order_items").select("*, products(product_type)").eq("order_id", orderId);
      for (const item of items ?? []) {
        const prod = item.products;
        if (!prod) continue;
        if (prod.product_type === 'recipe') continue; // sale-count only, no stock to restore
        await adjustStock('products', item.product_id, Number(item.quantity), membership.business_id);
        await logStockMovement({ itemType: 'product', productId: item.product_id, qtyChange: Number(item.quantity), reason: 'sale void', refType: 'order', refId: orderId });
      }
      // Free table if it was still occupied
      if (order.table_id) {
        await sb.from('restaurant_tables').update({ status: 'available', current_order_id: null }).eq('id', order.table_id).eq('business_id', membership.business_id);
      }
    }
    await sb.from("orders").update({ status: "voided" }).eq("id", orderId).eq("business_id", membership.business_id);
    logAudit("void", "order", orderId, { status: order?.status ?? null }, { status: "voided" });

    await Promise.all([loadProducts(), loadSales()]);
    showToast("Sale voided");
    renderDashboard();
  }

  // ============================================================
  // CUSTOMERS
  // ============================================================
  async function loadCustomers(append = false) {
    await pagedLoad('customers', { table: 'customers', orderBy: 'name', append });
    const el = document.getElementById("customers-ledger");
    if (!el) return;
    if (cache.customers.length === 0) { el.innerHTML = `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">👥</div>No customers yet.<br><span style="font-size:12px;">Add customers to track who's buying from you.</span></div>`; return; }
    const head = `<div class="ledger-head" style="grid-template-columns: 2fr 1fr;"><div>Name</div><div>Phone</div></div>`;
    const rows = cache.customers.map((c) => `<div class="ledger-row" style="grid-template-columns: 2fr 1fr; cursor:pointer;" onclick="openEditCustomer('${escapeAttr(c.id)}')">
        <div>${escapeHtml(c.name)}</div><div style="color:var(--ink-faint)">${escapeHtml(c.phone ?? "—")}</div>
      </div>`).join("");
    appendPaginated(el, head + rows, "customers", append);
  }

  function openEditCustomer(customerId) {
    const c = cache.customers.find((x) => x.id === customerId);
    if (!c) return;
    editingRecord = { table: "customers", id: c.id };
    document.getElementById("customer-modal-title").textContent = "Edit customer";
    document.getElementById("customer-submit-btn").textContent = "Save changes";
    document.getElementById("customer-delete-btn").classList.remove("hidden");
    document.getElementById("c-name").value = c.name ?? "";
    document.getElementById("c-phone").value = c.phone ?? "";
    openModal("customer-modal");
  }

  async function submitCustomer() {
    clearError("customer-error");
    const btn = document.getElementById("customer-submit-btn");
    const name = document.getElementById("c-name").value.trim();
    const phone = document.getElementById("c-phone").value.trim() || null;
    if (!name) return setError("customer-error", "Name is required.");

    const payload = { name, phone };
    setBtnLoading(btn, true);
    const { error } = editingRecord
      ? await sb.from("customers").update(payload).eq("id", editingRecord.id)
      : await sb.from("customers").insert(stampBranch({ business_id: membership.business_id, ...payload }));
    setBtnLoading(btn, false);

    if (error) return setError("customer-error", error.message);
    closeModal("customer-modal");
    showToast(editingRecord ? "Customer updated" : "Customer added");
    await loadCustomers();
  }

  // ---- PAYMENTS ----
  const paymentsCfg = {
    ledgerId: 'payments-ledger',
    table: 'payments',
    select: '*, customers(name)',
    timeCol: 'created_at',
    dateField: 'created_at',
    orderBy: 'created_at',
    moneyField: 'amount',
    entity: 'payment',
    entityPlural: 'payments',
    extraFilters: [['direction', 'in']],
    emptyHtml: `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">💳</div>No payments recorded yet.<br><span style="font-size:13px;">Payments from customers will appear here.</span></div>`,
    listLabels: [['Customer', ''], ['Method', ''], ['Amount', 'right'], ['', ''], ['', '']],
    headHtml: () => headHtml([['Customer', ''], ['Method', ''], ['Amount', 'right'], ['', ''], ['', '']]),
    rowRender: (p) => `<div class="ledger-row" style="grid-template-columns: 2fr 1fr 1fr 1fr 0.6fr; cursor:pointer;" onclick="openEditPayment('${escapeAttr(p.id)}')">
        <div>${p.customers ? escapeHtml(p.customers.name) : "—"}</div>
        <div style="color:var(--ink-faint); font-size:12px; text-transform:capitalize;">${escapeHtml(p.method.replace("_", " "))}</div>
        <div class="num" style="text-align:right">${money(p.amount)}</div>
        <div></div><div></div>
      </div>`,
  };
  ledgerTabConfig = Object.assign(ledgerTabConfig || {}, { payments: paymentsCfg });
  async function loadPayments(append = false) { await renderLedger('payments', append); }

  function openEditPayment(paymentId) {
    const p = cache.payments.find((x) => x.id === paymentId);
    if (!p) return;
    editingRecord = { table: "payments", id: p.id };
    document.getElementById("payment-crud-modal-title").textContent = "Edit payment";
    document.getElementById("payment-submit-btn").textContent = "Save changes";
    document.getElementById("payment-delete-btn").classList.remove("hidden");
    openModal("payment-crud-modal"); 
    document.getElementById("pay-customer").value = p.customer_id;
    document.getElementById("pay-amount").value = p.amount;
    document.getElementById("pay-crud-method").value = p.method;
  }

  async function submitPayment() {
    clearError("payment-crud-error");
    const btn = document.getElementById("payment-submit-btn");
    const customerId = document.getElementById("pay-customer").value;
    const amount = parseFloat(document.getElementById("pay-amount").value);
    const method = document.getElementById("pay-crud-method").value;
    if (!customerId || isNaN(amount) || amount <= 0) return setError("payment-crud-error", "Select a customer and a valid amount.");

    const payload = { customer_id: customerId, amount, method };
    setBtnLoading(btn, true);
    const beforeRecord = editingRecord ? cache.payments.find((p) => p.id === editingRecord.id) : null;
    const { error, data } = editingRecord
      ? await sb.from("payments").update(payload).eq("id", editingRecord.id).select().single()
      : await sb.from("payments").insert(stampBranch({ business_id: membership.business_id, direction: "in", party_type: "customer", created_by: currentUser.id, ...payload })).select().single();
    setBtnLoading(btn, false);

    if (error) return setError("payment-crud-error", error.message);
    logAudit(editingRecord ? "update" : "create", "payment", data?.id || null,
      beforeRecord ? { customer_id: beforeRecord.customer_id, amount: beforeRecord.amount, method: beforeRecord.method } : null,
      payload);
    closeModal("payment-crud-modal");
    showToast(editingRecord ? "Payment updated" : "Payment recorded");
    await loadPayments();
  }
  const origOpenModal = openModal;
  window.openModal = function (id) {
    if (id === "payment-crud-modal") {
      document.getElementById("pay-customer").innerHTML = cache.customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    }
    origOpenModal(id);
  };

  // ---- EXPENSES ----
  const expensesCfg = {
    ledgerId: 'expenses-ledger',
    table: 'expenses',
    select: '*',
    timeCol: 'expense_date',
    dateField: 'expense_date',
    orderBy: 'expense_date',
    moneyField: 'amount',
    entity: 'expense',
    entityPlural: 'expenses',
    timeless: true,
    emptyHtml: `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">💸</div>No expenses recorded yet.<br><span style="font-size:13px;">Track rent, wages, utilities, and more.</span></div>`,
    listLabels: [['Category', ''], ['Description', ''], ['Amount', 'right'], ['', ''], ['', '']],
    headHtml: () => headHtml([['Category', ''], ['Description', ''], ['Amount', 'right'], ['', ''], ['', '']]),
    rowRender: (e) => `<div class="ledger-row" style="grid-template-columns: 1fr 2fr 1fr 1fr 0.6fr; cursor:pointer;" onclick="openEditExpense('${escapeAttr(e.id)}')">
        <div><span class="cat-badge" style="background:var(--amber-soft); color:var(--amber);">${escapeHtml(e.category)}</span></div>
        <div style="color:var(--ink-soft); font-size:13px;">${escapeHtml(e.description ?? "—")}</div>
        <div class="num" style="text-align:right">${money(e.amount)}</div>
        <div></div><div></div>
      </div>`,
  };
  ledgerTabConfig = Object.assign(ledgerTabConfig || {}, { expenses: expensesCfg });
  async function loadExpenses(append = false) { await renderLedger('expenses', append); }

  function openEditExpense(expenseId) {
    const e = cache.expenses.find((x) => x.id === expenseId);
    if (!e) return;
    editingRecord = { table: "expenses", id: e.id };
    document.getElementById("expense-modal-title").textContent = "Edit expense";
    document.getElementById("expense-submit-btn").textContent = "Save changes";
    document.getElementById("expense-delete-btn").classList.remove("hidden");
    document.getElementById("e-category").value = e.category;
    document.getElementById("e-description").value = e.description ?? "";
    document.getElementById("e-amount").value = e.amount;
    document.getElementById("e-date").value = e.expense_date;
    openModal("expense-modal");
  }

  async function submitExpense() {
    clearError("expense-error");
    const btn = document.getElementById("expense-submit-btn");
    const category = document.getElementById("e-category").value;
    const description = document.getElementById("e-description").value.trim() || null;
    const amount = parseFloat(document.getElementById("e-amount").value);
    const date = document.getElementById("e-date").value || new Date().toISOString().slice(0, 10);
    if (isNaN(amount) || amount <= 0) return setError("expense-error", "Enter a valid amount.");

    const payload = { category, description, amount, expense_date: date };
    setBtnLoading(btn, true);
    const { error } = editingRecord
      ? await sb.from("expenses").update(payload).eq("id", editingRecord.id)
      : await sb.from("expenses").insert(stampBranch({ business_id: membership.business_id, created_by: currentUser.id, ...payload }));
    setBtnLoading(btn, false);

    if (error) return setError("expense-error", error.message);
    closeModal("expense-modal");
    showToast(editingRecord ? "Expense updated" : "Expense added");
    await loadExpenses();
  }

  // ============================================================
  // PURCHASE ORDERS
  // ============================================================
  function openPurchaseModal() {
    document.getElementById("po-product").innerHTML = cache.products.filter(p => p.product_type !== 'manufactured').map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (stock: ${p.stock_qty ?? "—"})</option>`).join("");
    if (businessUsesRawMaterials()) {
      document.getElementById("po-type-toggle").style.display = "";
      document.getElementById("po-material").innerHTML = cache.materials.map((m) => `<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.unit)}, stock: ${m.stock_qty ?? "—"})</option>`).join("");
      togglePurchaseType();
    } else {
      document.getElementById("po-type-toggle").style.display = "none";
    }
    openModal("purchase-modal");
  }

  function togglePurchaseType() {
    const type = document.getElementById("po-type").value;
    const prodSel = document.getElementById("po-product");
    const matSel = document.getElementById("po-material");
    const label = document.getElementById("po-item-label");
    if (type === "material") {
      prodSel.classList.add("hidden");
      matSel.classList.remove("hidden");
      label.textContent = "Raw Material";
    } else {
      matSel.classList.add("hidden");
      prodSel.classList.remove("hidden");
      label.textContent = "Product";
    }
  }

  async function submitPurchase() {
    clearError("purchase-error");
    const btn = document.getElementById("purchase-submit-btn");
    const qty = parseFloat(document.getElementById("po-qty").value);
    const cost = parseFloat(document.getElementById("po-cost").value);

    const isMaterial = businessUsesRawMaterials() && document.getElementById("po-type").value === "material";
    const itemId = isMaterial ? document.getElementById("po-material").value : document.getElementById("po-product").value;
    const item = isMaterial
      ? cache.materials.find((m) => m.id === itemId)
      : cache.products.find((p) => p.id === itemId);

    if (!item || isNaN(qty) || qty <= 0 || isNaN(cost)) return setError("purchase-error", `Check the ${isMaterial ? 'material' : 'product'}, quantity, and cost.`);
    if (cost < 0) return setError("purchase-error", "Cost cannot be negative.");

    const total = qty * cost;
    setBtnLoading(btn, true);
    const { data: po, error: poErr } = await sb.from("purchase_orders").insert({
      business_id: membership.business_id, status: "received", total_amount: total, created_by: currentUser.id, received_at: new Date().toISOString(),
    }).select().single();
    if (poErr) { setBtnLoading(btn, false); return setError("purchase-error", poErr.message); }

    const payload = { purchase_order_id: po.id, quantity: qty, unit_cost: cost };
    if (isMaterial) {
      payload.raw_material_id = itemId;
    } else {
      payload.product_id = itemId;
    }
    const { error: itemErr } = await sb.from("purchase_order_items").insert(payload);
    if (itemErr) { setBtnLoading(btn, false); return setError("purchase-error", itemErr.message); }

    const table = isMaterial ? 'raw_materials' : 'products';
    const stockResult = await adjustStock(table, itemId, qty, membership.business_id);
    if (stockResult.error) { setBtnLoading(btn, false); return setError("purchase-error", "Stock changed during purchase — please try again."); }
    await logStockMovement({ itemType: isMaterial ? 'raw_material' : 'product', productId: isMaterial ? null : itemId, materialId: isMaterial ? itemId : null, qtyChange: qty, reason: 'purchase', refType: 'purchase_order', refId: po.id });

    setBtnLoading(btn, false);
    closeModal("purchase-modal");
    showToast("Purchase recorded");
    await Promise.all([loadProducts(), loadMaterials(), loadPurchases()]);
    renderDashboard();
  }

  // ---- PURCHASES ----
  const purchasesCfg = {
    ledgerId: 'purchases-ledger',
    table: 'purchase_orders',
    select: '*',
    timeCol: 'created_at',
    dateField: 'created_at',
    orderBy: 'created_at',
    moneyField: 'total_amount',
    entity: 'purchase',
    entityPlural: 'purchases',
    emptyHtml: `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">🛒</div>No purchases recorded yet.<br><span style="font-size:13px;">Restock your products by logging purchases.</span></div>`,
    listLabels: [['Date', ''], ['Status', ''], ['Total', 'right'], ['', ''], ['', '']],
    headHtml: () => headHtml([['Date', ''], ['Status', ''], ['Total', 'right'], ['', ''], ['', '']]),
    rowRender: (po) => `<div class="ledger-row" style="grid-template-columns: 2fr 1fr 1fr 1fr 0.6fr;">
        <div style="color:var(--ink-faint); font-size:12px;">${new Date(po.created_at).toLocaleDateString()}</div>
        <div><span class="cat-badge">${escapeHtml(po.status)}</span></div>
        <div class="num" style="text-align:right">${money(po.total_amount)}</div>
        <div style="text-align:right;"><span style="color:var(--danger); font-size:12px; text-decoration:underline; cursor:pointer;" onclick="voidPurchase('${escapeAttr(po.id)}')">Void</span></div>
        <div></div>
      </div>`,
  };
  ledgerTabConfig = Object.assign(ledgerTabConfig || {}, { purchases: purchasesCfg });
  async function loadPurchases(append = false) { await renderLedger('purchases', append); }

  async function voidPurchase(poId) {
    if (!confirm("Void this purchase? Stock added will be removed. This can't be undone.")) return;
    if (membership.role === "staff") { showToast("Staff cannot void purchases.", "error"); return; }

    const { data: items } = await sb.from("purchase_order_items").select("*").eq("purchase_order_id", poId);
    for (const item of items ?? []) {
      if (item.raw_material_id) {
        await adjustStock('raw_materials', item.raw_material_id, -Number(item.quantity), membership.business_id);
        await logStockMovement({ itemType: 'raw_material', materialId: item.raw_material_id, qtyChange: -Number(item.quantity), reason: 'purchase void', refType: 'purchase_order', refId: poId });
      } else {
        await adjustStock('products', item.product_id, -Number(item.quantity), membership.business_id);
        await logStockMovement({ itemType: 'product', productId: item.product_id, qtyChange: -Number(item.quantity), reason: 'purchase void', refType: 'purchase_order', refId: poId });
      }
    }
    await sb.from("purchase_orders").update({ status: "voided" }).eq("id", poId).eq("business_id", membership.business_id);

    await Promise.all([loadProducts(), loadMaterials(), loadPurchases()]);
    showToast("Purchase voided and stock restored");
    renderDashboard();
  }

  // ============================================================
  // SUPPLIERS
  // ============================================================
  async function loadSuppliers(append = false) {
    await pagedLoad('suppliers', { table: 'suppliers', orderBy: 'name', append });
    const el = document.getElementById("suppliers-ledger");
    if (!el) return;
    if (cache.suppliers.length === 0) { el.innerHTML = `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">🚚</div>No suppliers yet.<br><span style="font-size:12px;">Add suppliers to track who you buy from.</span></div>`; return; }
    const head = `<div class="ledger-head" style="grid-template-columns: 2fr 1fr;"><div>Name</div><div>Phone</div></div>`;
    const rows = cache.suppliers.map((s) => `<div class="ledger-row" style="grid-template-columns: 2fr 1fr; cursor:pointer;" onclick="openEditSupplier('${escapeAttr(s.id)}')">
        <div>${escapeHtml(s.name)}</div><div style="color:var(--ink-faint)">${escapeHtml(s.phone ?? "—")}</div>
      </div>`).join("");
    appendPaginated(el, head + rows, "suppliers", append);
  }

  function openEditSupplier(supplierId) {
    const s = cache.suppliers.find((x) => x.id === supplierId);
    if (!s) return;
    editingRecord = { table: "suppliers", id: s.id };
    document.getElementById("supplier-modal-title").textContent = "Edit supplier";
    document.getElementById("supplier-submit-btn").textContent = "Save changes";
    document.getElementById("supplier-delete-btn").classList.remove("hidden");
    document.getElementById("sup-name").value = s.name ?? "";
    document.getElementById("sup-phone").value = s.phone ?? "";
    openModal("supplier-modal");
  }

  async function submitSupplier() {
    clearError("supplier-error");
    const btn = document.getElementById("supplier-submit-btn");
    const name = document.getElementById("sup-name").value.trim();
    const phone = document.getElementById("sup-phone").value.trim() || null;
    if (!name) return setError("supplier-error", "Name is required.");

    const payload = { name, phone };
    setBtnLoading(btn, true);
    const { error } = editingRecord
      ? await sb.from("suppliers").update(payload).eq("id", editingRecord.id)
      : await sb.from("suppliers").insert(stampBranch({ business_id: membership.business_id, ...payload }));
    setBtnLoading(btn, false);

    if (error) return setError("supplier-error", error.message);
    closeModal("supplier-modal");
    showToast(editingRecord ? "Supplier updated" : "Supplier added");
    await loadSuppliers();
  }

  // ============================================================
  // STOCK MOVEMENTS
  // ============================================================
  async function loadMovements(append = false) {
    await pagedLoad('movements', { table: 'stock_movements', select: '*, products(name), raw_materials(name)', orderBy: 'created_at', ascending: false, timeFilterKey: 'movements', append });
    const el = document.getElementById("movements-ledger");
    if (!el) return;
    if (cache.movements.length === 0) { el.innerHTML = `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">📊</div>No stock movements recorded yet.<br><span style="font-size:12px;">Stock changes from sales, purchases, and waste will appear here.</span></div>`; return; }
    const head = `<div class="ledger-head" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr;"><div>Item</div><div>Type</div><div>Qty Change</div><div>Reason</div><div>Date</div></div>`;
    const rows = cache.movements.map((m) => {
      const name = m.products?.name || m.raw_materials?.name || '—';
      const qty = Number(m.quantity_change);
      const isNeg = qty < 0;
      return `<div class="ledger-row" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr;">
        <div>${escapeHtml(name)}</div>
        <div><span class="cat-badge">${escapeHtml(m.item_type)}</span></div>
        <div class="num" style="color:${isNeg ? 'var(--danger)' : 'var(--accent)'};">${qty > 0 ? '+' : ''}${qty}</div>
        <div style="color:var(--ink-faint); font-size:12px;">${escapeHtml(m.reason || '—')}</div>
        <div style="color:var(--ink-faint); font-size:12px;">${new Date(m.created_at).toLocaleDateString()}</div>
      </div>`;
    }).join("");
    appendPaginated(el, head + rows, "movements", append);
  }

  // ============================================================
  // TEAM
  // ============================================================
  async function loadTeam() {
    document.getElementById("team-invite-code").textContent = membership.businesses.invite_code;
    const data = await listTeamMembers();
    const el = document.getElementById("team-ledger");
    if (!el) return;
    if (!data || data.length === 0) { el.innerHTML = `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">👤</div>No team members found.<br><span style="font-size:12px;">Share your invite code to add staff.</span></div>`; return; }

    el.innerHTML =
      `<div class="ledger-head" style="grid-template-columns: 2fr 1fr 0.8fr;"><div>Name</div><div>Role</div><div></div></div>` +
      data.map((u) => {
        const isSelf = u.user_id === currentUser.id;
        return `<div class="ledger-row" style="grid-template-columns: 2fr 1fr 0.8fr;">
          <div>${escapeHtml(u.full_name || "—")}${isSelf ? ' <span style="color:var(--ink-faint); font-size:12px;">(you)</span>' : ""}</div>
          <div>
            ${isSelf
              ? `<span class="cat-badge">${escapeHtml(u.role)}</span>`
              : `<select onchange="changeRole('${u.user_id}', this.value)" style="padding:5px 8px; font-size:12px;">
                  <option value="staff" ${u.role === "staff" ? "selected" : ""}>Staff</option>
                  <option value="manager" ${u.role === "manager" ? "selected" : ""}>Manager</option>
                  <option value="owner" ${u.role === "owner" ? "selected" : ""}>Owner</option>
                </select>`
            }
          </div>
          <div style="text-align:right;">
            ${isSelf ? "" : `<span style="color:var(--danger); font-size:12px; text-decoration:underline; cursor:pointer;" onclick="removeTeamMember('${escapeAttr(u.user_id)}')">Remove</span>`}
          </div>
        </div>`;
      }).join("");
  }

  async function changeRole(userId, newRole) {
    if (FEATURES.businessMembers) {
      const { error } = await sb.from("business_members")
        .update({ role: newRole, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("business_id", membership.business_id);
      if (error) { showToast(error.message, "error"); await loadTeam(); return; }
      // Mirror to legacy table so the fallback path stays truthful during migration.
      const { error: mirrorErr } = await sb.from("app_users")
        .update({ role: newRole })
        .eq("user_id", userId).eq("business_id", membership.business_id);
      if (mirrorErr) console.warn("legacy app_users role mirror failed:", mirrorErr.message);
    } else {
      const { error } = await sb.from("app_users")
        .update({ role: newRole })
        .eq("user_id", userId).eq("business_id", membership.business_id);
      if (error) showToast(error.message, "error");
    }
    await loadTeam();
  }

  async function removeTeamMember(userId) {
    if (!confirm("Remove this person's access to the business? Their login stays, but they'll need a new invite code to rejoin.")) return;
    // Remove from the primary table first — reads prefer it.
    if (FEATURES.businessMembers) {
      const { error } = await sb.from("business_members")
        .delete().eq("user_id", userId).eq("business_id", membership.business_id);
      if (error) { showToast(error.message, "error"); return; }
    }
    const { error: legacyErr } = await sb.from("app_users")
      .delete().eq("user_id", userId).eq("business_id", membership.business_id);
    if (legacyErr) {
      console.error("legacy app_users removal failed:", legacyErr.message);
      showToast("Removed from team, but cleanup of legacy access failed — try Remove again.", "error");
      return;
    }
    await loadTeam();
  }

  // ============================================================
  // REPORTS
  // ============================================================
  let categoryChartInstance = null;
  let revenueTrendInstance = null;

  async function loadReports() {
    const orderItems = await getOrderItems();
    renderReportSummary(orderItems);
    await Promise.all([renderCategoryChart(orderItems), renderRevenueTrend(), renderTopProducts(orderItems), renderLowStockReport(), renderPaymentMethod(), renderTopCategories(orderItems), renderDayTrend()]);
  }

  function reportRange() {
    const mode = document.getElementById("reports-filter-mode")?.value || "all";
    const now = new Date();
    const r = { start: null, end: null, prevStart: null, prevEnd: null };
    if (mode === 'all') return r;
    if (mode === 'today') {
      r.start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      r.end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      r.prevStart = new Date(r.start); r.prevStart.setDate(r.prevStart.getDate() - 1);
      r.prevEnd = new Date(r.start);
    } else if (mode === 'week') {
      r.start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
      r.end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      r.prevStart = new Date(r.start); r.prevStart.setDate(r.prevStart.getDate() - 7);
      r.prevEnd = new Date(r.start);
    } else if (mode === 'month') {
      r.start = new Date(now.getFullYear(), now.getMonth(), 1);
      r.end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      r.prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      r.prevEnd = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (mode === 'year') {
      r.start = new Date(now.getFullYear(), 0, 1);
      r.end = new Date(now.getFullYear() + 1, 0, 1);
      r.prevStart = new Date(now.getFullYear() - 1, 0, 1);
      r.prevEnd = new Date(now.getFullYear(), 0, 1);
    } else if (mode === 'custom') {
      const sv = document.getElementById("reports-start-date")?.value;
      const ev = document.getElementById("reports-end-date")?.value;
      if (sv) r.start = new Date(sv);
      if (ev) { r.end = new Date(ev); r.end.setDate(r.end.getDate() + 1); }
      if (r.start && r.end) {
        const span = r.end.getTime() - r.start.getTime();
        r.prevEnd = new Date(r.start.getTime());
        r.prevStart = new Date(r.start.getTime() - span);
      }
    }
    return r;
  }

  async function getOrderItems() {
    const range = reportRange();
    let query = sb.from('orders').select('id, total_amount, status, created_at, payment_method').eq('business_id', membership.business_id);
    if (range.start) query = query.gte('created_at', range.start.toISOString());
    if (range.end) query = query.lt('created_at', range.end.toISOString());
    const { data: allOrders } = await query;

    window._reportPrevSales = [];
    if (range.prevStart && range.prevEnd) {
      let prevQuery = sb.from('orders').select('id, total_amount, status, created_at').eq('business_id', membership.business_id);
      prevQuery = prevQuery.gte('created_at', range.prevStart.toISOString()).lt('created_at', range.prevEnd.toISOString());
      const { data: prevOrders } = await prevQuery;
      window._reportPrevSales = (prevOrders || []).filter(o => o.status !== 'voided');
    }

    const validOrderIds = (allOrders || []).filter(o => o.status !== 'voided').map(o => o.id);
    window._reportSales = allOrders || [];
    if (validOrderIds.length === 0) return [];
    const { data } = await sb.from("order_items").select("product_id, quantity, unit_price").in("order_id", validOrderIds);
    return data ?? [];
  }

  let reportSummaryPrev = null;
  function renderReportSummary(orderItems) {
    const sales = (window._reportSales || []).filter(o => o.status !== 'voided');
    const prevSales = window._reportPrevSales || [];
    const totalRevenue = sales.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const orderCount = sales.length;
    const avgOrder = orderCount ? totalRevenue / orderCount : 0;
    const lowStockCount = cache.products.filter((p) => p.product_type !== 'manufactured' && p.stock_qty !== null && p.low_stock_threshold !== null && Number(p.stock_qty) <= Number(p.low_stock_threshold)).length;

    const productRevenue = {};
    for (const item of orderItems) {
      productRevenue[item.product_id] = (productRevenue[item.product_id] || 0) + Number(item.quantity) * Number(item.unit_price);
    }
    const topProduct = Object.entries(productRevenue)
      .map(([pid, revenue]) => ({ pid, revenue }))
      .sort((a, b) => b.revenue - a.revenue)[0];
    const topProductName = topProduct ? (cache.products.find((p) => p.id === topProduct.pid)?.name ?? "Deleted product") : "None yet";

    const totalRevenueEl = document.getElementById("report-total-revenue");
    totalRevenueEl.textContent = abbreviateCurrency(totalRevenue);
    totalRevenueEl.title = money(totalRevenue);
    document.getElementById("report-top-product").textContent = escapeHtml(topProductName);
    document.getElementById("report-low-stock-count").textContent = lowStockCount;
    document.getElementById("report-top-product-mini").textContent = escapeHtml(topProductName);
    document.getElementById("report-low-stock-count-mini").textContent = lowStockCount;
    document.getElementById("report-order-count").textContent = orderCount;
    document.getElementById("report-orders-mini").textContent = orderCount;
    document.getElementById("report-avg-order").textContent = abbreviateCurrency(Math.round(avgOrder));

    const prevTotalRevenue = prevSales.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const prevAvgOrder = prevSales.length ? prevTotalRevenue / prevSales.length : 0;
    setDelta("report-revenue-delta", prevTotalRevenue, totalRevenue, (v) => abbreviateCurrency(Math.round(v)));
    setDelta("report-avg-delta", prevAvgOrder, avgOrder, (v) => abbreviateCurrency(Math.round(v)));

    const categoryTotals = {};
    for (const item of orderItems) {
      const product = cache.products.find((p) => p.id === item.product_id);
      const category = product?.category || "Uncategorized";
      categoryTotals[category] = (categoryTotals[category] || 0) + Number(item.quantity) * Number(item.unit_price);
    }
    const topCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "None yet";
    document.getElementById("report-top-category").textContent = escapeHtml(topCategory);
    reportSummaryPrev = { totalRevenue, avgOrder };
  }

  function setDelta(elId, prev, cur, fmt) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!prev || prev <= 0) { el.textContent = "—"; el.className = "delta flat"; return; }
    const pct = ((cur - prev) / prev) * 100;
    const up = pct >= 0;
    const abs = Math.abs(pct);
    el.textContent = `${up ? "▲" : "▼"} ${abs.toFixed(1)}% vs prev${fmt ? ` · ${fmt(Math.abs(cur - prev))}` : ""}`;
    el.className = "delta " + (abs < 0.05 ? "flat" : up ? "up" : "down");
  }

  async function renderCategoryChart(orderItems) {
    const wrap = document.querySelector('.category-chart-wrap');
    if (!wrap) return;

    const categoryTotals = {};
    for (const item of orderItems) {
      const product = cache.products.find((p) => p.id === item.product_id);
      const category = product?.category || "Uncategorized";
      categoryTotals[category] = (categoryTotals[category] || 0) + Number(item.quantity) * Number(item.unit_price);
    }

    const entries = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (entries.length === 0) {
      if (categoryChartInstance) { categoryChartInstance.destroy(); categoryChartInstance = null; }
      wrap.innerHTML = `<div class="empty-state">No category data available.</div>`;
      return;
    }
    if (wrap.querySelector('.empty-state') || !wrap.querySelector('canvas')) wrap.innerHTML = `<canvas id="category-chart" height="110"></canvas>`;
    const canvas = document.getElementById("category-chart");
    if (!canvas) return;

    const labels = entries.map(([category]) => category);
    const data = entries.map(([, total]) => total);
    const colors = ["#C2410C","#5CACF7","#9C6B1F","#F59E0B","#10B981","#8B5CF6"];

    if (categoryChartInstance) categoryChartInstance.destroy();
    categoryChartInstance = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors.slice(0, labels.length), borderWidth: 2, borderColor: "#fff" }],
      },
      options: {
        cutout: "62%",
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 12 } } },
        },
        responsive: true,
        maintainAspectRatio: false,
      },
    });
  }

  async function renderRevenueTrend() {
    const sales = (window._reportSales || []).filter(o => o.status !== 'voided');
    const wrap = document.querySelector('.trend-chart-wrap');
    if (!wrap) return;
    if (sales.length === 0) {
      if (revenueTrendInstance) { revenueTrendInstance.destroy(); revenueTrendInstance = null; }
      wrap.innerHTML = `<div class="empty-state">No sales in this range yet.</div>`;
      return;
    }
    if (wrap.querySelector('.empty-state') || !wrap.querySelector('canvas')) wrap.innerHTML = `<canvas id="revenue-trend-chart" height="120"></canvas>`;
    const freshCanvas = document.getElementById("revenue-trend-chart");
    if (!freshCanvas) return;

    const dates = sales.map(o => new Date(o.created_at));
    const min = new Date(Math.min(...dates.map(d => d.getTime())));
    const max = new Date(Math.max(...dates.map(d => d.getTime())));
    const spanDays = (max.getTime() - min.getTime()) / 86400000 + 1;

    const bucketKey = (d) => {
      if (spanDays <= 2) return { label: d.getHours() + ":00", key: d.toDateString() + "|" + d.getHours() };
      if (spanDays <= 62) return { label: d.toLocaleDateString([], { month: "short", day: "numeric" }), key: d.toDateString() };
      return { label: d.toLocaleDateString([], { month: "short", year: "2-digit" }), key: d.getFullYear() + "-" + d.getMonth() };
    };

    const buckets = {};
    const orderLabels = [];
    const now = Date.now();
    for (const o of sales) {
      const d = new Date(o.created_at);
      if (d.getTime() > now) continue;
      const { label, key } = bucketKey(d);
      if (!buckets[key]) { buckets[key] = { label, total: 0 }; orderLabels.push(key); }
      buckets[key].total += Number(o.total_amount || 0);
    }
    orderLabels.sort((a, b) => a.localeCompare(b));
    const labels = orderLabels.map(k => buckets[k].label);
    const data = orderLabels.map(k => buckets[k].total);

    // Fill gaps in daily mode so the line reads as a continuous band
    if (spanDays > 2 && spanDays <= 62 && data.length > 1) {
      const full = [];
      const start = new Date(min.getFullYear(), min.getMonth(), min.getDate());
      const cur = new Date(start);
      const keys = new Set(orderLabels);
      while (cur <= max) {
        const k = cur.toDateString();
        full.push({ label: cur.toLocaleDateString([], { month: "short", day: "numeric" }), v: keys.has(k) ? buckets[k].total : 0 });
        cur.setDate(cur.getDate() + 1);
      }
      const fullLabels = full.map(f => f.label);
      const fullData = full.map(f => f.v);
      if (revenueTrendInstance) revenueTrendInstance.destroy();
      revenueTrendInstance = new Chart(freshCanvas, {
        type: "bar",
        data: { labels: fullLabels, datasets: [{ data: fullData, backgroundColor: "#C2410C", hoverBackgroundColor: "#9A3412", borderRadius: 4, barPercentage: 0.7 }] },
        options: {
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.y) } } },
          scales: {
            x: { grid: { display: false }, ticks: { color: "#A8A29E", maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
            y: { grid: { color: "rgba(0,0,0,0.06)" }, ticks: { color: "#A8A29E", callback: (v) => abbreviateNumber(v) } },
          },
          responsive: true,
          maintainAspectRatio: false,
        },
      });
      return;
    }

    if (revenueTrendInstance) revenueTrendInstance.destroy();
    revenueTrendInstance = new Chart(freshCanvas, {
      type: "bar",
      data: { labels, datasets: [{ data, backgroundColor: "#C2410C", hoverBackgroundColor: "#9A3412", borderRadius: 4, barPercentage: 0.7 }] },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.y) } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#A8A29E", maxRotation: spanDays <= 2 ? 0 : 45, autoSkip: true, maxTicksLimit: 10 } },
          y: { grid: { color: "rgba(0,0,0,0.06)" }, ticks: { color: "#A8A29E", callback: (v) => abbreviateNumber(v) } },
        },
        responsive: true,
        maintainAspectRatio: false,
      },
    });
  }

  async function renderTopProducts(orderItems) {
    const el = document.getElementById("top-products-ledger");
    if (!el) return;
    if (orderItems.length === 0) { el.innerHTML = `<div class="empty-state">No sales yet.</div>`; return; }

    const agg = {};
    for (const it of orderItems) {
      if (!agg[it.product_id]) agg[it.product_id] = { qty: 0, revenue: 0 };
      agg[it.product_id].qty += Number(it.quantity);
      agg[it.product_id].revenue += Number(it.quantity) * Number(it.unit_price);
    }
    const top = Object.entries(agg)
      .map(([pid, v]) => {
        const p = cache.products.find((x) => x.id === pid);
        return { name: p ? p.name : "Deleted product", category: p?.category ?? "—", ...v };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    if (top.length === 0) { el.innerHTML = `<div class="empty-state">No sales yet.</div>`; return; }
    el.innerHTML =
      `<div class="ledger-head" style="grid-template-columns: 2fr 1fr 1fr 1fr;"><div>Product</div><div>Category</div><div>Qty sold</div><div style="text-align:right">Revenue</div></div>` +
      top.map((t) => `<div class="ledger-row" style="grid-template-columns: 2fr 1fr 1fr 1fr;">
        <div>${escapeHtml(t.name)}</div>
        <div>${escapeHtml(t.category)}</div>
        <div class="num">${t.qty}</div>
        <div class="num" style="text-align:right">${money(t.revenue)}</div>
      </div>`).join("");
  }

  function renderPaymentMethod() {
    const el = document.getElementById("payment-method-ledger");
    if (!el) return;
    const sales = (window._reportSales || []).filter(o => o.status !== 'voided');
    const totals = {};
    for (const o of sales) {
      const method = o.payment_method || "Unknown";
      totals[method] = (totals[method] || 0) + Number(o.total_amount || 0);
    }
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const grand = entries.reduce((s, [, v]) => s + v, 0);
    if (entries.length === 0) { el.innerHTML = `<div class="empty-state">No sales yet.</div>`; return; }
    el.innerHTML = entries.map(([method, v]) => `
      <div style="padding:8px 0; border-bottom:1px solid var(--line);">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
          <span style="font-size:13px; font-weight:500; text-transform:capitalize;">${escapeHtml(method)}</span>
          <span class="num" style="font-size:13px;">${money(v)}</span>
        </div>
        <div style="height:6px; background:var(--line); border-radius:999px; margin-top:6px; overflow:hidden;">
          <div style="height:100%; width:${grand ? (v / grand) * 100 : 0}%; background:var(--accent); border-radius:999px;"></div>
        </div>
      </div>`).join("");
  }

  function renderTopCategories(orderItems) {
    const el = document.getElementById("top-categories-ledger");
    if (!el) return;
    if (!orderItems || orderItems.length === 0) { el.innerHTML = `<div class="empty-state">No sales yet.</div>`; return; }
    const catRev = {};
    for (const item of orderItems) {
      const product = cache.products.find((p) => p.id === item.product_id);
      const category = product?.category || "Uncategorized";
      catRev[category] = (catRev[category] || 0) + Number(item.quantity) * Number(item.unit_price);
    }
    const entries = Object.entries(catRev).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const grand = entries.reduce((s, [, v]) => s + v, 0);
    if (entries.length === 0) { el.innerHTML = `<div class="empty-state">No sales yet.</div>`; return; }
    el.innerHTML = entries.map(([cat, v]) => `
      <div style="padding:8px 0; border-bottom:1px solid var(--line);">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
          <span style="font-size:13px; font-weight:500;">${escapeHtml(cat)}</span>
          <span class="num" style="font-size:13px;">${money(v)}</span>
        </div>
        <div style="height:6px; background:var(--line); border-radius:999px; margin-top:6px; overflow:hidden;">
          <div style="height:100%; width:${grand ? (v / grand) * 100 : 0}%; background:var(--attention); border-radius:999px;"></div>
        </div>
      </div>`).join("");
  }

  function renderDayTrend() {
    const el = document.getElementById("day-trend-ledger");
    if (!el) return;
    const sales = (window._reportSales || []).filter(o => o.status !== 'voided');
    if (sales.length === 0) { el.innerHTML = `<div class="empty-state">No sales yet.</div>`; return; }
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayTotals = [0, 0, 0, 0, 0, 0, 0];
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];
    for (const o of sales) {
      const d = new Date(o.created_at);
      const idx = d.getDay();
      dayTotals[idx] += Number(o.total_amount || 0);
      dayCounts[idx]++;
    }
    const rows = dayTotals.map((v, i) => ({ name: dayNames[i], total: v, count: dayCounts[i] })).sort((a, b) => b.total - a.total);
    el.innerHTML = rows.map(r => `<div class="ledger-row" style="grid-template-columns: 1fr 1fr 1fr; min-width:0;">
      <div>${r.name}</div>
      <div class="num">${r.count} order${r.count === 1 ? "" : "s"}</div>
      <div class="num" style="text-align:right">${money(r.total)}</div>
    </div>`).join("");
  }

  function renderLowStockReport() {
    const el = document.getElementById("low-stock-ledger");
    if (!el) return;
    const lowProducts = cache.products.filter(p => p.product_type !== 'recipe' && p.stock_qty !== null && p.low_stock_threshold !== null && Number(p.stock_qty) <= Number(p.low_stock_threshold));
    const constrainedRecipes = cache.products
      .filter(p => p.product_type === 'recipe')
      .map(p => {
        const avail = getDerivedAvailability(p.id);
        return { ...p, derivedAvail: avail };
      })
      .filter(p => p.derivedAvail <= 0);
    if (lowProducts.length === 0 && constrainedRecipes.length === 0) { el.innerHTML = `<div class="empty-state">Nothing low right now.</div>`; return; }
    let html = '';
    if (lowProducts.length > 0) {
      html += `<div style="font-size:12px; font-weight:600; color:var(--ink-faint); margin-bottom:6px; text-transform:uppercase;">Low Stock — Resale & Manufactured</div>`;
      html += `<div class="ledger-head" style="grid-template-columns: 2fr 1fr 1fr;"><div>Product</div><div>Stock left</div><div style="text-align:right">Reorder</div></div>`;
      html += lowProducts.map((p) => `<div class="ledger-row" style="grid-template-columns: 2fr 1fr 1fr;">
        <div>${escapeHtml(p.name)}</div>
        <div class="low-tag">${p.stock_qty} ${escapeHtml(p.unit)}</div>
        <div style="text-align:right">${p.low_stock_threshold}</div>
      </div>`).join("");
    }
    if (constrainedRecipes.length > 0) {
      html += `<div style="font-size:12px; font-weight:600; color:var(--ink-faint); margin:12px 0 6px; text-transform:uppercase;">Recipe Products — Unavailable</div>`;
      html += `<div class="ledger-head" style="grid-template-columns: 2fr 1fr;"><div>Product</div><div>Status</div></div>`;
      html += constrainedRecipes.map((p) => `<div class="ledger-row" style="grid-template-columns: 2fr 1fr;">
        <div>${escapeHtml(p.name)}</div>
        <div class="low-tag">Unavailable — ingredients out</div>
      </div>`).join("");
    }
    el.innerHTML = html;
  }

  function copyInviteCode(evt) {
    navigator.clipboard.writeText(membership.businesses.invite_code);
    const btn = evt.target;
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = original), 1200);
  }

  // ============================================================
  // RAW MATERIALS
  // ============================================================
  async function loadMaterials(append = false) {
    await pagedLoad('materials', { table: 'raw_materials', orderBy: 'name', append });
    const el = document.getElementById("materials-ledger");
    if (!el) return;
    if (cache.materials.length === 0) { el.innerHTML = `<div class="empty-state"><div style="font-size:32px; margin-bottom:8px;">🧱</div>No raw materials yet.<br><span style="font-size:12px;">Add ingredients or components for your recipes.</span></div>`; return; }
    const cards = cache.materials.map((m) => {
        const isLow = m.low_stock_threshold !== null && Number(m.stock_qty) <= Number(m.low_stock_threshold);
        const stockCls = isLow ? 'out' : Number(m.stock_qty) === 0 ? 'out' : 'ok';
        return `<div class="item-card" onclick="openEditMaterial('${escapeAttr(m.id)}')">
          <div class="card-name">${escapeHtml(m.name)}</div>
          <div class="card-stock ${stockCls}">${m.stock_qty} ${escapeHtml(m.unit)}</div>
          <div class="card-bottom">
            <span class="card-meta">${escapeHtml(m.unit)}</span>
            <button class="card-action" onclick="event.stopPropagation(); openSendToKitchenModal('${escapeAttr(m.id)}')" data-i18n="kitchen.send">Send to Kitchen</button>
          </div>
        </div>`;
      }).join("");
    if (!append) {
      el.innerHTML = `<div class="card-grid">${cards}</div>`;
      if (pagination.materials > 0) el.insertAdjacentHTML("beforeend", `<div style="text-align:center; padding:12px;"><button class="btn-ghost load-more-btn" onclick="loadMore('materials')">Load more</button></div>`);
    } else {
      const grid = el.querySelector('.card-grid');
      if (grid) grid.insertAdjacentHTML("beforeend", cards);
      const loadMoreBtn = el.querySelector(".load-more-btn");
      if (loadMoreBtn) loadMoreBtn.remove();
      if (pagination.materials > 0) el.insertAdjacentHTML("beforeend", `<div style="text-align:center; padding:12px;"><button class="btn-ghost load-more-btn" onclick="loadMore('materials')">Load more</button></div>`);
    }

    // Low stock alerts
    const lowEl = document.getElementById("store-low-stock");
    if (lowEl) {
      const low = cache.materials.filter(m => m.low_stock_threshold !== null && Number(m.stock_qty) <= Number(m.low_stock_threshold));
      if (low.length === 0) {
        lowEl.innerHTML = `<div style="color:var(--accent); font-size:13px; padding:12px 0;">All items well-stocked.</div>`;
      } else {
        lowEl.innerHTML = low.map(m => {
          return `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);">
            <span><strong>${escapeHtml(m.name)}</strong> <span style="color:var(--ink-faint); font-size:12px;">(${escapeHtml(m.unit)})</span></span>
            <span style="color:var(--danger); font-weight:600;">${m.stock_qty} / ${m.low_stock_threshold}</span>
          </div>`;
        }).join('');
      }
    }
  }

  // ========== KITCHEN ==========
  // loadKitchenStock replaced by renderKitchenStock in the Kitchen Command Center section above

  let sendToKitchenMaterialId = null;

  function openSendToKitchenModal(materialId) {
    const m = cache.materials.find(x => x.id === materialId);
    if (!m) return;
    sendToKitchenMaterialId = materialId;
    document.getElementById('send-kitchen-material-name').textContent = `${m.name} — ${m.stock_qty} ${m.unit} in Store`;
    document.getElementById('send-kitchen-available').textContent = `Max: ${m.stock_qty} ${m.unit}`;
    const qtyInput = document.getElementById('send-kitchen-qty');
    qtyInput.value = '';
    qtyInput.max = m.stock_qty;
    clearError('send-kitchen-error');
    openModal('send-kitchen-modal');
  }

  async function submitSendToKitchen() {
    const materialId = sendToKitchenMaterialId;
    const m = cache.materials.find(x => x.id === materialId);
    if (!m) return;
    const qty = parseFloat(document.getElementById('send-kitchen-qty').value);
    clearError('send-kitchen-error');
    if (!qty || qty <= 0) return setError('send-kitchen-error', 'Enter a valid quantity.');
    if (qty > Number(m.stock_qty)) return setError('send-kitchen-error', `Only ${m.stock_qty} ${m.unit} available in Store.`);

    const btn = document.getElementById('send-kitchen-submit-btn');
    setBtnLoading(btn, true);

    const { error: storeErr } = await adjustStockColumn('raw_materials', materialId, 'stock_qty', -qty, membership.business_id);
    if (storeErr) { setBtnLoading(btn, false); return setError('send-kitchen-error', storeErr.message); }

    const { error: kitchenErr } = await adjustStockColumn('raw_materials', materialId, 'kitchen_stock_qty', qty, membership.business_id);
    if (kitchenErr) {
      // Roll back the store deduction so stock isn't lost if the kitchen-side update fails.
      await adjustStockColumn('raw_materials', materialId, 'stock_qty', qty, membership.business_id);
      setBtnLoading(btn, false);
      return setError('send-kitchen-error', kitchenErr.message);
    }

    await logStockMovement({ itemType: 'raw_material', materialId, qtyChange: -qty, reason: 'sent_to_kitchen', refType: 'kitchen_transfer', location: 'store' });
    await logStockMovement({ itemType: 'raw_material', materialId, qtyChange: qty, reason: 'sent_to_kitchen', refType: 'kitchen_transfer', location: 'kitchen' });

    setBtnLoading(btn, false);
    closeModal('send-kitchen-modal');
    showToast(`Sent ${qty} ${m.unit} of ${m.name} to Kitchen`, 'success');
    await loadMaterials();
    renderKitchenStock();
  }

  function openAddMaterial() {
    editingRecord = null;
    document.getElementById("material-modal-title").textContent = "Add raw material";
    document.getElementById("material-submit-btn").textContent = "Save raw material";
    document.getElementById("material-delete-btn").classList.add("hidden");
    document.getElementById("m-name").value = "";
    document.getElementById("m-unit").innerHTML = '<option value="">Select unit</option>' + unitOptionsHtml('');
    document.getElementById("m-cost").value = "";
    document.getElementById("m-stock").value = "";
    document.getElementById("m-threshold").value = "";
    openModal("material-modal");
  }

  function openEditMaterial(materialId) {
    const m = cache.materials.find((x) => x.id === materialId);
    if (!m) return;
    editingRecord = { table: "raw_materials", id: m.id };
    document.getElementById("material-modal-title").textContent = "Edit raw material";
    document.getElementById("material-submit-btn").textContent = "Save changes";
    document.getElementById("material-delete-btn").classList.remove("hidden");
    document.getElementById("m-name").value = m.name;
    document.getElementById("m-unit").innerHTML = '<option value="">Select unit</option>' + unitOptionsHtml(m.unit);
    if (!document.getElementById("m-unit").value && m.unit) {
      document.getElementById("m-unit").innerHTML += `<option value="${escapeAttr(m.unit)}" selected>${escapeHtml(m.unit)} (custom)</option>`;
    }
    document.getElementById("m-cost").value = m.cost_per_unit ?? "";
    document.getElementById("m-stock").value = m.stock_qty ?? "";
    document.getElementById("m-threshold").value = m.low_stock_threshold ?? "";
    openModal("material-modal");
  }

  async function submitMaterial() {
    clearError("material-error");
    const btn = document.getElementById("material-submit-btn");
    const name = document.getElementById("m-name").value.trim();
    const unit = document.getElementById("m-unit").value || "pcs";
    const cost = document.getElementById("m-cost").value === "" ? 0 : parseFloat(document.getElementById("m-cost").value);
    const stock = document.getElementById("m-stock").value === "" ? 0 : parseFloat(document.getElementById("m-stock").value);
    const threshold = document.getElementById("m-threshold").value === "" ? null : parseFloat(document.getElementById("m-threshold").value);
    if (!name) return setError("material-error", "Name is required.");
    if (cost < 0) return setError("material-error", "Cost cannot be negative.");
    if (stock < 0) return setError("material-error", "Stock cannot be negative.");
    if (threshold !== null && threshold < 0) return setError("material-error", "Threshold cannot be negative.");

    const payload = { name, unit, cost_per_unit: cost, stock_qty: stock, low_stock_threshold: threshold };
    setBtnLoading(btn, true);
    const { error } = editingRecord
      ? await sb.from("raw_materials").update(payload).eq("id", editingRecord.id)
      : await sb.from("raw_materials").insert({ business_id: membership.business_id, ...payload });
    setBtnLoading(btn, false);

    if (error) return setError("material-error", error.message);
    closeModal("material-modal");
    showToast(editingRecord ? "Material updated" : "Material added");
    await loadMaterials();
  }

  // ============================================================
  // RECIPES
  // ============================================================
  let recipeProductId = null;

  async function openRecipeModal(productId) {
    if (!businessUsesRawMaterials()) return;
    recipeProductId = productId;
    const p = cache.products.find((x) => x.id === productId);
    document.getElementById("recipe-product-name").textContent = p ? p.name : "";
    document.getElementById("ri-material").innerHTML = cache.materials.map((m) => `<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.unit)})</option>`).join("");
    await renderRecipeItems();
    openModal("recipe-modal");
  }

  async function renderRecipeItems() {
    const { data } = await sb.from("recipe_items").select("id, product_id, raw_material_id, quantity_required").eq("product_id", recipeProductId);
    const el = document.getElementById("recipe-items-list");
    if (!data || data.length === 0) { el.innerHTML = `<div class="empty-state" style="padding:16px;">No recipe set yet.</div>`; return; }
    let totalCost = 0;
    el.innerHTML = data.map((ri) => {
      const mat = cache.materials.find(m => m.id === ri.raw_material_id);
      const matName = mat ? escapeHtml(mat.name) : 'Unknown';
      const matUnit = mat ? escapeHtml(mat.unit) : '';
      const matCost = mat ? Number(mat.cost_per_unit || 0) : 0;
      const lineCost = Number(ri.quantity_required) * matCost;
      totalCost += lineCost;
      return `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);">
        <div style="font-size:14px;">${matName}</div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="num">${ri.quantity_required} ${matUnit}</span>
          <span style="color:var(--ink-faint); font-size:12px;">${money(lineCost)}</span>
          <span style="color:var(--danger); font-size:12px; text-decoration:underline; cursor:pointer;" onclick="removeRecipeItem('${escapeAttr(ri.id)}')">Remove</span>
        </div>
      </div>`;
    }).join("") + `<div style="padding:8px 0; font-size:13px; font-weight:600; color:var(--ink-soft);">Total recipe cost per unit: ${money(totalCost)}</div>`;
  }

  async function addRecipeItem() {
    clearError("recipe-error");
    const btn = document.getElementById("recipe-submit-btn");
    const materialId = document.getElementById("ri-material").value;
    const qty = parseFloat(document.getElementById("ri-qty").value);
    if (!materialId || isNaN(qty) || qty <= 0) return setError("recipe-error", "Pick a raw material and a valid quantity.");

    // Check for duplicate
    const existing = await sb.from("recipe_items").select("id").eq("product_id", recipeProductId).eq("raw_material_id", materialId).maybeSingle();
    if (existing.data) return setError("recipe-error", "This material is already in the recipe. Remove it first if you want to change the quantity.");

    setBtnLoading(btn, true);
    const { error } = await sb.from("recipe_items").insert({ product_id: recipeProductId, raw_material_id: materialId, quantity_required: qty });
    setBtnLoading(btn, false);
    if (error) return setError("recipe-error", error.message);
    showToast("Ingredient added to recipe");
    document.getElementById("ri-qty").value = "";
    await renderRecipeItems();
  }

  async function removeRecipeItem(recipeItemId) {
    const { error } = await sb.from("recipe_items").delete().eq("id", recipeItemId);
    if (error) { document.getElementById("recipe-error").textContent = error.message; document.getElementById("recipe-error").classList.remove("hidden"); return; }
    await renderRecipeItems();
  }

  // ============================================================
  // PRODUCE
  // ============================================================
  function openProduceModal() {
    if (!businessUsesRawMaterials()) return;
    const manufactured = cache.products.filter(p => p.product_type === 'manufactured');
    if (manufactured.length === 0) {
      document.getElementById("prod-product").innerHTML = '<option value="">No manufactured products — add one in Products tab first</option>';
    } else {
      document.getElementById("prod-product").innerHTML = manufactured.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    }
    openModal("produce-modal");
    onProduceProductChange();
  }

  async function onProduceProductChange() {
    const productId = document.getElementById("prod-product").value;
    const batchQty = parseFloat(document.getElementById("prod-planned-qty").value) || 1;
    const { data: recipe } = await sb.from("recipe_items").select("id, product_id, raw_material_id, quantity_required").eq("product_id", productId);
    const el = document.getElementById("produce-requirements");
    const costingEl = document.getElementById("produce-costing");

    if (!recipe || recipe.length === 0) { el.innerHTML = `<em>No recipe set for this product — <a href="javascript:void(0)" onclick="closeModal('produce-modal'); openRecipeModal('${escapeAttr(productId)}')" style="color:var(--accent)">add one now</a>.</em>`; costingEl.style.display = 'none'; return; }

    let totalMaterialCost = 0;
    el.innerHTML = "<strong>This will use:</strong><br>" + recipe.map((ri) => {
      const mat = cache.materials.find(m => m.id === ri.raw_material_id);
      const matName = mat ? escapeHtml(mat.name) : 'Unknown material';
      const matUnit = mat ? escapeHtml(mat.unit) : '';
      const matCost = mat ? Number(mat.cost_per_unit || 0) : 0;
      const available = mat ? Number(mat.stock_qty) : 0;
      const needed = Number(ri.quantity_required) * batchQty;
      const short = needed > available;
      totalMaterialCost += needed * matCost;
      return `<span style="${short ? "color:var(--danger); font-weight:500;" : ""}">${matName}: ${needed} ${matUnit}${short ? ` (only ${available} available!)` : ""}</span>`;
    }).join("<br>");

    const product = cache.products.find(p => p.id === productId);
    const sellPrice = product ? Number(product.price) : 0;
    const costPerUnit = batchQty > 0 ? totalMaterialCost / batchQty : 0;
    const margin = sellPrice > 0 ? ((sellPrice - costPerUnit) / sellPrice * 100) : 0;

    document.getElementById("prod-material-cost").textContent = money(totalMaterialCost);
    document.getElementById("prod-unit-cost").textContent = money(costPerUnit);
    document.getElementById("prod-sell-price").textContent = money(sellPrice);
    document.getElementById("prod-margin").textContent = margin.toFixed(1) + '%';
    document.getElementById("prod-margin").style.color = margin >= 0 ? 'var(--accent)' : 'var(--danger)';
    const actualYield = parseFloat(document.getElementById("prod-actual-yield").value) || batchQty;
    const yieldPct = batchQty > 0 ? (actualYield / batchQty * 100) : 0;
    document.getElementById("prod-yield-pct").textContent = actualYield !== batchQty ? yieldPct.toFixed(1) + '%' : '—';
    costingEl.style.display = 'block';
  }

  async function submitProduce() {
    clearError("produce-error");
    const btn = document.getElementById("produce-submit-btn");
    const productId = document.getElementById("prod-product").value;
    const batchQty = parseFloat(document.getElementById("prod-planned-qty").value);
    const actualYield = parseFloat(document.getElementById("prod-actual-yield").value) || batchQty;
    if (isNaN(batchQty) || batchQty <= 0) return setError("produce-error", "Enter a valid batch quantity.");

    const { data: recipe } = await sb.from("recipe_items").select("id, product_id, raw_material_id, quantity_required").eq("product_id", productId);
    if (!recipe || recipe.length === 0) return setError("produce-error", "This product has no recipe set yet.");

    for (const ri of recipe) {
      const mat = cache.materials.find(m => m.id === ri.raw_material_id);
      const matName = mat ? mat.name : 'material';
      const needed = Number(ri.quantity_required) * batchQty;
      const available = mat ? Number(mat.stock_qty) : 0;
      if (needed > available) {
        return setError("produce-error", `Not enough ${matName} — need ${needed}, have ${available}.`);
      }
    }

    setBtnLoading(btn, true);

    // Insert batch record
    const { data: batch, error: batchErr } = await sb.from("produce_batches").insert({
      business_id: membership.business_id,
      product_id: productId,
      batch_qty: batchQty,
      actual_yield: actualYield,
      status: 'completed',
      started_by: currentUser.id,
      completed_by: currentUser.id,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }).select().single();
    if (batchErr) { setBtnLoading(btn, false); return setError("produce-error", batchErr.message); }

    // Deduct raw materials
    for (const ri of recipe) {
      const needed = Number(ri.quantity_required) * batchQty;
      const mat = cache.materials.find(m => m.id === ri.raw_material_id);
      const matName = mat ? mat.name : 'material';
      const result = await adjustStock('raw_materials', ri.raw_material_id, -needed, membership.business_id);
      if (result.error) { setBtnLoading(btn, false); return setError("produce-error", `Stock changed for ${matName} — please try again.`); }
      await logStockMovement({ itemType: 'raw_material', materialId: ri.raw_material_id, qtyChange: -needed, reason: 'production', refType: 'production', refId: batch.id });
    }

    // Increment stock_qty for the manufactured product
    const { data: currentProd } = await sb.from('products').select('stock_qty, product_type').eq('id', productId).eq('business_id', membership.business_id).single();
    if (currentProd && currentProd.product_type === 'manufactured') {
      const newStock = Number(currentProd.stock_qty || 0) + actualYield;
      await sb.from('products').update({ stock_qty: newStock }).eq('id', productId).eq('business_id', membership.business_id);
      await logStockMovement({ itemType: 'product', productId: productId, qtyChange: actualYield, reason: 'production', refType: 'produce_batch', refId: batch.id });
    }

    setBtnLoading(btn, false);
    closeModal("produce-modal");
    showToast(`${actualYield} unit${actualYield === 1 ? "" : "s"} produced`);
    await Promise.all([loadProducts(), loadMaterials(), loadProduceBatches()]);
    renderDashboard();
  }

  // initialize theme (reads preference) then boot app
  function setThemeClass(isDark) {
    if (isDark) document.documentElement.classList.add('theme-dark');
    else document.documentElement.classList.remove('theme-dark');
    updateThemeIcon();
  }

  function toggleTheme() {
    const dark = !document.documentElement.classList.contains('theme-dark');
    localStorage.setItem('thole:dark', dark ? '1' : '0');
    setThemeClass(dark);
  }

  function initTheme() {
    const stored = localStorage.getItem('thole:dark');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const useDark = stored === null ? prefersDark : stored === '1';
    setThemeClass(!!useDark);
  }

  initTheme();
  bindPullToRefresh();

  // --- 1. Escape key closes modals ---
  // --- 5. Enter key submits active modal ---
  document.addEventListener("wheel", (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  document.addEventListener("keydown", (e) => {
    // Prevent browser zoom (Ctrl/Cmd + +/-/0)
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) {
      e.preventDefault();
    }
    // POS keyboard shortcuts
    if (!document.getElementById("pos-modal")?.classList.contains("hidden")) {
      if (e.key === "Enter" && !e.target.matches("input, select, textarea")) {
        e.preventDefault();
        const payBtn = document.getElementById("pos-pay-btn");
        if (payBtn) payBtn.click();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal("pos-modal");
        return;
      }
    }
    // Payment modal Enter to confirm
    if (!document.getElementById("payment-modal")?.classList.contains("hidden")) {
      if (e.key === "Enter" && !e.target.matches("textarea")) {
        e.preventDefault();
        completePayment();
        return;
      }
    }
    if (e.key === "Escape") {
      const openModals = document.querySelectorAll(".modal-backdrop:not(.hidden)");
      if (openModals.length > 0) {
        const last = openModals[openModals.length - 1];
        closeModal(last.id);
      }
    }
    if (e.key === "Enter" && !e.target.matches("textarea")) {
      const openModals = document.querySelectorAll(".modal-backdrop:not(.hidden)");
      if (openModals.length > 0) {
        const last = openModals[openModals.length - 1];
        const primaryBtn = last.querySelector(".btn-primary");
        if (primaryBtn && !primaryBtn.disabled) primaryBtn.click();
      }
    }
  });

  // --- 12. Modal backdrop click to close ---
  document.querySelectorAll(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => {
      if (e.target === bd) closeModal(bd.id);
    });
  });

  // ============================================================
  // PHASE 1f — inputmode="numeric" for all number inputs
  // ============================================================
  document.querySelectorAll('input[type="number"]').forEach((el) => {
    if (!el.getAttribute("inputmode")) el.setAttribute("inputmode", "decimal");
  });

  // ============================================================
  // PHASE 2a — Keyboard accessibility for nav items
  // ============================================================
  document.querySelectorAll(".nav-item").forEach((item) => {
    if (!item.getAttribute("role")) item.setAttribute("role", "button");
    if (!item.hasAttribute("tabindex")) item.setAttribute("tabindex", "0");
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        item.click();
      }
    });
  });

  // ============================================================
  // PHASE 2b + 2c — Modal focus trap & focus restore
  // ============================================================
  let _modalRestoreFocus = null;

  const _origOpenModal = openModal;
  openModal = function (id) {
    _modalRestoreFocus = document.activeElement;
    _origOpenModal(id);
    const backdrop = document.getElementById(id);
    if (!backdrop) return;
    const trapFocus = (e) => {
      if (e.key !== "Tab") return;
      const focusable = backdrop.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    backdrop._trapHandler = trapFocus;
    backdrop.addEventListener("keydown", trapFocus);
  };

  const _origCloseModal = closeModal;
  closeModal = function (id) {
    const backdrop = document.getElementById(id);
    if (backdrop && backdrop._trapHandler) {
      backdrop.removeEventListener("keydown", backdrop._trapHandler);
      delete backdrop._trapHandler;
    }
    _origCloseModal(id);
    if (_modalRestoreFocus && _modalRestoreFocus.focus) {
      try { _modalRestoreFocus.focus(); } catch (_) {}
      _modalRestoreFocus = null;
    }
  };

  boot();
