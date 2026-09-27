const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res) => {
  const activeOnly = req.query.active === '1';
  const [rows] = await pool.query(
    `SELECT * FROM products ${activeOnly ? "WHERE status = 'active'" : ''} ORDER BY name`
  );
  res.json(rows);
});

router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { sku_code, name, category, brand, pack_size, uom, mrp, distributor_rate, retailer_rate, gst_pct, scheme_note, moq } = req.body;
  if (!sku_code || !name || mrp == null || distributor_rate == null || gst_pct == null) {
    return res.status(400).json({ error: 'sku_code, name, mrp, distributor_rate, gst_pct are required' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO products (sku_code, name, category, brand, pack_size, uom, mrp, distributor_rate, retailer_rate, gst_pct, scheme_note, moq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sku_code, name, category || null, brand || null, pack_size || null, uom || null, mrp, distributor_rate, retailer_rate || null, gst_pct, scheme_note || null, moq || 1]
    );
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'SKU code already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  const fields = ['name', 'category', 'brand', 'pack_size', 'uom', 'mrp', 'distributor_rate', 'retailer_rate', 'gst_pct', 'scheme_note', 'moq', 'status'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  await pool.query(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, values);
  res.json({ ok: true });
});

module.exports = router;
