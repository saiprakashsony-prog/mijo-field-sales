const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const DUP_RADIUS_METERS = 100; // configurable proximity radius, BRD 6

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

  const code = genCode();
  const [result] = await pool.query(
    `INSERT INTO retailers (code, name, owner_name, mobile, address, pincode, territory_id, gstin, pan, shop_type, photo_url, gps_lat, gps_lng, distributor_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, name, owner_name || null, mobile, address, pincode || null, territory_id || null, gstin || null, pan || null, shop_type, photo_url || null, gps_lat, gps_lng, distributor_id, employeeId || req.body.created_by]
  );
  res.status(201).json({ id: result.insertId, code });
});

module.exports = router;
