const jwt = require('jsonwebtoken');
const pool = require('../db');

// A signed token only proves who someone was when they logged in. Previously nothing re-checked
// the account afterwards, so a deactivated user (or one whose employee/distributor record was
// deactivated) kept full access until their token expired. Now every request re-checks the
// database, so deactivation and role changes take effect immediately.
//
// A short in-memory cache keeps this cheap (one lookup per user per few seconds, not per request).
// It is cleared whenever an admin changes a user/employee/distributor status — see clearAuthCache.
const CACHE_TTL_MS = 10 * 1000;
const cache = new Map(); // userId -> { at, row }

function clearAuthCache() { cache.clear(); }

async function loadAccount(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.role, u.status, u.employee_id, u.distributor_id,
            e.status AS employee_status, d.status AS distributor_status
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN distributors d ON d.id = u.distributor_id
     WHERE u.id = ?`,
    [userId]
  );
  const row = rows[0] || null;
  cache.set(userId, { at: Date.now(), row });
  return row;
}

// A login is usable only if the user, and the employee/distributor record it is linked to, are all active.
function accountIsActive(row) {
  if (!row || row.status !== 'active') return false;
  if (row.employee_id && row.employee_status !== 'active') return false;
  if (row.distributor_id && row.distributor_status !== 'active') return false;
  return true;
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  let account;
  try {
    account = await loadAccount(claims.id);
  } catch (e) {
    console.error('auth lookup failed:', e);
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  }
  if (!accountIsActive(account)) {
    return res.status(401).json({ error: 'This account has been deactivated or no longer exists.' });
  }

  // Trust the database, not the token, for who this is and what they may do.
  req.user = {
    id: account.id, name: account.name, role: account.role,
    employee_id: account.employee_id, distributor_id: account.distributor_id,
  };
  next();
}

// Usage: allowRoles('super_admin', 'management')
function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not permitted for this role' });
    }
    next();
  };
}

module.exports = { authRequired, allowRoles, clearAuthCache, accountIsActive };
