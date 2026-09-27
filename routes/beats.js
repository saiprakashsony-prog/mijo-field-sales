const express = require('express');
const pool = require('../db');
const { authRequired, allowRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function todayDow() { return DOW[new Date().getDay()]; }

router.get('/', allowRoles('super_admin', 'management', 'sales_manager'), async (req, res) => {
  const [beats] = await pool.query(
    `SELECT b.*, t.name AS territory_name, e.name AS employee_name, e.code AS employee_code
     FROM beats b
     LEFT JOIN territories t ON t.id = b.territory_id
     LEFT JOIN employees e ON e.id = b.employee_id
     ORDER BY b.name`
  );
  const [days] = await pool.query('SELECT * FROM beat_days');
  const [retailerCounts] = await pool.query('SELECT beat_id, COUNT(*) AS cnt FROM beat_retailers GROUP BY beat_id');
  const daysByBeat = {};
  for (const d of days) (daysByBeat[d.beat_id] = daysByBeat[d.beat_id] || []).push(d.day_of_week);
  const countByBeat = Object.fromEntries(retailerCounts.map((r) => [r.beat_id, r.cnt]));
  res.json(beats.map((b) => ({ ...b, days: daysByBeat[b.id] || [], retailer_count: countByBeat[b.id] || 0 })));
});

router.get('/:id', allowRoles('super_admin', 'management', 'sales_manager'), async (req, res) => {
  const [[beat]] = await pool.query('SELECT * FROM beats WHERE id = ?', [req.params.id]);
  if (!beat) return res.status(404).json({ error: 'Not found' });
  const [days] = await pool.query('SELECT day_of_week FROM beat_days WHERE beat_id = ?', [req.params.id]);
  const [retailers] = await pool.query(
    `SELECT r.id, r.name, r.code, r.address, br.visit_order FROM beat_retailers br
     JOIN retailers r ON r.id = br.retailer_id WHERE br.beat_id = ? ORDER BY br.visit_order, r.name`,
    [req.params.id]
  );
  res.json({ ...beat, days: days.map((d) => d.day_of_week), retailers });
});

// days: ['mon','wed',...], retailer_ids: [1,2,3] in the intended visiting order
router.post('/', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, territory_id, employee_id, days, retailer_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!Array.isArray(days) || !days.length) return res.status(400).json({ error: 'At least one day of week is required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO beats (name, territory_id, employee_id) VALUES (?, ?, ?)',
      [name, territory_id || null, employee_id || null]
    );
    const beatId = result.insertId;
    for (const d of days) {
      await conn.query('INSERT INTO beat_days (beat_id, day_of_week) VALUES (?, ?)', [beatId, d]);
    }
    if (Array.isArray(retailer_ids)) {
      for (const [i, retailerId] of retailer_ids.entries()) {
        await conn.query('INSERT INTO beat_retailers (beat_id, retailer_id, visit_order) VALUES (?, ?, ?)', [beatId, retailerId, i]);
      }
    }
    await conn.commit();
    res.status(201).json({ id: beatId });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// Full replace of basics + days + retailer list (simplest consistent update model)
router.patch('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  const { name, territory_id, employee_id, status, days, retailer_ids } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const fields = { name, territory_id, employee_id, status };
    const updates = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) { updates.push(`${k} = ?`); values.push(v === '' ? null : v); }
    }
    if (updates.length) {
      values.push(req.params.id);
      await conn.query(`UPDATE beats SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    if (Array.isArray(days)) {
      await conn.query('DELETE FROM beat_days WHERE beat_id = ?', [req.params.id]);
      for (const d of days) await conn.query('INSERT INTO beat_days (beat_id, day_of_week) VALUES (?, ?)', [req.params.id, d]);
    }
    if (Array.isArray(retailer_ids)) {
      await conn.query('DELETE FROM beat_retailers WHERE beat_id = ?', [req.params.id]);
      for (const [i, retailerId] of retailer_ids.entries()) {
        await conn.query('INSERT INTO beat_retailers (beat_id, retailer_id, visit_order) VALUES (?, ?, ?)', [req.params.id, retailerId, i]);
      }
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.delete('/:id', allowRoles('super_admin', 'management'), async (req, res) => {
  await pool.query('DELETE FROM beats WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// A field employee's route for today: their beat(s) scheduled for today's day of week,
// each with its retailers in visiting order and whether they've already been checked into
// today (via the visits table) — a simple, immediate way to see progress through the route.
router.get('/mine/today', async (req, res) => {
  const employeeId = req.user.employee_id;
  if (!employeeId) return res.status(400).json({ error: 'Logged-in user has no linked employee record' });
  const dow = todayDow();

  const [beats] = await pool.query(
    `SELECT DISTINCT b.* FROM beats b
     JOIN beat_days bd ON bd.beat_id = b.id
     WHERE b.employee_id = ? AND bd.day_of_week = ? AND b.status = 'active'
     ORDER BY b.name`,
    [employeeId, dow]
  );

  const result = [];
  for (const beat of beats) {
    const [retailers] = await pool.query(
      `SELECT r.id, r.name, r.code, r.address,
              EXISTS(SELECT 1 FROM visits v WHERE v.employee_id = ? AND v.retailer_id = r.id AND DATE(v.checkin_time) = CURDATE()) AS visited_today
       FROM beat_retailers br JOIN retailers r ON r.id = br.retailer_id
       WHERE br.beat_id = ? ORDER BY br.visit_order, r.name`,
      [employeeId, beat.id]
    );
    result.push({ ...beat, retailers: retailers.map((r) => ({ ...r, visited_today: !!r.visited_today })) });
  }
  res.json({ day: dow, beats: result });
});

module.exports = router;
