const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { accountIsActive, authRequired } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { mobile, password } = req.body;
  if (!mobile || !password) return res.status(400).json({ error: 'Mobile and password required' });

  const [rows] = await pool.query(
    `SELECT u.*, e.name AS employee_name, d.name AS distributor_name, e.level AS employee_level,
            e.status AS employee_status, d.status AS distributor_status
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN distributors d ON d.id = u.distributor_id
     WHERE u.mobile = ?`,
    [mobile]
  );
  if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  // Only said AFTER the password is correct, so this can't be used to discover which numbers have accounts.
  if (!accountIsActive(user)) {
    return res.status(403).json({ error: 'This account has been deactivated. Please contact your admin.' });
  }

  const payload = {
    id: user.id,
    name: user.name,
    role: user.role,
    employee_id: user.employee_id,
    distributor_id: user.distributor_id,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' });
  res.json({ token, user: { ...payload, level: user.role === 'field_employee' ? (user.employee_level || 'SR') : null } });
});

// Self-service login creation: a field employee or distributor creates their own login,
// verified against a record the admin already entered (matching Code + Mobile), rather
// than the admin having to type in a password for every person by hand.
function signToken(user) {
  const payload = { id: user.id, name: user.name, role: user.role, employee_id: user.employee_id, distributor_id: user.distributor_id };
  return { token: jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' }), user: payload };
}

router.post('/self-register', async (req, res) => {
  const { code, mobile, name, password } = req.body;
  if (!code || !mobile || !name || !password) {
    return res.status(400).json({ error: 'code, mobile, name, and password are all required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const trimmedCode = code.trim().toUpperCase();

  const [employees] = await pool.query('SELECT * FROM employees WHERE code = ? AND mobile = ? AND status = "active"', [trimmedCode, mobile]);
  const [distributors] = employees.length ? [[]] : await pool.query('SELECT * FROM distributors WHERE code = ? AND mobile = ? AND status = "active"', [trimmedCode, mobile]);

  const employee = employees[0];
  const distributor = distributors[0];
  if (!employee && !distributor) {
    return res.status(404).json({ error: 'No active employee or distributor matches that code and mobile number. Double-check both, or ask your admin to confirm what was entered for you.' });
  }

  const role = employee ? 'field_employee' : 'distributor';
  const linkField = employee ? 'employee_id' : 'distributor_id';
  const linkId = employee ? employee.id : distributor.id;

  const [existing] = await pool.query(`SELECT id FROM users WHERE ${linkField} = ?`, [linkId]);
  if (existing.length) {
    return res.status(409).json({ error: 'A login already exists for this record. Ask your admin to reset your password instead of registering again.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO users (name, mobile, password_hash, role, ${linkField}) VALUES (?, ?, ?, ?, ?)`,
      [name, mobile, hash, role, linkId]
    );
    const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
    res.status(201).json(signToken(user));
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A login already exists with this mobile number.' });
    throw e;
  }
});

// Current user as the server sees it now (role / designation level can change after login)
router.get('/me', authRequired, (req, res) => res.json({ user: req.user }));

module.exports = router;
