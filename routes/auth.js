const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { mobile, password } = req.body;
  if (!mobile || !password) return res.status(400).json({ error: 'Mobile and password required' });

  const [rows] = await pool.query(
    `SELECT u.*, e.name AS employee_name, d.name AS distributor_name
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN distributors d ON d.id = u.distributor_id
     WHERE u.mobile = ? AND u.status = 'active'`,
    [mobile]
  );
  if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const payload = {
    id: user.id,
    name: user.name,
    role: user.role,
    employee_id: user.employee_id,
    distributor_id: user.distributor_id,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: payload });
});

module.exports = router;
