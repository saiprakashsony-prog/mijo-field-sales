const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM territories ORDER BY name');
  res.json(rows);
});

router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, state, district } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const [result] = await pool.query('INSERT INTO territories (name, state, district) VALUES (?, ?, ?)', [name, state || null, district || null]);
  res.status(201).json({ id: result.insertId });
});

router.delete('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  try {
    await pool.query('DELETE FROM territories WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({ error: 'This territory is already used by a distributor, employee or retailer, so it cannot be deleted.' });
    }
    throw e;
  }
});

module.exports = router;
