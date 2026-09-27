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
    `SELECT d.*, t.name AS territory_name,
            GROUP_CONCAT(m.name SEPARATOR ', ') AS mandals
     FROM distributors d
     LEFT JOIN territories t ON t.id = d.territory_id
     LEFT JOIN distributor_mandals dm ON dm.distributor_id = d.id
     LEFT JOIN mandals m ON m.id = dm.mandal_id
     GROUP BY d.id ORDER BY d.created_at DESC`
  );
  res.json(rows);
});

// mandal_ids, if provided, must be mandals under the selected territory's districts — mapped
// after the distributor is created (BRD-adjacent extension: territory → districts → mandals).
router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, mobile, email, address, territory_id, mandal_ids } = req.body;
  if (!name || !mobile) return res.status(400).json({ error: 'name and mobile are required' });
  const code = genCode();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO distributors (code, name, mobile, email, address, territory_id) VALUES (?, ?, ?, ?, ?, ?)',
      [code, name, mobile, email || null, address || null, territory_id || null]
    );
    const distributorId = result.insertId;
    if (Array.isArray(mandal_ids) && mandal_ids.length) {
      for (const mandalId of mandal_ids) {
        await conn.query('INSERT INTO distributor_mandals (distributor_id, mandal_id) VALUES (?, ?)', [distributorId, mandalId]);
      }
    }
    await conn.commit();
    res.status(201).json({ id: distributorId, code });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.patch('/:id/status', allowRoles('super_admin', 'management'), async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE distributors SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ ok: true });
});

router.delete('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  try {
    await pool.query('DELETE FROM distributors WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({ error: 'This distributor already has employees, retailers, orders or a login linked to it, so it cannot be deleted. Deactivate it instead.' });
    }
    throw e;
  }
});

module.exports = router;
