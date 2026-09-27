const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);
// Recording collections is an admin/management action — field employees don't handle cash
// reconciliation in this app, and distributors don't get a login-side view of this yet.
router.use(allowRoles('super_admin', 'management'));

router.get('/', async (req, res) => {
  const { retailer_id } = req.query;
  const where = retailer_id ? 'WHERE p.retailer_id = ?' : '';
  const params = retailer_id ? [retailer_id] : [];
  const [rows] = await pool.query(
    `SELECT p.*, r.name AS retailer_name, r.code AS retailer_code
     FROM payments p JOIN retailers r ON r.id = p.retailer_id
     ${where} ORDER BY p.payment_date DESC, p.created_at DESC`,
    params
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { retailer_id, amount, payment_date, method, reference, notes } = req.body;
  if (!retailer_id || !amount || !payment_date) {
    return res.status(400).json({ error: 'retailer_id, amount, payment_date are required' });
  }
  if (Number(amount) <= 0) return res.status(400).json({ error: 'amount must be greater than 0' });
  const [result] = await pool.query(
    `INSERT INTO payments (retailer_id, amount, payment_date, method, reference, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [retailer_id, amount, payment_date, method || null, reference || null, notes || null, req.user.id]
  );
  res.status(201).json({ id: result.insertId });
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM payments WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
