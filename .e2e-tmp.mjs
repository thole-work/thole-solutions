import { chromium } from 'patchright';
import { writeFileSync } from 'fs';
import { spawn } from 'child_process';
import net from 'net';

const SITE = 'http://127.0.0.1:8321/';
const RESULT_PATH = '/tmp/opencode/e2e-result.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- ensure a static server is up on 8321 -----------------------------------
const serverReachable = () =>
  new Promise((resolve) => {
    const s = net.connect(8321, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });

let httpProc = null;
if (!(await serverReachable())) {
  httpProc = spawn('python3', ['-m', 'http.server', '8321'], { cwd: process.cwd(), stdio: 'ignore' });
  for (let i = 0; i < 30; i++) { await sleep(200); if (await serverReachable()) break; }
}

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();

// No service worker interference, and auto-confirm dialogs in the MAIN world.
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
  window.confirm = () => true;
});

const errors = [];
const badResponses = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
page.on('response', async (r) => {
  if (r.status() >= 400 && r.url().includes('supabase.co')) {
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch (_) {}
    badResponses.push({ status: r.status(), url: r.url().slice(0, 180).replace(/^.+supabase\.co/, 'supabase.co'), body });
  }
});

const results = {};

// ---------------------------------------------------------------------------
// Main-world test that exercises the app's kitchen + stock logic against the
// real Supabase backend (the app's own `sb` client + internal functions).
// Runs as a classic <script> in the main world, so it can call them directly.
// ---------------------------------------------------------------------------
const TESTCODE = `
window.__E2E__ = async function () {
  const out = { steps: {}, insertErrors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ins = async (t, rows) => {
    const { error } = await sb.from(t).insert(rows);
    if (error) out.insertErrors.push({ table: t, message: error.message, hint: error.hint, code: error.code });
    return !error;
  };
  const readStocks = async (bid, matIds, prodIds) => {
    const { data: mats } = await sb.from('raw_materials').select('id, name, stock_qty, kitchen_stock_qty').in('id', matIds);
    const { data: prods } = await sb.from('products').select('id, name, stock_qty').in('id', prodIds);
    const s = {};
    (mats || []).forEach(function (m) { s[m.name] = { stock: Number(m.stock_qty || 0), kitchen: Number(m.kitchen_stock_qty || 0) }; });
    (prods || []).forEach(function (p) { s[p.name] = { stock: Number(p.stock_qty || 0) }; });
    return s;
  };
  try {
    // If the live project's RLS hides business_types, the app can't resolve the
    // business type and hides the kitchen/materials/produce UI. Detect that and
    // simulate the resolved type so the full logic chain still runs — the RLS
    // gap is reported separately (see database/business_types_rls_fix.sql).
    const gateBroken = businessTypeKey === null || businessModules === null;
    out.steps.gateBroken = gateBroken;
    if (gateBroken) {
      businessTypeKey = 'restaurant';
      businessModules = new Set(['kitchen', 'inventory', 'production', 'sales', 'tables', 'pos']);
    }
    await loadProducts(); await loadMaterials();
    const bid = membership.business_id;
    const uid = currentUser.id;

    const m1 = (await sb.from('raw_materials').insert({ business_id: bid, name: 'Tomato KG', unit: 'kg', stock_qty: 20, kitchen_stock_qty: 5, cost_per_unit: 2 }).select('id').single()).data;
    const m2 = (await sb.from('raw_materials').insert({ business_id: bid, name: 'Cheese KG', unit: 'kg', stock_qty: 10, kitchen_stock_qty: 3, cost_per_unit: 5 }).select('id').single()).data;
    const pRecipe = (await sb.from('products').insert({ business_id: bid, name: 'Pizza', price: 12, unit: 'plate', product_type: 'recipe', stock_qty: 0, stock_limit: 50, is_active: true }).select('id').single()).data;
    const pResale = (await sb.from('products').insert({ business_id: bid, name: 'Soda', price: 2, unit: 'pcs', product_type: 'resale', stock_qty: 50, is_active: true }).select('id').single()).data;
    const pMfg = (await sb.from('products').insert({ business_id: bid, name: 'Dough', price: 5, unit: 'kg', product_type: 'manufactured', stock_qty: 0, is_active: true }).select('id').single()).data;
    await ins('recipe_items', [
      { product_id: pRecipe.id, raw_material_id: m1.id, quantity_required: 0.5 },
      { product_id: pRecipe.id, raw_material_id: m2.id, quantity_required: 0.2 },
      { product_id: pMfg.id, raw_material_id: m1.id, quantity_required: 0.8 }
    ]);
    await loadProducts(); await loadMaterials();
    out.steps.appCache = { products: cache.products.length, materials: cache.materials.length };
    const memBiz = membership.businesses;
    out.steps.modules = {
      typeKey: businessTypeKey,
      modules: businessModules ? Array.from(businessModules) : null,
      tabKitchen: tabEnabled('kitchen'),
      tabMaterials: tabEnabled('materials'),
      usesRawMats: businessUsesRawMaterials(),
      memType: memBiz && memBiz.business_types ? memBiz.business_types.type_key : null,
      memTypeId: memBiz && memBiz.business_types ? memBiz.business_types.id : (memBiz || {}).business_type_id,
      memModuleRows: memBiz && memBiz.business_types ? (memBiz.business_types.business_type_modules || []).map(function (r) { return r.module_key; }) : null
    };
    const btid = out.steps.modules.memTypeId;
    if (btid) {
      const { data: liveMods } = await sb.from('business_type_modules').select('business_type_id, module_key').eq('business_type_id', btid);
      out.steps.liveModules = (liveMods || []).map(r => r.module_key);
    }
    const { data: allTypes } = await sb.from('business_types').select('id, type_key, display_name').limit(10);
    const { data: allMods } = await sb.from('business_type_modules').select('business_type_id, module_key').limit(30);
    out.steps.directTypes = { count: (allTypes || []).length, sample: (allTypes || [])[0] || null };
    out.steps.directMods = { count: (allMods || []).length, sample: (allMods || [])[0] || null };
    const { data: bizInfo } = await sb.from('businesses').select('id, name, business_type_id').eq('id', bid).single();
    out.steps.bizInfo = bizInfo;

    out.steps.baseline = await readStocks(bid, [m1.id, m2.id], [pRecipe.id, pResale.id, pMfg.id]);
    out.ids = { m1: m1.id, m2: m2.id, pRecipe: pRecipe.id, pResale: pResale.id, pMfg: pMfg.id };

    // place an order: 2 pizzas (recipe) + 3 sodas (resale) — line_total is a
    // generated column on Supabase, so it stays out of the insert.
    const order = (await sb.from('orders').insert({ business_id: bid, status: 'pending', subtotal: 30, total_amount: 30, order_type: 'takeout', payment_method: 'cash', created_by: uid }).select().single()).data;
    await ins('order_items', [
      { order_id: order.id, product_id: pRecipe.id, quantity: 2, unit_price: 12 },
      { order_id: order.id, product_id: pResale.id, quantity: 3, unit_price: 2 }
    ]);

    // kitchen tab renders the pipeline/tables/stock
    switchTab('kitchen');
    await sleep(2000);
    out.steps.kitchenDOM = {
      tabKitchenVisible: !document.getElementById('tab-kitchen').classList.contains('hidden'),
      pipelinePresent: !!document.getElementById('pipeline-pending'),
      kitchenOrdersSize: kitchenOrders.size,
      orderCards: document.querySelectorAll('.pipeline-card').length,
      tableCards: document.querySelectorAll('.kitchen-table-card').length,
      stockCards: document.querySelectorAll('.kitchen-stock-card').length
    };

    // SERVE — deduct soda stock (store), pizza recipe ingredients (kitchen-first)
    await kitchenAdvanceStatus(order.id, 'served');
    await sleep(1500);
    out.steps.afterServe = await readStocks(bid, [m1.id, m2.id], [pRecipe.id, pResale.id, pMfg.id]);
    out.steps.servedStatus = (await sb.from('orders').select('status').eq('id', order.id).single()).data.status;

    // VOID — restore stock
    await voidSale(order.id);
    await sleep(1500);
    out.steps.afterVoid = await readStocks(bid, [m1.id, m2.id], [pRecipe.id, pResale.id, pMfg.id]);
    out.steps.voidedStatus = (await sb.from('orders').select('status').eq('id', order.id).single()).data.status;

    // SEND TO KITCHEN — store -> kitchen transfer, rollback kept
    openSendToKitchenModal(m1.id);
    document.getElementById('send-kitchen-qty').value = '2';
    await submitSendToKitchen();
    await sleep(1000);
    out.steps.afterSendToKitchen = await readStocks(bid, [m1.id, m2.id], [pRecipe.id, pResale.id, pMfg.id]);

    // PRODUCE — manufacture 2kg Dough (recipe: 0.8 tomato/kg) and bump stock
    openProduceModal();
    document.getElementById('prod-product').value = pMfg.id;
    document.getElementById('prod-planned-qty').value = '2';
    document.getElementById('prod-actual-yield').value = '2';
    await submitProduce();
    await sleep(1000);
    out.steps.afterProduce = await readStocks(bid, [m1.id, m2.id], [pRecipe.id, pResale.id, pMfg.id]);
  } catch (e) {
    out.fatal = String((e && (e.stack || e.message)) || e);
  }
  return out;
};
;(async () => {
  try {
    const r = await window.__E2E__();
    document.body.setAttribute('data-e2e', JSON.stringify(r));
  } catch (e) {
    document.body.setAttribute('data-e2e', JSON.stringify({ fatal: String(e) }));
  }
})();
`;

