const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

function genCode() {
  return 'DIST' + Date.now().toString().slice(-8);
}

router.get('/', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT d.*, t.name AS territory_name FROM distributors d
     LEFT JOIN territories t ON t.id = d.territory_id
     ORDER BY d.created_at DESC`
  );
  res.json(rows);
});

router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, mobile, email, address, territory_id } = req.body;
  if (!name || !mobile) return res.status(400).json({ error: 'name and mobile are required' });
  const code = genCode();
  const [result] = await pool.query(
    'INSERT INTO distributors (code, name, mobile, email, address, territory_id) VALUES (?, ?, ?, ?, ?, ?)',
    [code, name, mobile, email || null, address || null, territory_id || null]
  );
  res.status(201).json({ id: result.insertId, code });
});

router.patch('/:id/status', allowRoles('super_admin', 'management'), async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE distributors SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
