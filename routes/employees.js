const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles, clearAuthCache } = require('../middleware/auth');
const { safeMsg } = require('../middleware/safeError');
const { LEVELS, LEVEL_LABELS, REPORTS_TO, isAreaManager, teamEmployeeIds } = require('../middleware/scope');

const router = express.Router();
router.use(authRequired);

function genCode() {
  return 'EMP' + Date.now().toString().slice(-8);
}

// Admin roles see every employee; RM / ASM / SO see themselves and everyone under them.
router.get('/', async (req, res) => {
  const isAdmin = ['super_admin', 'management', 'sales_manager'].includes(req.user.role);
  if (!isAdmin && !isAreaManager(req.user)) return res.status(403).json({ error: 'Not permitted for this role' });
  const team = isAdmin ? null : await teamEmployeeIds(req.user.employee_id);

  const [rows] = await pool.query(
    `SELECT e.*, t.name AS territory_name, m.name AS reporting_manager_name, m.level AS reporting_manager_level
     FROM employees e
     LEFT JOIN territories t ON t.id = e.territory_id
     LEFT JOIN employees m ON m.id = e.reporting_manager_id
     ${team ? 'WHERE e.id IN (?)' : ''}
     ORDER BY FIELD(e.level, 'RM', 'ASM', 'SO', 'SR'), e.name`,
    team ? [team] : []
  );
  const ids = rows.map((r) => r.id);
  const pick = async (sql) => (ids.length ? (await pool.query(sql, [ids]))[0] : []);
  const dists = await pick(
    `SELECT ed.employee_id, d.id, d.name FROM employee_distributors ed JOIN distributors d ON d.id = ed.distributor_id
     WHERE ed.employee_id IN (?) ORDER BY ed.is_primary DESC, d.name`
  );
  const terrs = await pick(
    `SELECT et.employee_id, t.id, t.name FROM employee_territories et JOIN territories t ON t.id = et.territory_id
     WHERE et.employee_id IN (?) ORDER BY t.name`
  );
  const states = await pick('SELECT employee_id, state FROM employee_states WHERE employee_id IN (?) ORDER BY state');
  const group = (list, id) => list.filter((x) => x.employee_id === id);

  res.json(rows.map((r) => {
    const level = r.level || 'SR';
    const d = group(dists, r.id);
    const t = group(terrs, r.id);
    const s = group(states, r.id);
    return {
      ...r,
      level,
      level_label: LEVEL_LABELS[level],
      distributor_ids: d.map((x) => x.id),
      distributors: d.map((x) => x.name).join(', '),
      territory_ids: t.map((x) => x.id),
      territories: t.map((x) => x.name).join(', '),
      states: s.map((x) => x.state),
      area: level === 'RM' ? s.map((x) => x.state).join(', ') : level === 'ASM' ? t.map((x) => x.name).join(', ') : d.map((x) => x.name).join(', '),
    };
  }));
});

// Validates level, reporting manager and the area that goes with the level.
// Returns a normalised { level, designation, reporting_manager_id, states, territory_ids, distributor_ids }.
async function validateHierarchy(conn, body, employeeId) {
  const level = String(body.level || '').toUpperCase();
  if (!LEVELS.includes(level)) throw new Error('Select a designation: Regional Manager, Area Sales Manager, Sales Officer or Sales Representative');

  let managerId = body.reporting_manager_id ? Number(body.reporting_manager_id) : null;
  const needs = REPORTS_TO[level];
  if (!needs) managerId = null;
  if (managerId) {
    if (employeeId && managerId === Number(employeeId)) throw new Error('An employee cannot report to themselves');
    const [[mgr]] = await conn.query('SELECT id, name, level, status FROM employees WHERE id = ?', [managerId]);
    if (!mgr) throw new Error('Selected reporting manager not found');
    if ((mgr.level || 'SR') !== needs) {
      const an = (w) => (/^[AEIOU]/.test(w) ? 'an ' : 'a ') + w;
      throw new Error(`${an(LEVEL_LABELS[level]).replace(/^a/, 'A')} must report to ${an(LEVEL_LABELS[needs])} — ${mgr.name} is ${an(LEVEL_LABELS[mgr.level || 'SR'])}`);
    }
  }

  const clean = (arr) => (Array.isArray(arr) ? arr : []);
  const states = [...new Set(clean(body.states).map((s) => String(s).trim()).filter(Boolean))].map((s) => s.slice(0, 100));
  const territoryIds = [...new Set(clean(body.territory_ids).map(Number).filter(Boolean))];
  const distributorIds = [...new Set(clean(body.distributor_ids).map(Number).filter(Boolean))];

  if (level === 'RM' && !states.length) throw new Error('Select at least one state for a Regional Manager');
  if (level === 'ASM') {
    if (!territoryIds.length) throw new Error('Select at least one territory for an Area Sales Manager');
    const [found] = await conn.query('SELECT id FROM territories WHERE id IN (?)', [territoryIds]);
    if (found.length !== territoryIds.length) throw new Error('One or more selected territories no longer exist');
  }
  if (['SO', 'SR'].includes(level)) {
    if (!distributorIds.length) throw new Error(`Select at least one distributor for a ${LEVEL_LABELS[level]}`);
    const [found] = await conn.query('SELECT id FROM distributors WHERE id IN (?)', [distributorIds]);
    if (found.length !== distributorIds.length) throw new Error('One or more selected distributors no longer exist');
  }

  return {
    level,
    designation: LEVEL_LABELS[level],
    reporting_manager_id: managerId,
    states: level === 'RM' ? states : [],
    territory_ids: level === 'ASM' ? territoryIds : [],
    distributor_ids: ['SO', 'SR'].includes(level) ? distributorIds : [],
  };
}

