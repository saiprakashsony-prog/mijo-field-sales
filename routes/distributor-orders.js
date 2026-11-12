// Distributor (primary) orders — the stock a distributor buys from MIJO.
//
//  Who books:    ASM and SO for distributors in their area; admin roles for any distributor.
//  Who sees:     admin roles: all · RM / ASM / SO: their area · distributor login: its own.
//  Status flow:  submitted → approved → dispatch_planned → dispatched → delivered
//                submitted → rejected (admin) | cancelled (admin, or the booker while still submitted)
//  The dispatch_planned / dispatched / delivered steps are driven by the Dispatch Planner
//  (routes/dispatch.js), which links approved orders to a dispatch plan.
const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const { safeMsg } = require('../middleware/safeError');
const { isAreaManager, areaDistributorIds, inList } = require('../middleware/scope');

const router = express.Router();
router.use(authRequired);

const ADMINS = ['super_admin', 'management', 'sales_manager'];
const BOOKER_LEVELS = ['ASM', 'SO'];
const isAdmin = (u) => ADMINS.includes(u.role);
const canBook = (u) => isAdmin(u) || (u.role === 'field_employee' && BOOKER_LEVELS.includes(u.level));

// Distributor ids this user may see; null = all.
async function visibleDistributors(req) {
  if (isAdmin(req.user)) return null;
  if (isAreaManager(req.user)) return inList(await areaDistributorIds(req));
  if (req.user.role === 'distributor') return [req.user.distributor_id];
  return [];
}

function genOrderNo() {
  return 'MIJO/DO/' + Date.now().toString().slice(-9);
}
const round2 = (n) => Math.round(n * 100) / 100;
// Same price chain as products.js: MRP → Retailer Price → Distributor Price (all GST-inclusive)
function distributorPrice(p) {
  const retailer = round2(Number(p.mrp) * (1 - Number(p.retailer_margin_pct) / 100));
  return round2(retailer * (1 - Number(p.distributor_margin_pct) / 100));
}

// Distributors the user can book for (drop-down on the order form)
router.get('/distributors', async (req, res) => {
  if (!canBook(req.user)) return res.status(403).json({ error: 'Not permitted for this role' });
  const ids = await visibleDistributors(req);
  const [rows] = await pool.query(
    `SELECT d.id, d.code, d.name, t.name AS territory_name
     FROM distributors d LEFT JOIN territories t ON t.id = d.territory_id
     WHERE d.status = 'active' ${ids ? 'AND d.id IN (?)' : ''}
     ORDER BY d.name`,
    ids ? [ids] : []
  );
  res.json(rows);
});

router.get('/', async (req, res) => {
  const ids = await visibleDistributors(req);
  if (ids && !ids.length) return res.status(403).json({ error: 'Not permitted for this role' });
  const where = [];
  const params = [];
  if (ids) { where.push('o.distributor_id IN (?)'); params.push(ids); }
  if (req.query.status) { where.push('o.status = ?'); params.push(req.query.status); }
  if (req.query.distributor_id) { where.push('o.distributor_id = ?'); params.push(req.query.distributor_id); }
  const [rows] = await pool.query(
    `SELECT o.id, o.order_no, DATE_FORMAT(o.order_date, '%Y-%m-%d') AS order_date, o.status, o.total_cartons, o.total_amount,
            o.notes, o.review_note, o.dispatch_plan_id, o.created_at, o.distributor_id, o.booked_by_user,
            d.name AS distributor_name, d.code AS distributor_code, t.name AS territory_name,
            COALESCE(e.name, u.name) AS booked_by_name, e.designation AS booked_by_designation,
            p.plan_no AS dispatch_plan_no
     FROM distributor_orders o
     JOIN distributors d ON d.id = o.distributor_id
     LEFT JOIN territories t ON t.id = d.territory_id
     LEFT JOIN employees e ON e.id = o.booked_by_employee
     LEFT JOIN users u ON u.id = o.booked_by_user
     LEFT JOIN dispatch_plans p ON p.id = o.dispatch_plan_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.id DESC
     LIMIT 300`,
    params
  );
  res.json(rows);
});

// Approved orders not yet on a dispatch plan, totalled per distributor — feeds the Dispatch Planner
router.get('/ready-for-dispatch', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Not permitted for this role' });
  const [rows] = await pool.query(
    `SELECT o.distributor_id, SUM(o.total_cartons) AS cartons, GROUP_CONCAT(o.id ORDER BY o.id) AS order_ids,
            GROUP_CONCAT(o.order_no ORDER BY o.id SEPARATOR ', ') AS order_nos
     FROM distributor_orders o
     WHERE o.status = 'approved' AND o.dispatch_plan_id IS NULL
     GROUP BY o.distributor_id`
  );
  res.json(rows.map((r) => ({ ...r, cartons: Number(r.cartons), order_ids: String(r.order_ids).split(',').map(Number) })));
});

