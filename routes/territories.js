const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM territories ORDER BY name');
  const [districtRows] = await pool.query('SELECT * FROM territory_districts ORDER BY district');
  const byTerritory = {};
  for (const d of districtRows) {
    (byTerritory[d.territory_id] = byTerritory[d.territory_id] || []).push({ state: d.state, district: d.district });
  }
  res.json(rows.map((t) => ({ ...t, districts: byTerritory[t.id] || [] })));
});

// districts: [{ state, district }, ...] — a territory can span multiple districts (extension
// beyond the BRD's single state/district field). state/district on the territories row itself
// are kept only for legacy display (set to the first selected district).
router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, districts } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!Array.isArray(districts) || !districts.length) {
    return res.status(400).json({ error: 'At least one district is required' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO territories (name, state, district) VALUES (?, ?, ?)',
      [name, districts[0].state, districts[0].district]
    );
    const territoryId = result.insertId;
    for (const d of districts) {
      await conn.query(
        'INSERT INTO territory_districts (territory_id, state, district) VALUES (?, ?, ?)',
        [territoryId, d.state, d.district]
      );
    }
    await conn.commit();
    res.status(201).json({ id: territoryId });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
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
