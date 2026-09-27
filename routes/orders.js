const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const STATUS_FLOW = ['submitted', 'accepted', 'picking', 'packing', 'ready_for_dispatch', 'dispatched', 'delivered'];
// Statuses at/after which an order is locked from line edits (BRD 19 "employee cannot edit after configured lock status")
const LOCK_AT = 'accepted';

function genOrderNo() {
  return 'MIJO/ORD/' + Date.now().toString().slice(-9);
}

router.get('/', async (req, res) => {
  const { distributor_id, employee_id, retailer_id, status, date, from, to } = req.query;
  const where = [];
  const params = [];
  if (distributor_id) { where.push('o.distributor_id = ?'); params.push(distributor_id); }
  if (employee_id) { where.push('o.employee_id = ?'); params.push(employee_id); }
  if (retailer_id) { where.push('o.retailer_id = ?'); params.push(retailer_id); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (date) { where.push('o.order_date = ?'); params.push(date); }
  if (from && to) { where.push('o.order_date BETWEEN ? AND ?'); params.push(from, to); }

  // Role scoping: a distributor login only sees its own orders; a field employee only sees its own
  if (req.user.role === 'distributor') { where.push('o.distributor_id = ?'); params.push(req.user.distributor_id); }
  if (req.user.role === 'field_employee') { where.push('o.employee_id = ?'); params.push(req.user.employee_id); }

  const [rows] = await pool.query(
    `SELECT o.*, r.name AS retailer_name, r.code AS retailer_code, e.name AS employee_name, d.name AS distributor_name
     FROM orders o
     JOIN retailers r ON r.id = o.retailer_id
     JOIN employees e ON e.id = o.employee_id
     JOIN distributors d ON d.id = o.distributor_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.created_at DESC`,
    params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const [[order]] = await pool.query(
    `SELECT o.*, r.name AS retailer_name, r.address AS retailer_address, e.name AS employee_name, d.name AS distributor_name
     FROM orders o
     JOIN retailers r ON r.id = o.retailer_id
     JOIN employees e ON e.id = o.employee_id
     JOIN distributors d ON d.id = o.distributor_id
     WHERE o.id = ?`,
    [req.params.id]
  );
  if (!order) return res.status(404).json({ error: 'Not found' });
  const [lines] = await pool.query(
    `SELECT ol.*, p.name AS product_name, p.sku_code, p.pack_size FROM order_lines ol
     JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ?`,
    [req.params.id]
  );
  const [history] = await pool.query('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY changed_at', [req.params.id]);
  res.json({ ...order, lines, history });
});

// Create order: auto-routes to the retailer's mapped distributor (BRD 8, 19)
router.post('/', async (req, res) => {
  const { retailer_id, visit_id, lines } = req.body;
  if (!retailer_id || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'retailer_id and at least one order line are required' });
  }
  const employeeId = req.user.employee_id || req.body.employee_id;
  if (!employeeId) return res.status(400).json({ error: 'Logged-in user has no linked employee record' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[retailer]] = await conn.query('SELECT id, distributor_id FROM retailers WHERE id = ?', [retailer_id]);
    if (!retailer) throw new Error('Retailer not found');
    const distributorId = retailer.distributor_id; // auto-routed, not chosen by the employee

    const productIds = lines.map((l) => l.product_id);
    const [products] = await conn.query(`SELECT * FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`, productIds);
    const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

    // All prices are GST-inclusive: the retailer order is billed at Retailer Price
    // (MRP marked down by retailer_margin_pct) with no GST added on top. gst_amt is
    // stored purely as the informational tax portion embedded within that price, for
    // invoice/reporting display — it never changes what's actually charged.
    // A line can be ordered as full cartons, loose packs, or both — qty (the base unit
    // pricing runs on) is always resolved to total packs: carton_qty * units_per_carton + pack_qty.
    let total = 0;
    const computedLines = lines.map((l) => {
      const p = productMap[l.product_id];
      if (!p) throw new Error(`Product ${l.product_id} not found`);
      const cartonQty = Number(l.carton_qty || 0);
      const packQty = Number(l.pack_qty != null ? l.pack_qty : l.qty || 0); // l.qty kept for backward compatibility
      const unitsPerCarton = Number(p.units_per_carton) || 1;
      const qty = cartonQty * unitsPerCarton + packQty;
      if (!qty || qty <= 0) throw new Error(`Invalid quantity for ${p.name}`);
      const retailerPrice = Math.round(Number(p.mrp) * (1 - Number(p.retailer_margin_pct) / 100) * 100) / 100;
      const rate = retailerPrice;
      const discount = Number(l.discount_amt || 0);
      const net = Math.round((qty * rate - discount) * 100) / 100;
      const gstPct = Number(p.gst_pct);
      const gst = Math.round((net - net / (1 + gstPct / 100)) * 100) / 100; // embedded tax, informational only
      total += net;
      return { product_id: p.id, qty, carton_qty: cartonQty, pack_qty: packQty, rate, discount_amt: discount, gst_amt: gst, net_amount: net };
    });

    const orderNo = genOrderNo();
    const [orderResult] = await conn.query(
      `INSERT INTO orders (order_no, order_date, employee_id, distributor_id, retailer_id, visit_id, status, total_amount)
       VALUES (?, CURDATE(), ?, ?, ?, ?, 'submitted', ?)`,
      [orderNo, employeeId, distributorId, retailer_id, visit_id || null, Math.round(total * 100) / 100]
    );
    const orderId = orderResult.insertId;

    for (const cl of computedLines) {
      await conn.query(
        `INSERT INTO order_lines (order_id, product_id, qty, carton_qty, pack_qty, rate, discount_amt, gst_amt, net_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, cl.product_id, cl.qty, cl.carton_qty, cl.pack_qty, cl.rate, cl.discount_amt, cl.gst_amt, cl.net_amount]
      );
    }
    await conn.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, remarks) VALUES (?, NULL, 'submitted', ?, 'Order booked')`,
      [orderId, req.user.id]
    );

    await conn.commit();
    res.status(201).json({ id: orderId, order_no: orderNo, total_amount: total, distributor_id: distributorId });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// Status transitions: distributor moves the order through the dispatch flow (BRD 10)
router.patch('/:id/status', allowRoles('distributor', 'super_admin', 'management'), async (req, res) => {
  const { status, remarks, invoice_no, invoice_url, cancel_reason } = req.body;
  const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'distributor' && order.distributor_id !== req.user.distributor_id) {
    return res.status(403).json({ error: 'Not your order' });
  }

  if (status === 'cancelled') {
    if (!cancel_reason) return res.status(400).json({ error: 'Cancellation requires a reason (BRD 18, 19)' });
    if (order.status === 'dispatched' || order.status === 'delivered') {
      return res.status(400).json({ error: 'Dispatched/delivered orders cannot be cancelled' });
    }
  } else if (!STATUS_FLOW.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${STATUS_FLOW.join(', ')}, cancelled` });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const updates = ['status = ?'];
    const params = [status];
    if (invoice_no) { updates.push('invoice_no = ?'); params.push(invoice_no); }
    if (invoice_url) { updates.push('invoice_url = ?'); params.push(invoice_url); }
    if (status === 'cancelled') { updates.push('cancel_reason = ?'); params.push(cancel_reason); }
    params.push(req.params.id);
    await conn.query(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);
    await conn.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, remarks) VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, order.status, status, req.user.id, remarks || null]
    );
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// Consolidated SKU picking list for a distributor on a given day (BRD 9)
router.get('/consolidated/:distributor_id', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  if (req.user.role === 'distributor' && Number(req.params.distributor_id) !== req.user.distributor_id) {
    return res.status(403).json({ error: 'Not your distributor account' });
  }
  const [rawRows] = await pool.query(
    `SELECT p.id AS product_id, p.sku_code, p.name AS product_name, p.pack_size, p.units_per_carton,
            SUM(ol.qty) AS total_qty, SUM(ol.net_amount) AS total_value,
            COUNT(DISTINCT o.id) AS order_count
     FROM order_lines ol
     JOIN orders o ON o.id = ol.order_id
     JOIN products p ON p.id = ol.product_id
     WHERE o.distributor_id = ? AND o.order_date = ? AND o.status NOT IN ('cancelled')
     GROUP BY p.id ORDER BY p.name`,
    [req.params.distributor_id, date]
  );
  // Break the total pack quantity back into full cartons + loose packs for easy box-wise picking.
  const rows = rawRows.map((r) => {
    const upc = Number(r.units_per_carton) || 1;
    const totalQty = Number(r.total_qty);
    return { ...r, pick_cartons: Math.floor(totalQty / upc), pick_loose_packs: totalQty % upc };
  });
  const [byRetailer] = await pool.query(
    `SELECT r.id AS retailer_id, r.name AS retailer_name, p.id AS product_id, SUM(ol.qty) AS qty
     FROM order_lines ol
     JOIN orders o ON o.id = ol.order_id
     JOIN retailers r ON r.id = o.retailer_id
     JOIN products p ON p.id = ol.product_id
     WHERE o.distributor_id = ? AND o.order_date = ? AND o.status NOT IN ('cancelled')
     GROUP BY r.id, p.id`,
    [req.params.distributor_id, date]
  );
  res.json({ date, sku_summary: rows, retailer_breakdown: byRetailer });
});

module.exports = router;