router.get('/:id', async (req, res) => {
  const ids = await visibleDistributors(req);
  const [[order]] = await pool.query(
    `SELECT o.*, DATE_FORMAT(o.order_date, '%Y-%m-%d') AS order_date, d.name AS distributor_name, d.code AS distributor_code,
            COALESCE(e.name, u.name) AS booked_by_name, p.plan_no AS dispatch_plan_no
     FROM distributor_orders o
     JOIN distributors d ON d.id = o.distributor_id
     LEFT JOIN employees e ON e.id = o.booked_by_employee
     LEFT JOIN users u ON u.id = o.booked_by_user
     LEFT JOIN dispatch_plans p ON p.id = o.dispatch_plan_id
     WHERE o.id = ?`,
    [req.params.id]
  );
  if (!order || (ids && !ids.includes(order.distributor_id))) return res.status(404).json({ error: 'Not found' });
  const [lines] = await pool.query(
    `SELECT l.*, p.name AS product_name, p.sku_code, p.pack_size, p.units_per_carton
     FROM distributor_order_lines l JOIN products p ON p.id = l.product_id
     WHERE l.order_id = ? ORDER BY l.id`,
    [order.id]
  );
  res.json({ ...order, lines });
});

router.post('/', async (req, res) => {
  if (!canBook(req.user)) return res.status(403).json({ error: 'Only an ASM, Sales Officer or admin can place distributor orders' });
  const distributorId = Number(req.body.distributor_id);
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!distributorId) return res.status(400).json({ error: 'Select a distributor' });
  if (!lines.length) return res.status(400).json({ error: 'Add at least one product' });
  if (lines.length > 100) return res.status(400).json({ error: 'Too many lines in one order' });

  const ids = await visibleDistributors(req);
  if (ids && !ids.includes(distributorId)) return res.status(403).json({ error: 'This distributor is not in your area' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[dist]] = await conn.query("SELECT id, status FROM distributors WHERE id = ?", [distributorId]);
    if (!dist) throw new Error('Distributor not found');
    if (dist.status !== 'active') throw new Error('This distributor is inactive');

    const productIds = [...new Set(lines.map((l) => Number(l.product_id)))];
    if (productIds.length !== lines.length) throw new Error('The same product appears twice — combine the quantities into one line');
    const [products] = await conn.query('SELECT * FROM products WHERE id IN (?)', [productIds]);
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));

    let totalAmount = 0, totalCartons = 0;
    const computed = lines.map((l) => {
      const p = byId[Number(l.product_id)];
      if (!p) throw new Error('A selected product no longer exists');
      if (p.status !== 'active') throw new Error(`${p.name} is inactive`);
      const cartons = Math.max(0, Math.floor(Number(l.carton_qty) || 0));
      const packs = Math.max(0, Math.floor(Number(l.pack_qty) || 0));
      const upc = Number(p.units_per_carton) || 1;
      const qty = cartons * upc + packs;
      if (!qty) throw new Error(`Enter a quantity for ${p.name}`);
      const rate = distributorPrice(p);
      const net = round2(qty * rate);
      const gstPct = Number(p.gst_pct) || 0;
      const gst = round2(net - net / (1 + gstPct / 100)); // embedded tax, informational only
      totalAmount += net;
      totalCartons += qty / upc;
      return { product_id: p.id, carton_qty: cartons, pack_qty: packs, qty, rate, gst, net };
    });

    const orderNo = genOrderNo();
    const [r] = await conn.query(
      `INSERT INTO distributor_orders (order_no, order_date, distributor_id, booked_by_employee, booked_by_user, total_cartons, total_amount, notes)
       VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?)`,
      [orderNo, distributorId, req.user.employee_id || null, req.user.id, round2(totalCartons), round2(totalAmount),
        req.body.notes ? String(req.body.notes).replace(/[<>]/g, '').slice(0, 255) : null]
    );
    for (const c of computed) {
      await conn.query(
        `INSERT INTO distributor_order_lines (order_id, product_id, carton_qty, pack_qty, qty, rate, gst_amt, net_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.insertId, c.product_id, c.carton_qty, c.pack_qty, c.qty, c.rate, c.gst, c.net]
      );
    }
    await conn.commit();
    res.status(201).json({ id: r.insertId, order_no: orderNo, total_amount: round2(totalAmount), total_cartons: round2(totalCartons) });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: safeMsg(e) });
  } finally {
    conn.release();
  }
});

// Approve / reject / cancel. Dispatch-related statuses are set by the Dispatch Planner, except
// "delivered" which an admin can also set directly.
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  const note = req.body.note ? String(req.body.note).replace(/[<>]/g, '').slice(0, 255) : null;
  const [[order]] = await pool.query('SELECT * FROM distributor_orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Not found' });

  const admin = isAdmin(req.user);
  const ownSubmitted = order.booked_by_user === req.user.id && order.status === 'submitted';
  const allowed = {
    approved: admin && order.status === 'submitted',
    rejected: admin && order.status === 'submitted',
    cancelled: (admin && ['submitted', 'approved'].includes(order.status)) || (status === 'cancelled' && ownSubmitted),
    delivered: admin && ['dispatch_planned', 'dispatched'].includes(order.status),
  };
  if (!allowed[status]) {
    return res.status(400).json({ error: `Can't change an order from "${order.status.replace('_', ' ')}" to "${String(status).replace('_', ' ')}"` });
  }
  await pool.query(
    `UPDATE distributor_orders SET status = ?, review_note = COALESCE(?, review_note),
       reviewed_by = IF(? IN ('approved','rejected'), ?, reviewed_by),
       reviewed_at = IF(? IN ('approved','rejected'), NOW(), reviewed_at)
     WHERE id = ?`,
    [status, note, status, req.user.id, status, order.id]
  );
  await pool.query(
    `INSERT INTO audit_log (entity_type, entity_id, action, changed_by, after_json) VALUES ('distributor_order', ?, 'status', ?, ?)`,
    [order.id, req.user.id, JSON.stringify({ from: order.status, to: status, note })]
  );
  res.json({ ok: true });
});

module.exports = router;
