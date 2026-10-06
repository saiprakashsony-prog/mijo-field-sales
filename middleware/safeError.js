// Database errors carry table names, column names and constraint details. Those help an
// attacker map your schema and mean nothing to a user, so they are logged on the server
// and replaced with a generic message. Deliberate, human-written errors (e.g.
// throw new Error('Retailer not found')) pass through unchanged.
function isDatabaseError(e) {
  if (!e) return false;
  if (e.sqlMessage || e.sqlState) return true;                              // MySQL/MariaDB server errors
  if (typeof e.code === 'string' && e.code.startsWith('ER_')) return true;  // MySQL error codes
  if (typeof e.code === 'string' && e.syscall) return true;                 // network-level (ECONNREFUSED, ETIMEDOUT, ...)
  return false;
}

function safeMsg(e) {
  if (isDatabaseError(e)) {
    console.error('Database error (hidden from client):', e.code || '', e.sqlMessage || e.message);
    return 'Something went wrong while saving. Please check your entries and try again.';
  }
  return (e && e.message) || 'Something went wrong.';
}

module.exports = { safeMsg, isDatabaseError };
