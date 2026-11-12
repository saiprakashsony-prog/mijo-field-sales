// Dispatch route planning
//  - Factory → distributor dispatch plans (admin / management / sales manager): pick distributors,
//    enter cases, the browser works out the delivery order and vehicle split, and the plan is saved here.
//  - Distributor → retailer delivery stops (distributor / delivery executive): today's open orders
//    grouped by retailer, with the retailer GPS pins, for the in-app delivery route.
const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');
const { safeMsg } = require('../middleware/safeError');

const router = express.Router();
router.use(authRequired);

const PLANNERS = ['super_admin', 'management', 'sales_manager'];
const DELIVERY_STATUSES = ['accepted', 'picking', 'packing', 'ready_for_dispatch', 'dispatched'];

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
function validLatLng(lat, lng) {
  // India bounding box — catches swapped lat/lng and typos
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 5 && lat < 38 && lng > 67 && lng < 99;
}
function str(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// ---------- Distributor locations ----------
router.get('/distributors', allowRoles(...PLANNERS), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT d.id, d.code, d.name, d.mobile, d.address, d.gps_lat, d.gps_lng, d.location_label,
            t.name AS territory_name
     FROM distributors d
     LEFT JOIN territories t ON t.id = d.territory_id
     WHERE d.status = 'active'
     ORDER BY d.name`
  );
  res.json(rows);
});

// Admins can set any distributor's location; a distributor login can set its own.
router.patch('/distributors/:id/location', allowRoles(...PLANNERS, 'distributor'), async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role === 'sales_manager') return res.status(403).json({ error: 'Not permitted for this role' });
  if (req.user.role === 'distributor' && id !== req.user.distributor_id) {
    return res.status(403).json({ error: 'You can only set your own location' });
  }
  const lat = num(req.body.gps_lat);
  const lng = num(req.body.gps_lng);
  if (!validLatLng(lat, lng)) return res.status(400).json({ error: 'Please set a valid location in India' });
  const [result] = await pool.query(
    'UPDATE distributors SET gps_lat = ?, gps_lng = ?, location_label = ? WHERE id = ?',
    [lat, lng, str(req.body.location_label, 150), id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Distributor not found' });
  await pool.query(
    `INSERT INTO audit_log (entity_type, entity_id, action, changed_by, after_json) VALUES ('distributor', ?, 'update', ?, ?)`,
    [id, req.user.id, JSON.stringify({ gps_lat: lat, gps_lng: lng, location_label: str(req.body.location_label, 150) })]
  );
  res.json({ ok: true });
});

// ---------- Dispatch plans ----------
function genPlanNo() {
  return 'MIJO/DSP/' + Date.now().toString().slice(-9);
}

router.get('/plans', allowRoles(...PLANNERS), async (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const params = [];
  if (from && to) { where.push('p.plan_date BETWEEN ? AND ?'); params.push(from, to); }
  const [rows] = await pool.query(
    `SELECT p.id, p.plan_no, DATE_FORMAT(p.plan_date, '%Y-%m-%d') AS plan_date, p.origin_label, p.total_km, p.status, p.created_at,
            u.name AS created_by_name,
            (SELECT COUNT(*) FROM dispatch_plan_vehicles v WHERE v.plan_id = p.id) AS vehicle_count,
            (SELECT COUNT(*) FROM dispatch_plan_stops s WHERE s.plan_id = p.id) AS stop_count,
            (SELECT COALESCE(SUM(s.cases), 0) FROM dispatch_plan_stops s WHERE s.plan_id = p.id) AS total_cases
     FROM dispatch_plans p
     LEFT JOIN users u ON u.id = p.created_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.plan_date DESC, p.id DESC
     LIMIT 100`,
    params
  );
  res.json(rows);
});

router.get('/plans/last-origin', allowRoles(...PLANNERS), async (req, res) => {
  const [[row]] = await pool.query(
    'SELECT origin_label, origin_lat, origin_lng FROM dispatch_plans ORDER BY id DESC LIMIT 1'
  );
  res.json(row || null);
});

router.get('/plans/:id', allowRoles(...PLANNERS), async (req, res) => {
  const [[plan]] = await pool.query("SELECT *, DATE_FORMAT(plan_date, '%Y-%m-%d') AS plan_date FROM dispatch_plans WHERE id = ?", [req.params.id]);
  if (!plan) return res.status(404).json({ error: 'Not found' });
  const [vehicles] = await pool.query('SELECT * FROM dispatch_plan_vehicles WHERE plan_id = ? ORDER BY vehicle_no', [plan.id]);
  const [stops] = await pool.query(
    `SELECT s.*, d.name AS distributor_name, d.code AS distributor_code, d.mobile AS distributor_mobile,
            d.address AS distributor_address, d.location_label, d.gps_lat, d.gps_lng
     FROM dispatch_plan_stops s
     JOIN distributors d ON d.id = s.distributor_id
     WHERE s.plan_id = ?
     ORDER BY s.vehicle_no, s.stop_seq`,
    [plan.id]
  );
  const [linkedOrders] = await pool.query(
    'SELECT id, order_no, distributor_id, total_cartons, status FROM distributor_orders WHERE dispatch_plan_id = ? ORDER BY id', [plan.id]);
  res.json({
    ...plan,
    linked_orders: linkedOrders,
    vehicles: vehicles.map((v) => ({ ...v, stops: stops.filter((s) => s.vehicle_no === v.vehicle_no) })),
  });
});

router.post('/plans', allowRoles(...PLANNERS), async (req, res) => {
  const b = req.body || {};
  const originLat = num(b.origin_lat);
  const originLng = num(b.origin_lng);
  if (!b.plan_date || !/^\d{4}-\d{2}-\d{2}$/.test(b.plan_date)) return res.status(400).json({ error: 'Dispatch date is required' });
  if (!validLatLng(originLat, originLng)) return res.status(400).json({ error: 'Start location is missing or invalid' });
  if (!/^\d{2}:\d{2}$/.test(b.depart_time || '')) return res.status(400).json({ error: 'Departure time is required' });
  const vehicles = Array.isArray(b.vehicles) ? b.vehicles : [];
  if (!vehicles.length || vehicles.length > 30) return res.status(400).json({ error: 'A plan needs between 1 and 30 vehicles' });
  const capacity = b.capacity_cases === null || b.capacity_cases === undefined || b.capacity_cases === '' ? 0 : Number(b.capacity_cases);
  if (!Number.isFinite(capacity) || capacity < 0) return res.status(400).json({ error: 'Invalid vehicle capacity' });
  if (capacity > 0) {
    for (let i = 0; i < vehicles.length; i++) {
      const load = (Array.isArray(vehicles[i].stops) ? vehicles[i].stops : []).reduce((a, s) => a + (Number(s.cases) || 0), 0);
      if (load > capacity + 1e-6) {
        return res.status(400).json({ error: `Vehicle ${i + 1} carries ${load} cases, more than its ${capacity}-case capacity` });
      }
    }
  }

  const allStops = vehicles.flatMap((v) => (Array.isArray(v.stops) ? v.stops : []));
  if (!allStops.length) return res.status(400).json({ error: 'A plan needs at least one distributor stop' });
  if (allStops.length > 200) return res.status(400).json({ error: 'Too many stops in one plan' });
  // A distributor may be split across vehicles (order bigger than one truck), but not repeated within one vehicle
  for (const v of vehicles) {
    const vIds = (Array.isArray(v.stops) ? v.stops : []).map((s) => Number(s.distributor_id));
    if (new Set(vIds).size !== vIds.length) return res.status(400).json({ error: 'A distributor appears twice in the same vehicle' });
  }
  const ids = [...new Set(allStops.map((s) => Number(s.distributor_id)))];
  const [found] = await pool.query(`SELECT id FROM distributors WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (found.length !== ids.length) return res.status(400).json({ error: 'One or more distributors no longer exist' });

  const totalKm = vehicles.reduce((a, v) => a + (Number(v.total_km) || 0), 0);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const planNo = genPlanNo();
    const [r] = await conn.query(
      `INSERT INTO dispatch_plans (plan_no, plan_date, origin_label, origin_lat, origin_lng, depart_time, return_to_origin,
                                   avg_speed_kmph, unload_minutes, capacity_cases, total_km, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [planNo, b.plan_date, str(b.origin_label, 150) || 'Start', originLat, originLng, b.depart_time + ':00',
        b.return_to_origin ? 1 : 0, Math.round(Number(b.avg_speed_kmph) || 40), Math.round(Number(b.unload_minutes) || 0),
        capacity > 0 ? capacity : null, Math.round(totalKm * 10) / 10, str(b.notes, 255), req.user.id]
    );
    const planId = r.insertId;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const vehicleNo = i + 1;
      await conn.query(
        `INSERT INTO dispatch_plan_vehicles (plan_id, vehicle_no, vehicle_reg, driver_name, driver_mobile, total_km)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [planId, vehicleNo, str(v.vehicle_reg, 30), str(v.driver_name, 100), str(v.driver_mobile, 20), Math.round((Number(v.total_km) || 0) * 10) / 10]
      );
      const stops = Array.isArray(v.stops) ? v.stops : [];
      for (let j = 0; j < stops.length; j++) {
        const s = stops[j];
        await conn.query(
          `INSERT INTO dispatch_plan_stops (plan_id, vehicle_no, stop_seq, distributor_id, cases, leg_km, eta_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [planId, vehicleNo, j + 1, Number(s.distributor_id), Math.max(0, Number(s.cases) || 0),
            Math.round((Number(s.leg_km) || 0) * 10) / 10, Math.max(0, Math.round(Number(s.eta_minutes) || 0))]
        );
      }
    }
    // Link approved distributor orders loaded into this plan (only ones for distributors on it)
    const orderIds = [...new Set((Array.isArray(b.distributor_order_ids) ? b.distributor_order_ids : []).map(Number).filter(Boolean))];
    let linked = 0;
    if (orderIds.length) {
      const [r2] = await conn.query(
        `UPDATE distributor_orders SET status = 'dispatch_planned', dispatch_plan_id = ?
         WHERE id IN (?) AND status = 'approved' AND dispatch_plan_id IS NULL AND distributor_id IN (?)`,
        [planId, orderIds, ids]
      );
      linked = r2.affectedRows;
    }
    await conn.commit();
    res.status(201).json({ id: planId, plan_no: planNo, linked_orders: linked });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: safeMsg(e) });
  } finally {
    conn.release();
  }
});

router.patch('/plans/:id', allowRoles(...PLANNERS), async (req, res) => {
  const { status, vehicles } = req.body || {};
  const [[plan]] = await pool.query('SELECT id FROM dispatch_plans WHERE id = ?', [req.params.id]);
  if (!plan) return res.status(404).json({ error: 'Not found' });
  if (status !== undefined) {
    if (!['planned', 'dispatched', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await pool.query('UPDATE dispatch_plans SET status = ? WHERE id = ?', [status, plan.id]);
    await syncLinkedOrders(plan.id, status);
  }
  // Vehicle / driver details can be filled in after the plan is saved
  if (Array.isArray(vehicles)) {
    for (const v of vehicles) {
      await pool.query(
        'UPDATE dispatch_plan_vehicles SET vehicle_reg = ?, driver_name = ?, driver_mobile = ? WHERE plan_id = ? AND vehicle_no = ?',
        [str(v.vehicle_reg, 30), str(v.driver_name, 100), str(v.driver_mobile, 20), plan.id, Number(v.vehicle_no)]
      );
    }
  }
  res.json({ ok: true });
});

// Distributor orders on a plan follow it: dispatched → dispatched, completed → delivered,
// cancelled (or plan deleted) → released back to approved so they can be planned again.
async function syncLinkedOrders(planId, planStatus) {
  if (planStatus === 'cancelled') {
    await pool.query(
      `UPDATE distributor_orders SET status = 'approved', dispatch_plan_id = NULL
       WHERE dispatch_plan_id = ? AND status IN ('dispatch_planned','dispatched')`, [planId]);
    return;
  }
  const map = { planned: 'dispatch_planned', dispatched: 'dispatched', completed: 'delivered' };
  if (map[planStatus]) {
    await pool.query(
      `UPDATE distributor_orders SET status = ? WHERE dispatch_plan_id = ? AND status IN ('dispatch_planned','dispatched','delivered')`,
      [map[planStatus], planId]);
  }
}

router.delete('/plans/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  await syncLinkedOrders(Number(req.params.id), 'cancelled');
  await pool.query('DELETE FROM dispatch_plans WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Distributor → retailer delivery stops ----------
// One stop per retailer, combining all of that retailer's open orders.
router.get('/delivery-stops', allowRoles('distributor', 'delivery_executive', ...PLANNERS), async (req, res) => {
  const distributorId = ['distributor', 'delivery_executive'].includes(req.user.role)
    ? req.user.distributor_id
    : Number(req.query.distributor_id);
  if (!distributorId) return res.status(400).json({ error: 'distributor_id is required' });

  const [[origin]] = await pool.query(
    'SELECT id, name, gps_lat, gps_lng, location_label, address FROM distributors WHERE id = ?',
    [distributorId]
  );
  if (!origin) return res.status(404).json({ error: 'Distributor not found' });

  const [orders] = await pool.query(
    `SELECT o.id, o.order_no, o.status, o.total_amount, o.order_date,
            r.id AS retailer_id, r.name AS retailer_name, r.code AS retailer_code, r.mobile AS retailer_mobile,
            r.address AS retailer_address, r.gps_lat, r.gps_lng,
            COALESCE(SUM(ol.carton_qty), 0) AS cartons,
            COALESCE(SUM(ol.pack_qty), 0) AS loose_packs,
            COALESCE(SUM(ol.qty / GREATEST(p.units_per_carton, 1)), 0) AS carton_equiv
     FROM orders o
     JOIN retailers r ON r.id = o.retailer_id
     LEFT JOIN order_lines ol ON ol.order_id = o.id
     LEFT JOIN products p ON p.id = ol.product_id
     WHERE o.distributor_id = ? AND o.status IN (${DELIVERY_STATUSES.map(() => '?').join(',')})
     GROUP BY o.id
     ORDER BY o.order_date, o.id`,
    [distributorId, ...DELIVERY_STATUSES]
  );

  const byRetailer = new Map();
  for (const o of orders) {
    if (!byRetailer.has(o.retailer_id)) {
      byRetailer.set(o.retailer_id, {
        retailer_id: o.retailer_id, retailer_name: o.retailer_name, retailer_code: o.retailer_code,
        retailer_mobile: o.retailer_mobile, retailer_address: o.retailer_address,
        gps_lat: o.gps_lat == null ? null : Number(o.gps_lat), gps_lng: o.gps_lng == null ? null : Number(o.gps_lng),
        orders: [], cartons: 0, loose_packs: 0, carton_equiv: 0, total_amount: 0,
      });
    }
    const s = byRetailer.get(o.retailer_id);
    s.orders.push({ id: o.id, order_no: o.order_no, status: o.status, order_date: o.order_date });
    s.cartons += Number(o.cartons);
    s.loose_packs += Number(o.loose_packs);
    s.carton_equiv += Number(o.carton_equiv);
    s.total_amount += Number(o.total_amount);
  }
  res.json({
    origin: {
      id: origin.id, name: origin.name, label: origin.location_label || origin.address || origin.name,
      gps_lat: origin.gps_lat == null ? null : Number(origin.gps_lat),
      gps_lng: origin.gps_lng == null ? null : Number(origin.gps_lng),
    },
    stops: [...byRetailer.values()],
  });
});

module.exports = router;
