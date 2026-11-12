// Monthly expenses and the P&L (super admin / management only).
//
// P&L for a month:
//   Revenue   = distributor orders dispatched in that month (dispatch plan date), at distributor
//               price. Billing happens in separate software, so dispatch is taken as the sale.
//               Shown gross and net of the GST included in the price.
//   COGS      = packs dispatched × production cost per pack from the MMS — the weighted average
//               of all production of that SKU up to the end of the month.
//   Gross profit = net revenue − COGS
//   Expenses  = the monthly expenses entered on the Expenses screen
//   Net profit   = gross profit − expenses
const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');
const { PACKS_SQL } = require('../services/stock');

const router = express.Router();
router.use(authRequired);
router.use(allowRoles('super_admin', 'management'));

const DEFAULT_CATEGORIES = [
  'Salaries & wages', 'Rent', 'Power & utilities', 'Freight & transport', 'Marketing & promotions',
  'Trade schemes & discounts', 'Repairs & maintenance', 'Office & admin', 'Interest & bank charges', 'Other',
];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- Expenses ----------
router.get('/expenses', async (req, res) => {
  const month = String(req.query.month || '');
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const [rows] = await pool.query(
    'SELECT category, amount, notes FROM monthly_expenses WHERE month = ? ORDER BY id', [month]);
  // categories used before (any month) so custom ones carry forward
  const [used] = await pool.query('SELECT DISTINCT category FROM monthly_expenses');
  const categories = [...new Set([...DEFAULT_CATEGORIES, ...used.map((u) => u.category)])];
  res.json({ month, categories, items: rows.map((r) => ({ ...r, amount: Number(r.amount) })) });
});

router.put('/expenses/:month', async (req, res) => {
  const month = req.params.month;
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const clean = [];
  const seen = new Set();
  for (const it of items) {
    const category = String(it.category || '').replace(/[<>]/g, '').trim().slice(0, 60);
    const amount = Number(it.amount);
    if (!category) continue;
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: `Enter a valid amount for ${category}` });
    if (seen.has(category.toLowerCase())) return res.status(400).json({ error: `${category} is listed twice` });
    seen.add(category.toLowerCase());
    if (amount > 0) clean.push({ category, amount: round2(amount), notes: it.notes ? String(it.notes).replace(/[<>]/g, '').slice(0, 255) : null });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM monthly_expenses WHERE month = ?', [month]);
    for (const c of clean) {
      await conn.query('INSERT INTO monthly_expenses (month, category, amount, notes, updated_by) VALUES (?, ?, ?, ?, ?)',
        [month, c.category, c.amount, c.notes, req.user.id]);
    }
    await conn.commit();
    res.json({ ok: true, total: round2(clean.reduce((a, c) => a + c.amount, 0)) });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: 'Could not save expenses' });
  } finally {
    conn.release();
  }
});

// ---------- P&L ----------
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 36) break;
  }
  return out;
}
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

