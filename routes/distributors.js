const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles, clearAuthCache } = require('../middleware/auth');
const { safeMsg } = require('../middleware/safeError');

const router = express.Router();
router.use(authRequired);

function genCode() {
  return 'DIST' + Date.now().toString().slice(-8);
}

router.get('/', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT d.*, t.name AS territory_name,
            GROUP_CONCAT(m.name ORDER BY m.name SEPARATOR ', ') AS mandals,
            GROUP_CONCAT(m.id) AS mandal_ids_csv
     FROM distributors d
     LEFT JOIN territories t ON t.id = d.territory_id
     LEFT JOIN distributor_mandals dm ON dm.distributor_id = d.id
     LEFT JOIN mandals m ON m.id = dm.mandal_id
     GROUP BY d.id ORDER BY d.created_at DESC`
  );
  res.json(rows.map((r) => ({ ...r, mandal_ids: r.mandal_ids_csv ? String(r.mandal_ids_csv).split(',').map(Number) : [] })));
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
    res.status(400).json({ error: safeMsg(e) });
  } finally {
    conn.release();
  }
});

// Edit a distributor. mandal_ids, when sent, replaces the mandal mapping (only mandals in the
// territory's districts are accepted). The code and godown location are not changed here.
router.put('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  const id = Number(req.params.id);
  const clean = (v, max) => (v == null ? null : String(v).replace(/[<>]/g, '').trim().slice(0, max) || null);
  const name = clean(req.body.name, 150);
  const mobile = clean(req.body.mobile, 20);
  if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile are required' });
  if (!/^[0-9+\- ]{6,20}$/.test(mobile)) return res.status(400).json({ error: 'Enter a valid mobile number' });
  const status = req.body.status === 'inactive' ? 'inactive' : 'active';
  const territoryId = req.body.territory_id ? Number(req.body.territory_id) : null;
  const mandalIds = Array.isArray(req.body.mandal_ids) ? [...new Set(req.body.mandal_ids.map(Number).filter(Boolean))] : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[existing]] = await conn.query('SELECT id FROM distributors WHERE id = ?', [id]);
    if (!existing) throw new Error('Distributor not found');
    if (territoryId) {
      const [[t]] = await conn.query('SELECT id FROM territories WHERE id = ?', [territoryId]);
      if (!t) throw new Error('Selected territory not found');
    }
    if (mandalIds && mandalIds.length) {
      if (!territoryId) throw new Error('Select a territory before mapping mandals');
      const [ok] = await conn.query(
        `SELECT m.id FROM mandals m
         JOIN territory_districts td ON td.territory_id = ? AND td.state = m.state AND td.district = m.district
         WHERE m.id IN (?)`,
        [territoryId, mandalIds]
      );
      if (ok.length !== mandalIds.length) throw new Error("Some selected mandals are not in this territory's districts");
    }
    await conn.query(
      'UPDATE distributors SET name = ?, mobile = ?, email = ?, address = ?, territory_id = ?, status = ? WHERE id = ?',
      [name, mobile, clean(req.body.email, 150), clean(req.body.address, 500), territoryId, status, id]
    );
    if (mandalIds) {
      await conn.query('DELETE FROM distributor_mandals WHERE distributor_id = ?', [id]);
      for (const m of mandalIds) await conn.query('INSERT INTO distributor_mandals (distributor_id, mandal_id) VALUES (?, ?)', [id, m]);
    }
    await conn.query(
      `INSERT INTO audit_log (entity_type, entity_id, action, changed_by, after_json) VALUES ('distributor', ?, 'update', ?, ?)`,
      [id, req.user.id, JSON.stringify({ name, mobile, territory_id: territoryId, status, mandal_ids: mandalIds })]
    );
    await conn.commit();
    clearAuthCache(); // status may have changed (inactive distributors can't log in)
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: safeMsg(e) });
  } finally {
    conn.release();
  }
});

router.patch('/:id/status', allowRoles('super_admin', 'management'), async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE distributors SET status = ? WHERE id = ?', [status, req.params.id]);
  clearAuthCache();
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