try {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth-screen', { state: 'visible', timeout: 30000 });

  // --- Sign up / create business (restaurant) via the real UI ---
  await page.click('a[onclick="showNewBusiness()"]');
  const email = 'serve-e2e-' + Date.now() + '@test.local';
  await page.fill('#nb-name', 'Test Owner');
  await page.fill('#nb-business-name', 'Test Kitchen');
  await page.selectOption('#nb-business-type', 'restaurant');
  await page.fill('#nb-email', email);
  await page.fill('#nb-password', 'password123');
  await page.click('#nb-create-btn');

  // Either the invite-reveal screen (success) or an auth error surfaces.
  await page.waitForSelector('#invite-reveal-screen, #auth-error:not(.hidden)', { state: 'visible', timeout: 30000 });
  const revealShown = await page.evaluate(() => !document.getElementById('invite-reveal-screen').classList.contains('hidden'));
  if (!revealShown) {
    results.signup = { error: await page.evaluate(() => document.getElementById('auth-error').innerText) };
  } else {
    results.signup = { ok: true, email };
    await page.click('#invite-reveal-screen .btn-primary');
    await page.waitForSelector('#app-screen:not(.hidden)', { state: 'visible', timeout: 30000 });
  }

  if (!results.signup || !results.signup.ok) {
    results.verdict = 'SIGNUP_BLOCKED';
  } else {
    // --- Run kitchen/stock logic against Supabase ---
    await page.addScriptTag({ content: TESTCODE });
    const got = await page
      .waitForFunction(() => document.body.getAttribute('data-e2e') !== null, { timeout: 120000 })
      .catch(() => null);
    if (!got) {
      results.verdict = 'TIMEOUT_WAITING_TEST';
    } else {
      const raw = await page.evaluate(() => document.body.getAttribute('data-e2e'));
      results.test = JSON.parse(raw);

      // -- Assertions (postgres floats, tolerant compare) --
      const approx = (a, b) => Math.abs(a - b) < 0.15;
      const s = results.test.steps;
      const checks = [];
      if (s.baseline && s.afterServe && s.afterVoid) {
        const b = s.baseline, a = s.afterServe, v = s.afterVoid;
        // SERVE: Soda 50 -> 47
        checks.push(['serve: Soda 50->47', approx(a.Soda.stock, 47), 'got ' + a.Soda.stock]);
        // SERVE: Pizza recipe consumes ingredients kitchen-first
        checks.push(['serve: Tomato kitchen 5->4', approx(a['Tomato KG'].kitchen, 4), JSON.stringify(a['Tomato KG'])]);
        checks.push(['serve: Tomato store unchanged 20', approx(a['Tomato KG'].stock, 20), JSON.stringify(a['Tomato KG'])]);
        checks.push(['serve: Cheese kitchen 3->2.6', approx(a['Cheese KG'].kitchen, 2.6), JSON.stringify(a['Cheese KG'])]);
        checks.push(['serve: Cheese store unchanged 10', approx(a['Cheese KG'].stock, 10), JSON.stringify(a['Cheese KG'])]);
        // VOID: everything back to baseline
        checks.push(['void: Soda restored 50', approx(v.Soda.stock, 50), JSON.stringify(v.Soda)]);
        checks.push(['void: Tomato restored 20/5', approx(v['Tomato KG'].stock, 20) && approx(v['Tomato KG'].kitchen, 5), JSON.stringify(v['Tomato KG'])]);
        checks.push(['void: Cheese restored 10/3', approx(v['Cheese KG'].stock, 10) && approx(v['Cheese KG'].kitchen, 3), JSON.stringify(v['Cheese KG'])]);
        checks.push(['serve status=served', s.servedStatus === 'served', String(s.servedStatus)]);
        checks.push(['void status=voided', s.voidedStatus === 'voided', String(s.voidedStatus)]);
      }
      if (s.afterSendToKitchen) {
        const t = s.afterSendToKitchen['Tomato KG'];
        checks.push(['sendToKitchen: Tomato store 20->18', approx(t.stock, 18), JSON.stringify(t)]);
        checks.push(['sendToKitchen: Tomato kitchen 5->7', approx(t.kitchen, 7), JSON.stringify(t)]);
      }
      if (s.afterProduce) {
        const p = s.afterProduce;
        checks.push(['produce: Dough stock 0->2', approx(p.Dough.stock, 2), JSON.stringify(p.Dough)]);
        checks.push(['produce: Tomato store 18->16.4', approx(p['Tomato KG'].stock, 16.4), JSON.stringify(p['Tomato KG'])]);
        checks.push(['produce: kitchen untouched 7', approx(p['Tomato KG'].kitchen, 7), JSON.stringify(p['Tomato KG'])]);
      }
      checks.push(['kitchen DOM pipeline rendered', !!(s.kitchenDOM && s.kitchenDOM.pipelinePresent), JSON.stringify(s.kitchenDOM)]);
      checks.push(['kitchen DOM shows 1 order card', !!(s.kitchenDOM && (s.kitchenDOM.orderCards >= 1 || s.kitchenDOM.kitchenOrdersSize >= 1)), JSON.stringify(s.kitchenDOM)]);
      checks.push(['kitchen tab actually visible', !!(s.kitchenDOM && s.kitchenDOM.tabKitchenVisible), JSON.stringify(s.kitchenDOM)]);
      results.checks = checks;
      results.failedChecks = checks.filter((c) => !c[1]);
      results.dbFixNeeded = results.test.steps.gateBroken === true;
      const logicOk = !results.test.fatal && results.failedChecks.length === 0 && results.test.insertErrors.length === 0;
      results.verdict = logicOk ? 'PASS' : 'FAIL';
    }
  }
} catch (e) {
  results.fatal = String(e);
  results.verdict = 'CRASH';
}

results.consoleErrors = errors.slice(0, 5);
results.badResponses = badResponses.slice(0, 20);
const outTxt = JSON.stringify(results, null, 2);
console.log(outTxt);
writeFileSync(RESULT_PATH, outTxt);

await browser.close();
if (httpProc) { try { httpProc.kill(); } catch (_) {} }