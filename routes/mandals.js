const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// ?districts=District1,District2 filters to mandals under any of those districts
// (used when picking mandals for a distributor, scoped to their territory's districts).
router.get('/', async (req, res) => {
  const { districts } = req.query;
  if (districts) {
    const list = districts.split(',').filter(Boolean);
    if (!list.length) return res.json([]);
    const [rows] = await pool.query(
      `SELECT * FROM mandals WHERE district IN (${list.map(() => '?').join(',')}) ORDER BY district, name`,
      list
    );
    return res.json(rows);
  }
  const [rows] = await pool.query('SELECT * FROM mandals ORDER BY state, district, name');
  res.json(rows);
});

router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, state, district } = req.body;
  if (!name || !state || !district) return res.status(400).json({ error: 'name, state, district are required' });
  try {
    const [result] = await pool.query('INSERT INTO mandals (name, state, district) VALUES (?, ?, ?)', [name.trim(), state, district]);
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This mandal already exists for that district' });
    throw e;
  }
});

router.delete('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  try {
    await pool.query('DELETE FROM mandals WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({ error: 'This mandal is mapped to one or more distributors, so it cannot be deleted.' });
    }
    throw e;
  }
});

module.exports = router;
