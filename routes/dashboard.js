const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const { areaDistributorIds, isAreaManager, inList, teamEmployeeIds } = require('../middleware/scope');

const router = express.Router();
router.use(authRequired);

// Company-wide for admin roles; RM / ASM / SO see the same dashboard limited to their area
// (the distributors they cover, and their own team for the employee tables).
router.use(async (req, res, next) => {
  if (['super_admin', 'management', 'sales_manager'].includes(req.user.role)) { req.area = null; return next(); }
  if (!isAreaManager(req.user)) return res.status(403).json({ error: 'Not permitted for this role' });
  req.area = {
    distributors: inList(await areaDistributorIds(req)),
    team: inList(await teamEmployeeIds(req.user.employee_id)),
  };
  next();
});

// SQL fragments: " AND <col> IN (?)" plus its parameter, or nothing when not area-limited
function f(req, col, kind = 'distributors') {
  return req.area ? { sql: ` AND ${col} IN (?)`, p: [req.area[kind]] } : { sql: '', p: [] };
}

router.get('/summary', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  const [[orderStats]] = await pool.query(
    `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS order_value
     FROM orders WHERE order_date = ? AND status <> 'cancelled'${f(req, 'distributor_id').sql}`,
    [date, ...f(req, 'distributor_id').p]
  );
  const rd = f(req, 'distributor_id');
  const [[retailerStats]] = await pool.query(
    `SELECT
        (SELECT COUNT(*) FROM retailers WHERE 1=1${rd.sql}) AS total,
        (SELECT COUNT(*) FROM retailers WHERE status='active'${rd.sql}) AS active,
        (SELECT COUNT(*) FROM retailers WHERE DATE(created_at) = ?${rd.sql}) AS new_today,
        (SELECT COUNT(DISTINCT retailer_id) FROM orders WHERE order_date = ?${rd.sql}) AS ordering_today`,
    [...rd.p, ...rd.p, date, ...rd.p, date, ...rd.p]
  );
  const [[visitStats]] = await pool.query(
    `SELECT COUNT(*) AS total_visits,
            SUM(CASE WHEN v.visit_type='productive' THEN 1 ELSE 0 END) AS productive,
            SUM(CASE WHEN v.visit_type='non_productive' THEN 1 ELSE 0 END) AS non_productive
     FROM visits v JOIN retailers r ON r.id = v.retailer_id
     WHERE DATE(v.checkin_time) = ?${f(req, 'r.distributor_id').sql}`,
    [date, ...f(req, 'r.distributor_id').p]
  );
  const [byStatus] = await pool.query(
    `SELECT status, COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS value
     FROM orders WHERE order_date = ?${f(req, 'distributor_id').sql} GROUP BY status`,
    [date, ...f(req, 'distributor_id').p]
  );
  const [byDistributor] = await pool.query(
    `SELECT d.id, d.name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount),0) AS order_value
     FROM distributors d LEFT JOIN orders o ON o.distributor_id = d.id AND o.order_date = ? AND o.status <> 'cancelled'
     WHERE 1=1${f(req, 'd.id').sql}
     GROUP BY d.id ORDER BY order_value DESC`,
    [date, ...f(req, 'd.id').p]
  );
  const [byEmployee] = await pool.query(
    `SELECT e.id, e.name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount),0) AS order_value
     FROM employees e LEFT JOIN orders o ON o.employee_id = e.id AND o.order_date = ? AND o.status <> 'cancelled'${f(req, 'o.distributor_id').sql}
     WHERE 1=1${f(req, 'e.id', 'team').sql}
     GROUP BY e.id ORDER BY order_value DESC`,
    [date, ...f(req, 'o.distributor_id').p, ...f(req, 'e.id', 'team').p]
  );
  const [topSkus] = await pool.query(
    `SELECT p.name, p.sku_code, SUM(ol.qty) AS qty, SUM(ol.net_amount) AS value
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products p ON p.id = ol.product_id
     WHERE o.order_date = ? AND o.status <> 'cancelled'${f(req, 'o.distributor_id').sql}
     GROUP BY p.id ORDER BY value DESC LIMIT 10`,
    [date, ...f(req, 'o.distributor_id').p]
  );

  res.json({ date, orderStats, retailerStats, visitStats, byStatus, byDistributor, byEmployee, topSkus });
});

