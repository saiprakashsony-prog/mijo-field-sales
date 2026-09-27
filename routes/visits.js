const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res) => {
  const { employee_id, date } = req.query;
  const where = [];
  const params = [];
  if (employee_id) { where.push('v.employee_id = ?'); params.push(employee_id); }
  if (date) { where.push('DATE(v.checkin_time) = ?'); params.push(date); }
  const [rows] = await pool.query(
    `SELECT v.*, r.name AS retailer_name, r.code AS retailer_code
     FROM visits v JOIN retailers r ON r.id = v.retailer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY v.checkin_time DESC`,
    params
  );
  res.json(rows);
});

router.post('/checkin', async (req, res) => {
  const { retailer_id, checkin_lat, checkin_lng } = req.body;
  const employeeId = req.user.employee_id;
  if (!employeeId) return res.status(400).json({ error: 'Logged-in user has no linked employee record' });
  if (!retailer_id) return res.status(400).json({ error: 'retailer_id is required' });

  const [result] = await pool.query(
    'INSERT INTO visits (employee_id, retailer_id, checkin_lat, checkin_lng) VALUES (?, ?, ?, ?)',
    [employeeId, retailer_id, checkin_lat || null, checkin_lng || null]
  );
  res.status(201).json({ id: result.insertId });
});

// Complete a visit, either with an order (order_id set separately) or a non-productive reason
router.post('/:id/complete', async (req, res) => {
  const { visit_type, np_reason } = req.body;
  await pool.query(
    `UPDATE visits SET status = 'completed', completed_at = NOW(), visit_type = ?, np_reason = ? WHERE id = ?`,
    [visit_type || 'productive', np_reason || null, req.params.id]
  );
  res.json({ ok: true });
});

module.exports = router;
