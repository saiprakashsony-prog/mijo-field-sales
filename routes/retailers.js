const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const DUP_RADIUS_METERS = 100; // configurable proximity radius, BRD 6
const GEOFENCE_RADIUS_METERS = 100; // a field employee must be physically within this of the pin they're saving (BRD 14, 19)

function genCode() {
  return 'RTL' + Date.now().toString().slice(-8);
}

// Haversine distance in meters
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

router.get('/', async (req, res) => {
  const { distributor_id, territory_id, employee_id, q } = req.query;
  const where = [];
  const params = [];
  if (distributor_id) { where.push('r.distributor_id = ?'); params.push(distributor_id); }
  if (territory_id) { where.push('r.territory_id = ?'); params.push(territory_id); }
  if (employee_id) { where.push('r.created_by = ?'); params.push(employee_id); }
  if (q) { where.push('(r.name LIKE ? OR r.mobile LIKE ? OR r.code LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `SELECT r.*, d.name AS distributor_name, t.name AS territory_name
               FROM retailers r
               LEFT JOIN distributors d ON d.id = r.distributor_id
               LEFT JOIN territories t ON t.id = r.territory_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY r.created_at DESC`;
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

// Pre-check for duplicates before final submit (BRD 6)
router.post('/check-duplicate', async (req, res) => {
  const { mobile, gstin, name, gps_lat, gps_lng } = req.body;
  const matches = [];

  if (mobile) {
    const [r1] = await pool.query('SELECT id, code, name, mobile FROM retailers WHERE mobile = ?', [mobile]);
    matches.push(...r1.map((r) => ({ ...r, matched_on: 'mobile' })));
  }
  if (gstin) {
    const [r2] = await pool.query('SELECT id, code, name, gstin FROM retailers WHERE gstin = ?', [gstin]);
    matches.push(...r2.map((r) => ({ ...r, matched_on: 'gstin' })));
  }
  if (name) {
    const [r3] = await pool.query('SELECT id, code, name FROM retailers WHERE name LIKE ?', [name]);
    matches.push(...r3.map((r) => ({ ...r, matched_on: 'name' })));
  }
  if (gps_lat != null && gps_lng != null) {
    const [nearby] = await pool.query(
      `SELECT id, code, name, gps_lat, gps_lng FROM retailers
       WHERE gps_lat BETWEEN ? AND ? AND gps_lng BETWEEN ? AND ?`,
      [Number(gps_lat) - 0.002, Number(gps_lat) + 0.002, Number(gps_lng) - 0.002, Number(gps_lng) + 0.002]
    );
    for (const n of nearby) {
      const d = distanceMeters(Number(gps_lat), Number(gps_lng), Number(n.gps_lat), Number(n.gps_lng));
      if (d <= DUP_RADIUS_METERS) matches.push({ ...n, matched_on: 'gps_proximity', distance_m: Math.round(d) });
    }
  }
  res.json({ possible_duplicates: matches });
});

router.post('/', async (req, res) => {
  const {
    name, owner_name, mobile, address, pincode, territory_id,
    gstin, pan, shop_type, photo_url, gps_lat, gps_lng, distributor_id,
    device_lat, device_lng,
  } = req.body;

  if (!name || !mobile || !address || !shop_type) {
    return res.status(400).json({ error: 'name, mobile, address, shop_type are required' });
  }
  if (gps_lat == null || gps_lng == null) {
    return res.status(400).json({ error: 'GPS latitude/longitude is mandatory for new retailer creation (BRD 6, 14, 19)' });
  }
  if (!distributor_id) {
    return res.status(400).json({ error: 'Every retailer must be mapped to a distributor (BRD 19)' });
  }

  const employeeId = req.user.employee_id;
  if (req.user.role === 'field_employee' && !employeeId) {
    return res.status(400).json({ error: 'Logged-in user has no linked employee record' });
  }

  // Geofence: a field employee must be physically near the pin they're saving, so a
  // retailer can't be created from far away. Only enforced for field_employee logins —
  // admin/management users entering data from the office are not restricted by this.
  if (req.user.role === 'field_employee') {
    if (device_lat == null || device_lng == null) {
      return res.status(400).json({ error: 'Could not verify your current location. Please enable location access and try again.' });
    }
    const distFromDevice = distanceMeters(Number(gps_lat), Number(gps_lng), Number(device_lat), Number(device_lng));
    if (distFromDevice > GEOFENCE_RADIUS_METERS) {
      return res.status(400).json({ error: `The selected location is ${Math.round(distFromDevice)}m from your current position — it must be within ${GEOFENCE_RADIUS_METERS}m. Move closer to the shop or adjust the pin.` });
    }
  }

  const code = genCode();
  const [result] = await pool.query(
    `INSERT INTO retailers (code, name, owner_name, mobile, address, pincode, territory_id, gstin, pan, shop_type, photo_url, gps_lat, gps_lng, distributor_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, name, owner_name || null, mobile, address, pincode || null, territory_id || null, gstin || null, pan || null, shop_type, photo_url || null, gps_lat, gps_lng, distributor_id, employeeId || req.body.created_by]
  );
  res.status(201).json({ id: result.insertId, code });
});

// Simplified retailer-level credit calculation — not per-invoice ageing:
//   outstanding = SUM(total_amount of billed orders) - SUM(payments), floored at 0
//   is_overdue  = true if any billed order's (order_date + payment_terms_days) is in the
//                 past AND there's still an outstanding balance. This flags the retailer
//                 as a whole, not which specific invoice is overdue.
// "Billed" = dispatched or delivered orders (not cancelled, and not still mid-flow).
async function computeCreditStatus(conn, retailerId) {
  const [[retailer]] = await conn.query('SELECT credit_limit, payment_terms_days FROM retailers WHERE id = ?', [retailerId]);
  if (!retailer) return null;

  const [[{ total_billed }]] = await conn.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS total_billed FROM orders
     WHERE retailer_id = ? AND status IN ('dispatched', 'delivered')`,
    [retailerId]
  );
  const [[{ total_paid }]] = await conn.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE retailer_id = ?`,
    [retailerId]
  );
  const outstanding = Math.max(0, Math.round((Number(total_billed) - Number(total_paid)) * 100) / 100);

  const [[{ oldest_overdue_date }]] = await conn.query(
    `SELECT MIN(order_date) AS oldest_overdue_date FROM orders
     WHERE retailer_id = ? AND status IN ('dispatched', 'delivered')
       AND DATE_ADD(order_date, INTERVAL ? DAY) < CURDATE()`,
    [retailerId, retailer.payment_terms_days]
  );
  const isOverdue = outstanding > 0 && !!oldest_overdue_date;

  return {
    credit_limit: Number(retailer.credit_limit),
    payment_terms_days: retailer.payment_terms_days,
    total_billed: Number(total_billed),
    total_paid: Number(total_paid),
    outstanding_balance: outstanding,
    available_credit: retailer.credit_limit > 0 ? Math.round((Number(retailer.credit_limit) - outstanding) * 100) / 100 : null,
    is_overdue: isOverdue,
    oldest_overdue_date: oldest_overdue_date || null,
  };
}

router.get('/:id/credit-status', async (req, res) => {
  const status = await computeCreditStatus(pool, req.params.id);
  if (!status) return res.status(404).json({ error: 'Not found' });
  res.json(status);
});

// Edit retailer basics + credit settings (admin only for credit fields; the retailer record
// itself may already exist from a field employee's New Retailer flow).
router.patch('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  const fields = ['name', 'owner_name', 'mobile', 'address', 'pincode', 'gstin', 'shop_type', 'status', 'credit_limit', 'payment_terms_days'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  await pool.query(`UPDATE retailers SET ${updates.join(', ')} WHERE id = ?`, values);
  res.json({ ok: true });
});

module.exports = { router, computeCreditStatus };