async function saveArea(conn, employeeId, h) {
  await conn.query('DELETE FROM employee_states WHERE employee_id = ?', [employeeId]);
  await conn.query('DELETE FROM employee_territories WHERE employee_id = ?', [employeeId]);
  await conn.query('DELETE FROM employee_distributors WHERE employee_id = ?', [employeeId]);
  for (const s of h.states) await conn.query('INSERT INTO employee_states (employee_id, state) VALUES (?, ?)', [employeeId, s]);
  for (const t of h.territory_ids) await conn.query('INSERT INTO employee_territories (employee_id, territory_id) VALUES (?, ?)', [employeeId, t]);
  for (const [i, d] of h.distributor_ids.entries()) {
    await conn.query('INSERT INTO employee_distributors (employee_id, distributor_id, is_primary) VALUES (?, ?, ?)', [employeeId, d, i === 0 ? 1 : 0]);
  }
}

router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, mobile, email, date_of_joining, territory_id } = req.body;
  if (!name || !mobile) return res.status(400).json({ error: 'name and mobile are required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const h = await validateHierarchy(conn, req.body, null);
    const code = genCode();
    const [result] = await conn.query(
      `INSERT INTO employees (code, name, mobile, email, date_of_joining, designation, level, reporting_manager_id, territory_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, name, mobile, email || null, date_of_joining || null, h.designation, h.level, h.reporting_manager_id, territory_id || null]
    );
    await saveArea(conn, result.insertId, h);
    await conn.commit();
    res.status(201).json({ id: result.insertId, code });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: safeMsg(e) });
  } finally {
    conn.release();
  }
});

router.patch('/:id/status', allowRoles('super_admin', 'management'), async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE employees SET status = ? WHERE id = ?', [status, req.params.id]);
  clearAuthCache();
  res.json({ ok: true });
});

// Full edit. Designation, reporting manager and area are saved together (level decides which area applies).
router.patch('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, mobile, email, date_of_joining, territory_id, status } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[emp]] = await conn.query('SELECT id, level FROM employees WHERE id = ?', [id]);
    if (!emp) throw new Error('Employee not found');

    const fields = { name, mobile, email, date_of_joining, territory_id, status };
    let h = null;
    if (req.body.level !== undefined) {
      h = await validateHierarchy(conn, req.body, id);
      // Changing someone's level would leave their reports with a manager at the wrong level
      if (h.level !== (emp.level || 'SR')) {
        const [reports] = await conn.query('SELECT name FROM employees WHERE reporting_manager_id = ?', [id]);
        if (reports.length) {
          throw new Error(`Move ${reports.map((r) => r.name).join(', ')} to another manager before changing this employee's designation`);
        }
      }
      Object.assign(fields, { designation: h.designation, level: h.level, reporting_manager_id: h.reporting_manager_id });
    }

    const updates = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) { updates.push(`${k} = ?`); values.push(v === '' ? null : v); }
    }
    if (updates.length) {
      values.push(id);
      await conn.query(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    if (h) await saveArea(conn, id, h);

    await conn.commit();
    clearAuthCache(); // status or designation may have changed
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: safeMsg(e) });
  } finally {
    conn.release();
  }
});

module.exports = router;