router.get('/pnl', async (req, res) => {
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to) || from > to) return res.status(400).json({ error: 'from and to must be YYYY-MM, from ≤ to' });
  const months = monthsBetween(from, to);
  const start = `${from}-01`, end = monthEnd(to);

  // Sales: dispatched distributor orders by dispatch month
  const [sales] = await pool.query(
    `SELECT DATE_FORMAT(dp.plan_date, '%Y-%m') AS month, l.product_id, o.distributor_id, d.name AS distributor_name,
            d.territory_id, t.name AS territory_name, p.sku_code, p.name AS product_name,
            SUM(l.qty) AS packs, SUM(l.net_amount) AS gross, SUM(l.gst_amt) AS gst
     FROM distributor_order_lines l
     JOIN distributor_orders o ON o.id = l.order_id
     JOIN dispatch_plans dp ON dp.id = o.dispatch_plan_id
     JOIN distributors d ON d.id = o.distributor_id
     LEFT JOIN territories t ON t.id = d.territory_id
     JOIN products p ON p.id = l.product_id
     WHERE o.status IN ('dispatched','delivered') AND dp.plan_date BETWEEN ? AND ?
     GROUP BY month, l.product_id, o.distributor_id`,
    [start, end]
  );

  // Production (linked SKUs) — for cost per pack and the production summary
  const [prod] = await pool.query(
    `SELECT mp.product_id, DATE_FORMAT(pb.batch_date, '%Y-%m-%d') AS batch_date, ${PACKS_SQL} AS packs, pb.total_cost
     FROM production_batches pb JOIN mms_products mp ON mp.mms_product_id = pb.mms_product_id
     WHERE mp.product_id IS NOT NULL ORDER BY pb.batch_date`
  );
  // Weighted average cost per pack of a SKU, using production up to a date
  function avgCost(productId, uptoDate) {
    let packs = 0, cost = 0;
    for (const b of prod) {
      if (b.product_id !== productId) continue;
      if (b.batch_date > uptoDate) break;
      packs += Number(b.packs); cost += Number(b.total_cost);
    }
    return packs > 0 ? cost / packs : null;
  }
  function firstCost(productId) { // fallback: SKU sold before its first recorded batch
    let packs = 0, cost = 0;
    for (const b of prod) if (b.product_id === productId) { packs += Number(b.packs); cost += Number(b.total_cost); }
    return packs > 0 ? cost / packs : null;
  }

  const [exp] = await pool.query(
    'SELECT month, category, SUM(amount) AS amount FROM monthly_expenses WHERE month BETWEEN ? AND ? GROUP BY month, category',
    [from, to]
  );

  const blank = () => ({ revenue_gross: 0, gst: 0, revenue_net: 0, cogs: 0, packs: 0, uncosted_revenue: 0 });
  const byMonth = Object.fromEntries(months.map((m) => [m, { month: m, ...blank(), expenses: {}, expenses_total: 0, produced_packs: 0, production_cost: 0 }]));
  const bySku = {}, byDist = {}, byTerr = {};
  const uncostedSkus = new Set();
  const add = (map, key, base, s) => {
    if (!map[key]) map[key] = { ...base, ...blank() };
    const r = map[key];
    r.packs += s.packs; r.revenue_gross += s.gross; r.gst += s.gst; r.revenue_net += s.net; r.cogs += s.cogs;
  };

  for (const row of sales) {
    const packs = Number(row.packs), gross = Number(row.gross), gst = Number(row.gst);
    const net = gross - gst;
    let unit = avgCost(row.product_id, monthEnd(row.month));
    if (unit == null) unit = firstCost(row.product_id);
    const cogs = unit == null ? 0 : packs * unit;
    if (unit == null) uncostedSkus.add(`${row.product_name} (${row.sku_code})`);
    const s = { packs, gross, gst, net, cogs };
    const m = byMonth[row.month];
    if (m) { m.packs += packs; m.revenue_gross += gross; m.gst += gst; m.revenue_net += net; m.cogs += cogs; if (unit == null) m.uncosted_revenue += net; }
    add(bySku, row.product_id, { sku_code: row.sku_code, name: row.product_name }, s);
    add(byDist, row.distributor_id, { name: row.distributor_name, territory: row.territory_name }, s);
    add(byTerr, row.territory_id || 0, { name: row.territory_name || 'No territory' }, s);
  }
  for (const e of exp) {
    const m = byMonth[e.month];
    if (!m) continue;
    m.expenses[e.category] = Number(e.amount);
    m.expenses_total += Number(e.amount);
  }
  for (const b of prod) {
    const m = byMonth[b.batch_date.slice(0, 7)];
    if (m) { m.produced_packs += Number(b.packs); m.production_cost += Number(b.total_cost); }
  }

  const finish = (r) => {
    const gp = r.revenue_net - r.cogs;
    const out = { ...r, gross_profit: gp, gross_margin_pct: r.revenue_net ? (gp / r.revenue_net) * 100 : null };
    for (const k of ['revenue_gross', 'gst', 'revenue_net', 'cogs', 'gross_profit', 'packs']) out[k] = round2(out[k]);
    return out;
  };
  const monthsOut = months.map((m) => {
    const r = finish(byMonth[m]);
    r.net_profit = round2(r.gross_profit - r.expenses_total);
    r.net_margin_pct = r.revenue_net ? (r.net_profit / r.revenue_net) * 100 : null;
    r.expenses_total = round2(r.expenses_total);
    return r;
  });
  const totals = monthsOut.reduce((a, m) => {
    for (const k of ['revenue_gross', 'gst', 'revenue_net', 'cogs', 'gross_profit', 'expenses_total', 'net_profit', 'packs', 'produced_packs', 'production_cost']) a[k] = (a[k] || 0) + m[k];
    for (const [c, v] of Object.entries(m.expenses)) a.expenses[c] = (a.expenses[c] || 0) + v;
    return a;
  }, { expenses: {} });
  totals.gross_margin_pct = totals.revenue_net ? (totals.gross_profit / totals.revenue_net) * 100 : null;
  totals.net_margin_pct = totals.revenue_net ? (totals.net_profit / totals.revenue_net) * 100 : null;

  const [[link]] = await pool.query("SELECT COUNT(*) AS unlinked FROM mms_products WHERE active = 1 AND product_id IS NULL");
  const sortDesc = (o) => Object.values(o).map(finish).sort((a, b) => b.revenue_net - a.revenue_net);
  res.json({
    from, to,
    months: monthsOut,
    totals,
    expense_categories: [...new Set(monthsOut.flatMap((m) => Object.keys(m.expenses)))],
    by_sku: sortDesc(bySku),
    by_distributor: sortDesc(byDist),
    by_territory: sortDesc(byTerr),
    warnings: {
      uncosted_skus: [...uncostedSkus],
      unlinked_mms_products: link.unlinked,
      months_without_expenses: monthsOut.filter((m) => !m.expenses_total).map((m) => m.month),
    },
  });
});

module.exports = router;
