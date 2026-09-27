const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

function genReturnNo() {
  return 'RET/' + Date.now().toString().slice(-9);
}

router.get('/', async (req, res) => {
  const { retailer_id, distributor_id, status } = req.query;
  const where = [];
  const params = [];
  if (retailer_id) { where.push('sr.retailer_id = ?'); params.push(retailer_id); }
  if (distributor_id) { where.push('sr.distributor_id = ?'); params.push(distributor_id); }
  if (status) { where.push('sr.status = ?'); params.push(status); }

  // Role scoping, same pattern as orders: a distributor only sees their own, an employee only theirs
  if (req.user.role === 'distributor') { where.push('sr.distributor_id = ?'); params.push(req.user.distributor_id); }
  if (req.user.role === 'field_employee') { where.push('sr.requested_by = ?'); params.push(req.user.employee_id); }

  const [rows] = await pool.query(
    `SELECT sr.*, r.name AS retailer_name, r.code AS retailer_code, d.name AS distributor_name,
            p.name AS product_name, p.sku_code, e.name AS requested_by_name, o.order_no
     FROM sales_returns sr
     JOIN retailers r ON r.id = sr.retailer_id
     JOIN distributors d ON d.id = sr.distributor_id
     JOIN products p ON p.id = sr.product_id
     LEFT JOIN employees e ON e.id = sr.requested_by
     LEFT JOIN orders o ON o.id = sr.order_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY sr.created_at DESC`,
    params
  );
  res.json(rows);
});

// A field employee reports a return against one of their retailers (optionally tied to a
// past order for traceability); admin/management can also file one directly.
router.post('/', async (req, res) => {
  const { retailer_id, order_id, product_id, qty, return_type, reason } = req.body;
  if (!retailer_id || !product_id || !qty || !return_type) {
    return res.status(400).json({ error: 'retailer_id, product_id, qty, return_type are required' });
  }
  const validTypes = ['damage', 'expiry', 'unsold', 'wrong_item', 'other'];
  if (!validTypes.includes(return_type)) return res.status(400).json({ error: `return_type must be one of: ${validTypes.join(', ')}` });

  const employeeId = req.user.employee_id || null;
  if (req.user.role === 'field_employee' && !employeeId) {
    return res.status(400).json({ error: 'Logged-in user has no linked employee record' });
  }

  const [[retailer]] = await pool.query('SELECT id, distributor_id FROM retailers WHERE id = ?', [retailer_id]);
  if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

  // Rate for the credit note: use the original order line's rate if this return references
  // an order (so the credit matches what was actually billed), otherwise the product's
  // current Retailer Price.
  let rate;
  if (order_id) {
    const [[line]] = await pool.query('SELECT rate FROM order_lines WHERE order_id = ? AND product_id = ?', [order_id, product_id]);
    if (!line) return res.status(400).json({ error: 'That product was not found on the referenced order' });
    rate = Number(line.rate);
  } else {
    const [[product]] = await pool.query('SELECT mrp, retailer_margin_pct FROM products WHERE id = ?', [product_id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    rate = Math.round(Number(product.mrp) * (1 - Number(product.retailer_margin_pct) / 100) * 100) / 100;
  }

  const amount = Math.round(qty * rate * 100) / 100;
  const returnNo = genReturnNo();
  const [result] = await pool.query(
    `INSERT INTO sales_returns (return_no, order_id, retailer_id, distributor_id, product_id, qty, rate, amount, return_type, reason, requested_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [returnNo, order_id || null, retailer_id, retailer.distributor_id, product_id, qty, rate, amount, return_type, reason || null, employeeId]
  );
  res.status(201).json({ id: result.insertId, return_no: returnNo, amount });
});

// Approve or reject — the distributor who'd receive the physical goods, or admin/management
// for oversight/override. Only an approval turns this into an actual credit note.
router.patch('/:id/status', allowRoles('distributor', 'super_admin', 'management'), async (req, res) => {
  const { status, review_note } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });

  const [[ret]] = await pool.query('SELECT * FROM sales_returns WHERE id = ?', [req.params.id]);
  if (!ret) return res.status(404).json({ error: 'Not found' });
  if (ret.status !== 'requested') return res.status(400).json({ error: `This return is already ${ret.status}` });
  if (req.user.role === 'distributor' && ret.distributor_id !== req.user.distributor_id) {
    return res.status(403).json({ error: 'Not your return to review' });
  }

  await pool.query(
    'UPDATE sales_returns SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?',
    [status, req.user.id, review_note || null, req.params.id]
  );
  res.json({ ok: true });
});

module.exports = router;
