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

// Distributor (primary) sales dashboard — the stock MIJO sells and dispatches to distributors.
// Ordered figures go by order date; dispatched figures go by the dispatch plan date (when the stock left).
const ISO = /^\d{4}-\d{2}-\d{2}$/;
router.get('/distributor', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const to = ISO.test(req.query.to || '') ? req.query.to : today;
  const from = ISO.test(req.query.from || '') ? req.query.from : to;
  if (from > to) return res.status(400).json({ error: 'From date is after To date' });
  if ((new Date(to) - new Date(from)) / 86400000 > 366) return res.status(400).json({ error: 'Pick a range of one year or less' });
  const a = f(req, 'o.distributor_id');
  const LIVE = "o.status NOT IN ('cancelled','rejected')";
  const SHIPPED = "o.status IN ('dispatched','delivered')";

  const [byStatus] = await pool.query(
    `SELECT o.status, COUNT(*) AS cnt, COALESCE(SUM(o.total_cartons),0) AS cartons, COALESCE(SUM(o.total_amount),0) AS value
     FROM distributor_orders o WHERE o.order_date BETWEEN ? AND ?${a.sql} GROUP BY o.status`,
    [from, to, ...a.p]);

  const [[dispatched]] = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(o.total_cartons),0) AS cartons, COALESCE(SUM(o.total_amount),0) AS value
     FROM distributor_orders o JOIN dispatch_plans p ON p.id = o.dispatch_plan_id
     WHERE ${SHIPPED} AND p.plan_date BETWEEN ? AND ?${a.sql}`,
    [from, to, ...a.p]);

  // Open pipeline right now, whatever the order date
  const [[pipeline]] = await pool.query(
    `SELECT SUM(o.status = 'submitted') AS awaiting_approval,
            COALESCE(SUM(CASE WHEN o.status = 'submitted' THEN o.total_amount END),0) AS awaiting_value,
            SUM(o.status IN ('approved','dispatch_planned')) AS to_dispatch,
            COALESCE(SUM(CASE WHEN o.status IN ('approved','dispatch_planned') THEN o.total_cartons END),0) AS to_dispatch_cartons,
            COALESCE(SUM(CASE WHEN o.status IN ('approved','dispatch_planned') THEN o.total_amount END),0) AS to_dispatch_value
     FROM distributor_orders o WHERE 1=1${a.sql}`,
    [...a.p]);

  const [orderedDaily] = await pool.query(
    `SELECT DATE_FORMAT(o.order_date, '%Y-%m-%d') AS d, COALESCE(SUM(o.total_amount),0) AS value
     FROM distributor_orders o WHERE ${LIVE} AND o.order_date BETWEEN ? AND ?${a.sql} GROUP BY o.order_date`,
    [from, to, ...a.p]);
  const [dispatchedDaily] = await pool.query(
    `SELECT DATE_FORMAT(p.plan_date, '%Y-%m-%d') AS d, COALESCE(SUM(o.total_amount),0) AS value
     FROM distributor_orders o JOIN dispatch_plans p ON p.id = o.dispatch_plan_id
     WHERE ${SHIPPED} AND p.plan_date BETWEEN ? AND ?${a.sql} GROUP BY p.plan_date`,
    [from, to, ...a.p]);

  const dArea = f(req, 'd.id');
  const [byDistributor] = await pool.query(
    `SELECT d.id, d.name, d.code, t.name AS territory_name,
            COUNT(o.id) AS order_count,
            COALESCE(SUM(o.total_cartons),0) AS cartons,
            COALESCE(SUM(o.total_amount),0) AS order_value,
            COALESCE(SUM(CASE WHEN ${SHIPPED} THEN o.total_amount END),0) AS dispatched_value,
            COALESCE(SUM(CASE WHEN o.status IN ('submitted','approved','dispatch_planned') THEN o.total_amount END),0) AS pending_value,
            (SELECT DATE_FORMAT(MAX(x.order_date), '%Y-%m-%d') FROM distributor_orders x
              WHERE x.distributor_id = d.id AND x.status NOT IN ('cancelled','rejected')) AS last_order_date
     FROM distributors d
     LEFT JOIN territories t ON t.id = d.territory_id
     LEFT JOIN distributor_orders o ON o.distributor_id = d.id AND ${LIVE} AND o.order_date BETWEEN ? AND ?
     WHERE d.status = 'active'${dArea.sql}
     GROUP BY d.id ORDER BY order_value DESC, d.name`,
    [from, to, ...dArea.p]);

  const [byBooker] = await pool.query(
    `SELECT COALESCE(e.name, u.name, 'Unknown') AS name, e.designation, COUNT(o.id) AS order_count,
            COALESCE(SUM(o.total_cartons),0) AS cartons, COALESCE(SUM(o.total_amount),0) AS order_value
     FROM distributor_orders o
     LEFT JOIN employees e ON e.id = o.booked_by_employee
     LEFT JOIN users u ON u.id = o.booked_by_user
     WHERE ${LIVE} AND o.order_date BETWEEN ? AND ?${a.sql}
     GROUP BY COALESCE(e.name, u.name, 'Unknown'), e.designation ORDER BY order_value DESC LIMIT 20`,
    [from, to, ...a.p]);

  const [topSkus] = await pool.query(
    `SELECT p.name, p.sku_code, SUM(l.qty) AS packs, SUM(l.qty / GREATEST(p.units_per_carton, 1)) AS cartons,
            SUM(l.net_amount) AS value
     FROM distributor_order_lines l
     JOIN distributor_orders o ON o.id = l.order_id
     JOIN products p ON p.id = l.product_id
     WHERE ${LIVE} AND o.order_date BETWEEN ? AND ?${a.sql}
     GROUP BY p.id ORDER BY value DESC LIMIT 15`,
    [from, to, ...a.p]);

  const [byTerritory] = await pool.query(
    `SELECT COALESCE(t.name, 'No territory') AS name, COUNT(o.id) AS order_count,
            COALESCE(SUM(o.total_cartons),0) AS cartons, COALESCE(SUM(o.total_amount),0) AS order_value
     FROM distributor_orders o
     JOIN distributors d ON d.id = o.distributor_id
     LEFT JOIN territories t ON t.id = d.territory_id
     WHERE ${LIVE} AND o.order_date BETWEEN ? AND ?${a.sql}
     GROUP BY t.id, t.name ORDER BY order_value DESC`,
    [from, to, ...a.p]);

  res.json({ from, to, byStatus, dispatched, pipeline, orderedDaily, dispatchedDaily, byDistributor, byBooker, topSkus, byTerritory });
});

module.exports = router;
