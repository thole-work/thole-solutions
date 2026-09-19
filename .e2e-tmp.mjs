import { chromium } from 'patchright';

const SITE = 'http://127.0.0.1:8321/';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage();

// No service worker interference in the test.
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
  window.confirm = () => true;
});

const log = [];
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));

const results = {};

try {
  await page.goto(SITE);
  await page.waitForSelector('#auth-screen', { state: 'visible', timeout: 15000 });

  // --- Sign up / create business (restaurant) ---
  await page.evaluate(() => showNewBusiness());
  await sleep(300);
  await page.fill('#nb-name', 'Test Owner');
  await page.fill('#nb-business-name', 'Test Kitchen');
  await page.selectOption('#nb-business-type', 'restaurant');
  await page.fill('#nb-email', 'serve-e2e@test.local');
  await page.fill('#nb-password', 'password123');
  await page.evaluate(() => handleCreateBusiness());

  // Wait for dashboard to become visible
  await page.waitForFunction(() => {
    const ds = document.getElementById('dashboard-screen');
    return ds && !ds.classList.contains('hidden') && (window.membership || document.querySelector('#main-nav'));
  }, { timeout: 20000 }).catch(() => {});
  await sleep(800);

  results.dashboard = await page.evaluate(() => ({
    hasNav: !!document.querySelector('#main-nav'),
    bodyHasApp: document.body.innerHTML.length,
  }));

  // --- Data setup + serve/void test via the app's own helpers ---
  const test = await page.evaluate(async () => {
    const out = {};
    const c = supabase.createClient('http://127.0.0.1:8787', 'test-key');
    const session = c.__getSession();
    if (!session || !session.access_token) { out.error = 'no session'; return out; }

    const { data: biz } = await c.from('businesses').select('id').single();
    const bid = biz.id;
    out.business_id = bid;

    // raw materials
    const tomato = (await c.from('raw_materials').insert([
      { business_id: bid, name: 'Tomato KG', unit: 'kg', stock_qty: 20, cost_per_unit: 2 },
      { business_id: bid, name: 'Cheese KG', unit: 'kg', stock_qty: 10, cost_per_unit: 5 },
    ]).select('id')).data;
    out.tomato_id = tomato[0].id; out.cheese_id = tomato[1].id;

    // recipe product + resale product
    const { data: prods } = await c.from('products').insert([
      { business_id: bid, name: 'Pizza', price: 12, unit: 'plate', product_type: 'recipe', stock_qty: 0, stock_limit: 50 },
      { business_id: bid, name: 'Soda', price: 2, unit: 'pcs', product_type: 'resale', stock_qty: 50 },
    ]).select('id');
    const pizzaId = prods[0].id, sodaId = prods[1].id;
    out.pizza_id = pizzaId; out.soda_id = sodaId;

    // recipe ingredients
    await c.from('recipe_items').insert([
      { product_id: pizzaId, raw_material_id: tomato[0].id, quantity_required: 0.5 },
      { product_id: pizzaId, raw_material_id: tomato[1].id, quantity_required: 0.2 },
    ]);

    // place an order: 2 pizzas + 3 sodas
    const { data: order } = await c.from('orders').insert({
      business_id: bid, status: 'pending', subtotal: 30, total_amount: 30,
      order_type: 'takeout', payment_method: 'cash', created_by: session.user.id,
    }).select().single();
    await c.from('order_items').insert([
      { order_id: order.id, product_id: pizzaId, quantity: 2, unit_price: 12, line_total: 24 },
      { order_id: order.id, product_id: sodaId, quantity: 3, unit_price: 2, line_total: 6 },
    ]);
    out.order_id = order.id;

    // read stocks BEFORE serve
    await new Promise(r => setTimeout(r, 200));
    const readStocks = async () => {
      const mats = await c.from('raw_materials').select('id, stock_qty, kitchen_stock_qty').in('id', tomato.map(t => t.id));
      const prodsQ = await c.from('products').select('id, stock_qty').in('id', [pizzaId, sodaId]);
      return {
        tomato: mats.data.find(m => m.id === tomato[0].id),
        cheese: mats.data.find(m => m.id === tomato[1].id),
        pizza: prodsQ.data.find(p => p.id === pizzaId),
        soda: prodsQ.data.find(p => p.id === sodaId),
      };
    };
    out.before = await readStocks();

    // --- SERVE ---
    await kitchenAdvanceStatus(order.id, 'served');

    // wait for the background updates
    await new Promise(r => setTimeout(r, 600));
    let { data: orderAfter } = await c.from('orders').select('status').eq('id', order.id).single();
    out.after = await readStocks();
    out.servedStatus = orderAfter.status;

    // --- VOID ---
    await voidSale(order.id);
    await new Promise(r => setTimeout(r, 600));
    out.afterVoid = await readStocks();
    let { data: orderVoid } = await c.from('orders').select('status').eq('id', order.id).single();
    out.voidStatus = orderVoid.status;

    // --- Also test the friendlyInsufficient / helper functions exist ---
    out.fn = {
      getServeStockOps: typeof getServeStockOps,
      friendlyInsufficient: typeof friendlyInsufficient,
      adjustStockBatch: typeof adjustStockBatch,
      kitchenAdvanceStatus: typeof kitchenAdvanceStatus,
    };

    return out;
  });

  results.test = test;
} catch (e) {
  results.fatal = String(e);
}

results.consoleErrors = errors.slice(0, 5);
console.log(JSON.stringify(results, null, 2));
await browser.close();