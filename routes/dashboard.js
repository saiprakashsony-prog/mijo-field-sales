const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);
router.use(allowRoles('super_admin', 'management', 'sales_manager'));

router.get('/summary', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  const [[orderStats]] = await pool.query(
    `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS order_value
     FROM orders WHERE order_date = ? AND status <> 'cancelled'`,
    [date]
  );
  const [[retailerStats]] = await pool.query(
    `SELECT
        (SELECT COUNT(*) FROM retailers) AS total,
        (SELECT COUNT(*) FROM retailers WHERE status='active') AS active,
        (SELECT COUNT(*) FROM retailers WHERE DATE(created_at) = ?) AS new_today,
        (SELECT COUNT(DISTINCT retailer_id) FROM orders WHERE order_date = ?) AS ordering_today`,
    [date, date]
  );
  const [[visitStats]] = await pool.query(
    `SELECT COUNT(*) AS total_visits,
            SUM(CASE WHEN visit_type='productive' THEN 1 ELSE 0 END) AS productive,
            SUM(CASE WHEN visit_type='non_productive' THEN 1 ELSE 0 END) AS non_productive
     FROM visits WHERE DATE(checkin_time) = ?`,
    [date]
  );
  const [byStatus] = await pool.query(
    `SELECT status, COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS value
     FROM orders WHERE order_date = ? GROUP BY status`,
    [date]
  );
  const [byDistributor] = await pool.query(
    `SELECT d.id, d.name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount),0) AS order_value
     FROM distributors d LEFT JOIN orders o ON o.distributor_id = d.id AND o.order_date = ? AND o.status <> 'cancelled'
     GROUP BY d.id ORDER BY order_value DESC`,
    [date]
  );
  const [byEmployee] = await pool.query(
    `SELECT e.id, e.name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount),0) AS order_value
     FROM employees e LEFT JOIN orders o ON o.employee_id = e.id AND o.order_date = ? AND o.status <> 'cancelled'
     GROUP BY e.id ORDER BY order_value DESC`,
    [date]
  );
  const [topSkus] = await pool.query(
    `SELECT p.name, p.sku_code, SUM(ol.qty) AS qty, SUM(ol.net_amount) AS value
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products p ON p.id = ol.product_id
     WHERE o.order_date = ? AND o.status <> 'cancelled'
     GROUP BY p.id ORDER BY value DESC LIMIT 10`,
    [date]
  );

  res.json({ date, orderStats, retailerStats, visitStats, byStatus, byDistributor, byEmployee, topSkus });
});

module.exports = router;
