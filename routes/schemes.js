const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// Finds every active, currently-valid scheme that could apply to a line, given its product,
// the retailer's territory, and the order's distributor. Returns the single best one (the one
// that yields the largest ₹ discount for this qty/rate) — never more than one scheme per line.
// Used both for the live preview while booking and, authoritatively, on order creation.
async function findBestScheme(conn, { product_id, territory_id, distributor_id, qty, rate }) {
  const today = new Date().toISOString().slice(0, 10);
  const [candidates] = await conn.query(
    `SELECT * FROM schemes
     WHERE status = 'active'
       AND (product_id IS NULL OR product_id = ?)
       AND (territory_id IS NULL OR territory_id = ?)
       AND (distributor_id IS NULL OR distributor_id = ?)
       AND (valid_from IS NULL OR valid_from <= ?)
       AND (valid_to IS NULL OR valid_to >= ?)
       AND min_qty <= ?`,
    [product_id, territory_id || 0, distributor_id || 0, today, today, qty]
  );
  if (!candidates.length) return null;

  let best = null;
  let bestDiscount = 0;
  for (const s of candidates) {
    const gross = qty * rate;
    const discount = s.discount_type === 'percent'
      ? Math.round((gross * Number(s.discount_value)) / 100 * 100) / 100
      : Math.round(Math.min(qty * Number(s.discount_value), gross) * 100) / 100;
    if (discount > bestDiscount) { bestDiscount = discount; best = s; }
  }
  return best ? { scheme: best, discount_amt: bestDiscount } : null;
}

router.get('/', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT s.*, p.name AS product_name, p.sku_code, t.name AS territory_name, d.name AS distributor_name
     FROM schemes s
     LEFT JOIN products p ON p.id = s.product_id
     LEFT JOIN territories t ON t.id = s.territory_id
     LEFT JOIN distributors d ON d.id = s.distributor_id
     ORDER BY s.created_at DESC`
  );
  res.json(rows);
});

// Live preview for order booking: what scheme (if any) would apply right now for this line.
router.get('/match', async (req, res) => {
  const { product_id, territory_id, distributor_id, qty, rate } = req.query;
  if (!product_id || !qty || !rate) return res.status(400).json({ error: 'product_id, qty, rate are required' });
  const result = await findBestScheme(pool, {
    product_id: Number(product_id),
    territory_id: territory_id ? Number(territory_id) : null,
    distributor_id: distributor_id ? Number(distributor_id) : null,
    qty: Number(qty),
    rate: Number(rate),
  });
  res.json(result || { scheme: null, discount_amt: 0 });
});

router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, discount_type, discount_value, min_qty, product_id, territory_id, distributor_id, valid_from, valid_to } = req.body;
  if (!name || !discount_type || discount_value == null) {
    return res.status(400).json({ error: 'name, discount_type, discount_value are required' });
  }
  if (!['percent', 'flat'].includes(discount_type)) return res.status(400).json({ error: 'discount_type must be percent or flat' });
  if (discount_type === 'percent' && (discount_value < 0 || discount_value > 100)) {
    return res.status(400).json({ error: 'A percent discount must be between 0 and 100' });
  }
  const [result] = await pool.query(
    `INSERT INTO schemes (name, discount_type, discount_value, min_qty, product_id, territory_id, distributor_id, valid_from, valid_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, discount_type, discount_value, min_qty || 1, product_id || null, territory_id || null, distributor_id || null, valid_from || null, valid_to || null]
  );
  res.status(201).json({ id: result.insertId });
});

router.patch('/:id/status', allowRoles('super_admin', 'management'), async (req, res) => {
  await pool.query('UPDATE schemes SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
  res.json({ ok: true });
});

router.delete('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  await pool.query('DELETE FROM schemes WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = { router, findBestScheme };
