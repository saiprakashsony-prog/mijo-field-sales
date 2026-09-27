const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// All prices here are GST-inclusive — gst_pct is stored for invoice/reporting display only
// and is never added on top of a price. Pricing chain (each a markdown on the one before it):
//   MRP  →(retailer_margin_pct markdown)→  Retailer Price  →(distributor_margin_pct markdown)→  Distributor Price
// Retailer Price is what a retailer pays the distributor (the rate used on retailer orders).
// Distributor Price is what the distributor pays the company (informational / costing reference).
function withComputedPrices(row) {
  const mrp = Number(row.mrp);
  const retailerPrice = round2(mrp * (1 - Number(row.retailer_margin_pct) / 100));
  const distributorPrice = round2(retailerPrice * (1 - Number(row.distributor_margin_pct) / 100));
  return { ...row, retailer_price: retailerPrice, distributor_price: distributorPrice };
}
function round2(n) { return Math.round(n * 100) / 100; }

router.get('/', async (req, res) => {
  const activeOnly = req.query.active === '1';
  const [rows] = await pool.query(
    `SELECT * FROM products ${activeOnly ? "WHERE status = 'active'" : ''} ORDER BY name`
  );
  res.json(rows.map(withComputedPrices));
});

router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { sku_code, name, category, brand, pack_size, uom, mrp, retailer_margin_pct, distributor_margin_pct, gst_pct, scheme_note, moq } = req.body;
  if (!sku_code || !name || mrp == null || retailer_margin_pct == null || distributor_margin_pct == null || gst_pct == null) {
    return res.status(400).json({ error: 'sku_code, name, mrp, retailer_margin_pct, distributor_margin_pct, gst_pct are required' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO products (sku_code, name, category, brand, pack_size, uom, mrp, retailer_margin_pct, distributor_margin_pct, gst_pct, scheme_note, moq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sku_code, name, category || null, brand || null, pack_size || null, uom || null, mrp, retailer_margin_pct, distributor_margin_pct, gst_pct, scheme_note || null, moq || 1]
    );
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'SKU code already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  const fields = ['name', 'category', 'brand', 'pack_size', 'uom', 'mrp', 'retailer_margin_pct', 'distributor_margin_pct', 'gst_pct', 'scheme_note', 'moq', 'status'];
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