// Ranking / performance views over a trailing window (default last 30 days), separate from
// the always-"today" snapshot above — these need a longer window to mean anything.
router.get('/performance', async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const toDateUTC = new Date(`${to}T00:00:00Z`);
  const fromStr = new Date(toDateUTC.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);

  const [fastMovingSkus] = await pool.query(
    `SELECT p.id, p.name, p.sku_code, p.category, SUM(ol.qty) AS total_qty, SUM(ol.net_amount) AS total_value,
            COUNT(DISTINCT o.id) AS order_count
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products p ON p.id = ol.product_id
     WHERE o.order_date BETWEEN ? AND ? AND o.status <> 'cancelled'${f(req, 'o.distributor_id').sql}
     GROUP BY p.id ORDER BY total_qty DESC LIMIT 15`,
    [fromStr, to, ...f(req, 'o.distributor_id').p]
  );

  const [byTerritory] = await pool.query(
    `SELECT t.id, t.name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount),0) AS order_value,
            COUNT(DISTINCT o.retailer_id) AS retailer_count
     FROM territories t
     LEFT JOIN retailers r ON r.territory_id = t.id${f(req, 'r.distributor_id').sql}
     LEFT JOIN orders o ON o.retailer_id = r.id AND o.order_date BETWEEN ? AND ? AND o.status <> 'cancelled'
     ${req.area ? 'WHERE t.id IN (SELECT territory_id FROM distributors WHERE id IN (?) AND territory_id IS NOT NULL)' : ''}
     GROUP BY t.id ORDER BY order_value DESC`,
    [...f(req, 'r.distributor_id').p, fromStr, to, ...(req.area ? [req.area.distributors] : [])]
  );

  const [topEmployees] = await pool.query(
    `SELECT e.id, e.name, e.code, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount),0) AS order_value,
            COUNT(DISTINCT o.retailer_id) AS retailer_count
     FROM employees e LEFT JOIN orders o ON o.employee_id = e.id AND o.order_date BETWEEN ? AND ? AND o.status <> 'cancelled'${f(req, 'o.distributor_id').sql}
     WHERE 1=1${f(req, 'e.id', 'team').sql}
     GROUP BY e.id ORDER BY order_value DESC LIMIT 15`,
    [fromStr, to, ...f(req, 'o.distributor_id').p, ...f(req, 'e.id', 'team').p]
  );

  const [topDistributors] = await pool.query(
    `SELECT d.id, d.name, d.code, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount),0) AS order_value
     FROM distributors d LEFT JOIN orders o ON o.distributor_id = d.id AND o.order_date BETWEEN ? AND ? AND o.status <> 'cancelled'
     WHERE 1=1${f(req, 'd.id').sql}
     GROUP BY d.id ORDER BY order_value DESC LIMIT 15`,
    [fromStr, to, ...f(req, 'd.id').p]
  );

  // Discount/scheme usage — populated once order booking actually applies a discount_amt per line;
  // the fields exist end-to-end already, so this lights up as soon as discounts start being used.
  const [[schemeOverall]] = await pool.query(
    `SELECT COALESCE(SUM(ol.discount_amt),0) AS total_discount,
            COUNT(DISTINCT CASE WHEN ol.discount_amt > 0 THEN o.id END) AS orders_with_discount,
            COUNT(DISTINCT o.id) AS total_orders
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id
     WHERE o.order_date BETWEEN ? AND ? AND o.status <> 'cancelled'${f(req, 'o.distributor_id').sql}`,
    [fromStr, to, ...f(req, 'o.distributor_id').p]
  );
  const [schemeBySku] = await pool.query(
    `SELECT p.id, p.name, p.sku_code, SUM(ol.discount_amt) AS total_discount, COUNT(DISTINCT o.id) AS order_count
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products p ON p.id = ol.product_id
     WHERE o.order_date BETWEEN ? AND ? AND o.status <> 'cancelled' AND ol.discount_amt > 0${f(req, 'o.distributor_id').sql}
     GROUP BY p.id ORDER BY total_discount DESC LIMIT 10`,
    [fromStr, to, ...f(req, 'o.distributor_id').p]
  );

  res.json({
    from: fromStr, to, days,
    fastMovingSkus, byTerritory, topEmployees, topDistributors,
    schemePerformance: { ...schemeOverall, bySku: schemeBySku },
  });
});

module.exports = router;
