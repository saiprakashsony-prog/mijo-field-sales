// Sales hierarchy access.
//
//   RM  (Regional Manager)       — every distributor in the state(s) assigned to them
//   ASM (Area Sales Manager)     — every distributor in the territories assigned to them
//   SO  (Sales Officer)          — the distributors assigned to them
//   SR  (Sales Representative)   — the distributors assigned to them, but sees only their own work
//
// "Area" data (orders, returns, dashboard) for RM / ASM / SO is everything belonging to the
// distributors in their area. Admin roles (super_admin / management / sales_manager) are not
// limited. Distributor-side logins keep their existing per-distributor rules.
const pool = require('../db');

const LEVELS = ['RM', 'ASM', 'SO', 'SR'];
const MANAGER_LEVELS = ['RM', 'ASM', 'SO'];
const LEVEL_LABELS = { RM: 'Regional Manager', ASM: 'Area Sales Manager', SO: 'Sales Officer', SR: 'Sales Representative' };
// Who an employee at each level reports to
const REPORTS_TO = { RM: null, ASM: 'RM', SO: 'ASM', SR: 'SO' };

function isAreaManager(user) {
  return !!user && user.role === 'field_employee' && MANAGER_LEVELS.includes(user.level);
}

// Distributor ids an employee covers, from their level and area assignment.
async function distributorIdsForEmployee(employeeId, level) {
  let rows;
  if (level === 'RM') {
    [rows] = await pool.query(
      `SELECT DISTINCT d.id
       FROM distributors d
       JOIN territories t ON t.id = d.territory_id
       LEFT JOIN territory_districts td ON td.territory_id = t.id
       JOIN employee_states es ON es.employee_id = ? AND (es.state = td.state OR es.state = t.state)`,
      [employeeId]
    );
  } else if (level === 'ASM') {
    [rows] = await pool.query(
      `SELECT d.id FROM distributors d
       JOIN employee_territories et ON et.territory_id = d.territory_id AND et.employee_id = ?`,
      [employeeId]
    );
  } else {
    [rows] = await pool.query('SELECT distributor_id AS id FROM employee_distributors WHERE employee_id = ?', [employeeId]);
  }
  return rows.map((r) => r.id);
}

// Cached on the request so a route that checks scope several times hits the DB once.
async function areaDistributorIds(req) {
  if (!isAreaManager(req.user)) return null; // null = not area-limited (or not an area view)
  if (!req._areaDistributorIds) {
    req._areaDistributorIds = await distributorIdsForEmployee(req.user.employee_id, req.user.level);
  }
  return req._areaDistributorIds;
}

// For `col IN (?)`: an empty area must match nothing, and MySQL rejects `IN ()`.
function inList(ids) {
  return ids && ids.length ? ids : [-1];
}

// The employee plus everyone reporting to them, directly or indirectly.
async function teamEmployeeIds(employeeId) {
  const [rows] = await pool.query('SELECT id, reporting_manager_id FROM employees');
  const children = new Map();
  rows.forEach((r) => {
    if (!children.has(r.reporting_manager_id)) children.set(r.reporting_manager_id, []);
    children.get(r.reporting_manager_id).push(r.id);
  });
  const out = new Set([employeeId]);
  const queue = [employeeId];
  while (queue.length) {
    const id = queue.shift();
    for (const c of children.get(id) || []) if (!out.has(c)) { out.add(c); queue.push(c); }
  }
  return [...out];
}

module.exports = {
  LEVELS, MANAGER_LEVELS, LEVEL_LABELS, REPORTS_TO,
  isAreaManager, distributorIdsForEmployee, areaDistributorIds, inList, teamEmployeeIds,
};
