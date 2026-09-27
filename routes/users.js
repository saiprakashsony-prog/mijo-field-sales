const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);
router.use(allowRoles('super_admin', 'management'));

router.get('/', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.mobile, u.role, u.status, e.name AS employee_name, d.name AS distributor_name
     FROM users u LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN distributors d ON d.id = u.distributor_id
     ORDER BY u.created_at DESC`
  );
  res.json(rows);
});

// role: super_admin | management | sales_manager | field_employee | distributor
// for field_employee, pass employee_id; for distributor, pass distributor_id
router.post('/', async (req, res) => {
  const { name, mobile, password, role, employee_id, distributor_id } = req.body;
  if (!name || !mobile || !password || !role) return res.status(400).json({ error: 'name, mobile, password, role are required' });
  if (role === 'field_employee' && !employee_id) return res.status(400).json({ error: 'employee_id is required for a field_employee login' });
  if (role === 'distributor' && !distributor_id) return res.status(400).json({ error: 'distributor_id is required for a distributor login' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const [result] = await pool.query(
      'INSERT INTO users (name, mobile, password_hash, role, employee_id, distributor_id) VALUES (?, ?, ?, ?, ?, ?)',
      [name, mobile, hash, role, employee_id || null, distributor_id || null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A login with this mobile number already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/status', async (req, res) => {
  await pool.query('UPDATE users SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
