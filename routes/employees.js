const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

function genCode() {
  return 'EMP' + Date.now().toString().slice(-8);
}

router.get('/', allowRoles('super_admin', 'management', 'sales_manager'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT e.*, t.name AS territory_name,
            GROUP_CONCAT(d.name SEPARATOR ', ') AS distributors
     FROM employees e
     LEFT JOIN territories t ON t.id = e.territory_id
     LEFT JOIN employee_distributors ed ON ed.employee_id = e.id
     LEFT JOIN distributors d ON d.id = ed.distributor_id
     GROUP BY e.id ORDER BY e.created_at DESC`
  );
  res.json(rows);
});

router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, mobile, email, date_of_joining, designation, reporting_manager_id, territory_id, distributor_ids } = req.body;
  if (!name || !mobile || !designation) return res.status(400).json({ error: 'name, mobile, designation are required' });
  if (!distributor_ids || !distributor_ids.length) return res.status(400).json({ error: 'At least one assigned distributor is required (BRD 5.19)' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const code = genCode();
    const [result] = await conn.query(
      `INSERT INTO employees (code, name, mobile, email, date_of_joining, designation, reporting_manager_id, territory_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, name, mobile, email || null, date_of_joining || null, designation, reporting_manager_id || null, territory_id || null]
    );
    const employeeId = result.insertId;
    for (const [i, distId] of distributor_ids.entries()) {
      await conn.query(
        'INSERT INTO employee_distributors (employee_id, distributor_id, is_primary) VALUES (?, ?, ?)',
        [employeeId, distId, i === 0 ? 1 : 0]
      );
    }
    await conn.commit();
    res.status(201).json({ id: employeeId, code });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.patch('/:id/status', allowRoles('super_admin', 'management'), async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE employees SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
