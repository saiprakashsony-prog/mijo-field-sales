// Production (from the MMS), finished-goods stock and stock adjustments.
const crypto = require('crypto');
const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');
const sync = require('../services/mms-sync');
const { stockByProduct, PACKS_SQL } = require('../services/stock');

// ---------- MMS → DMS notification (server-to-server, no user session) ----------
const integration = express.Router();
let pingTimer = null;
integration.post('/mms/ping', (req, res) => {
  const got = String(req.headers['x-integration-key'] || '');
  const ok = sync.KEY.length >= 24 && got.length === sync.KEY.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(sync.KEY));
  if (!ok) return res.status(401).json({ error: 'Invalid integration key' });
  // several batch edits in a row → one sync
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => sync.syncNow('mms_ping'), 3000);
  res.json({ ok: true });
});

// ---------- Admin screens ----------
const router = express.Router();
router.use(authRequired);
const VIEW = ['super_admin', 'management', 'sales_manager'];
const EDIT = ['super_admin', 'management'];

router.get('/status', allowRoles(...VIEW), async (req, res) => {
  const [[counts]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM mms_products WHERE active = 1) AS mms_products,
            (SELECT COUNT(*) FROM mms_products WHERE active = 1 AND product_id IS NULL) AS unlinked,
            (SELECT COUNT(*) FROM production_batches) AS batches`
  );
  res.json({ configured: sync.configured(), last_sync: await sync.getState('mms_sync'), ...counts });
});

router.post('/sync', allowRoles(...EDIT), async (req, res) => {
  const r = await sync.syncNow('manual');
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(r);
});

router.get('/mms-products', allowRoles(...VIEW), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT mp.*, p.sku_code, p.name AS product_name,
            (SELECT COUNT(*) FROM production_batches pb WHERE pb.mms_product_id = mp.mms_product_id) AS batch_count
     FROM mms_products mp LEFT JOIN products p ON p.id = mp.product_id
     WHERE mp.active = 1 ORDER BY mp.name`
  );
  res.json(rows);
});

router.patch('/mms-products/:id', allowRoles(...EDIT), async (req, res) => {
  const productId = req.body.product_id ? Number(req.body.product_id) : null;
  const ppu = req.body.packs_per_unit === '' || req.body.packs_per_unit == null ? null : Number(req.body.packs_per_unit);
  if (ppu !== null && !(ppu > 0)) return res.status(400).json({ error: 'Packs per unit must be more than 0, or left blank' });
  if (productId) {
    const [[p]] = await pool.query('SELECT id FROM products WHERE id = ?', [productId]);
    if (!p) return res.status(400).json({ error: 'Selected SKU not found' });
  }
  const [r] = await pool.query('UPDATE mms_products SET product_id = ?, packs_per_unit = ? WHERE mms_product_id = ?', [productId, ppu, req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.get('/batches', allowRoles(...VIEW), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT pb.mms_batch_id, DATE_FORMAT(pb.batch_date, '%Y-%m-%d') AS batch_date, pb.actual_qty, pb.unit, pb.total_cost,
            mp.name AS mms_product_name, p.sku_code, p.name AS product_name,
            ${PACKS_SQL} AS packs
     FROM production_batches pb
     LEFT JOIN mms_products mp ON mp.mms_product_id = pb.mms_product_id
     LEFT JOIN products p ON p.id = mp.product_id
     ORDER BY pb.batch_date DESC LIMIT 100`
  );
  res.json(rows.map((r) => ({ ...r, packs: Number(r.packs), cost_per_pack: Number(r.packs) > 0 ? Number(r.total_cost) / Number(r.packs) : null })));
});

router.get('/stock', allowRoles(...VIEW), async (req, res) => {
  res.json(await stockByProduct());
});

const REASONS = ['opening_stock', 'damage', 'samples', 'correction', 'other'];
router.get('/adjustments', allowRoles(...VIEW), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, DATE_FORMAT(a.adj_date, '%Y-%m-%d') AS adj_date, a.packs, a.reason, a.notes, p.sku_code, p.name AS product_name, u.name AS created_by_name
     FROM stock_adjustments a JOIN products p ON p.id = a.product_id LEFT JOIN users u ON u.id = a.created_by
     ORDER BY a.id DESC LIMIT 100`
  );
  res.json(rows);
});
router.post('/adjustments', allowRoles(...EDIT), async (req, res) => {
  const productId = Number(req.body.product_id);
  const packs = Math.round(Number(req.body.packs));
  const date = String(req.body.adj_date || '');
  if (!productId) return res.status(400).json({ error: 'Select a SKU' });
  if (!Number.isFinite(packs) || packs === 0) return res.status(400).json({ error: 'Enter packs to add (+) or remove (−)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Enter a date' });
  if (!REASONS.includes(req.body.reason)) return res.status(400).json({ error: 'Select a reason' });
  const [[p]] = await pool.query('SELECT id FROM products WHERE id = ?', [productId]);
  if (!p) return res.status(400).json({ error: 'SKU not found' });
  await pool.query(
    'INSERT INTO stock_adjustments (product_id, adj_date, packs, reason, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [productId, date, packs, req.body.reason, req.body.notes ? String(req.body.notes).replace(/[<>]/g, '').slice(0, 255) : null, req.user.id]
  );
  res.status(201).json({ ok: true });
});
router.delete('/adjustments/:id', allowRoles(...EDIT), async (req, res) => {
  await pool.query('DELETE FROM stock_adjustments WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = { router, integration };
