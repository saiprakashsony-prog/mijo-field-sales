// Pulls products and production batches from the MMS (production costing app) into the DMS.
//
// Configure on the DMS:  MMS_URL=https://mms.mijofoods.co.in   INTEGRATION_KEY=<same value as on the MMS>
// Sync runs: when the MMS pings /api/integration/mms/ping after a batch change, every 15 minutes,
// and on demand ("Sync now"). Each run is a full, idempotent refresh — batches deleted in the MMS
// are removed here too — so a missed ping only delays an update.
const pool = require('../db');

const MMS_URL = (process.env.MMS_URL || '').replace(/\/+$/, '');
const KEY = process.env.INTEGRATION_KEY || '';
const configured = () => !!(MMS_URL && KEY.length >= 24);

let running = null;

async function setState(k, v) {
  await pool.query('INSERT INTO integration_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, JSON.stringify(v)]);
}
async function getState(k) {
  const [[row]] = await pool.query('SELECT v, updated_at FROM integration_state WHERE k = ?', [k]);
  return row ? { ...JSON.parse(row.v), at: row.updated_at } : null;
}

async function doSync() {
  if (!configured()) throw new Error('MMS link is not configured (set MMS_URL and INTEGRATION_KEY on the DMS)');
  const res = await fetch(`${MMS_URL}/api/integration/production`, {
    headers: { 'x-integration-key': KEY },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`MMS answered ${res.status}${res.status === 401 ? ' — the INTEGRATION_KEY values on the two apps do not match' : ''}`);
  const data = await res.json();
  if (!Array.isArray(data.products) || !Array.isArray(data.batches)) throw new Error('Unexpected response from MMS');

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const productIds = [];
    for (const p of data.products) {
      if (!p.id) continue;
      productIds.push(String(p.id));
      // keep the DMS-side link (product_id / packs_per_unit) untouched
      await conn.query(
        `INSERT INTO mms_products (mms_product_id, name, output_unit, pack_size, active, synced_at)
         VALUES (?, ?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE name = VALUES(name), output_unit = VALUES(output_unit), pack_size = VALUES(pack_size), active = 1, synced_at = NOW()`,
        [String(p.id), String(p.name || 'Unnamed').slice(0, 150), String(p.outputUnit || '').slice(0, 50), p.packSize ? num(p.packSize) : null]
      );
    }
    if (productIds.length) await conn.query('UPDATE mms_products SET active = 0 WHERE mms_product_id NOT IN (?)', [productIds]);
    else await conn.query('UPDATE mms_products SET active = 0');

    const batchIds = [];
    for (const b of data.batches) {
      if (!b.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) || !(num(b.actualQty) > 0)) continue;
      batchIds.push(String(b.id));
      await conn.query(
        `INSERT INTO production_batches (mms_batch_id, mms_product_id, batch_date, actual_qty, unit, packs_reported, rm_cost, extra_cost, total_cost, mms_updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE mms_product_id = VALUES(mms_product_id), batch_date = VALUES(batch_date), actual_qty = VALUES(actual_qty),
           unit = VALUES(unit), packs_reported = VALUES(packs_reported), rm_cost = VALUES(rm_cost), extra_cost = VALUES(extra_cost),
           total_cost = VALUES(total_cost), mms_updated_at = VALUES(mms_updated_at), synced_at = NOW()`,
        [String(b.id), String(b.productId || ''), b.date, num(b.actualQty), String(b.unit || '').slice(0, 50),
          b.packs == null ? null : num(b.packs), num(b.rmCostTotal), num(b.extraCostTotal), num(b.totalCost), b.updatedAt ? String(b.updatedAt).slice(0, 40) : null]
      );
    }
    if (batchIds.length) await conn.query('DELETE FROM production_batches WHERE mms_batch_id NOT IN (?)', [batchIds]);
    else await conn.query('DELETE FROM production_batches');
    await conn.commit();
    return { products: productIds.length, batches: batchIds.length };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// One sync at a time; concurrent callers share the running one.
async function syncNow(trigger = 'manual') {
  if (running) return running;
  running = (async () => {
    try {
      const r = await doSync();
      await setState('mms_sync', { ok: true, trigger, ...r });
      return { ok: true, ...r };
    } catch (e) {
      await setState('mms_sync', { ok: false, trigger, error: e.message }).catch(() => {});
      return { ok: false, error: e.message };
    } finally {
      running = null;
    }
  })();
  return running;
}

function startTimer() {
  if (!configured()) {
    console.log('[mms-sync] MMS_URL / INTEGRATION_KEY not set — production sync disabled.');
    return;
  }
  setTimeout(() => syncNow('startup'), 15000);
  setInterval(() => syncNow('timer'), 15 * 60 * 1000);
}

module.exports = { syncNow, startTimer, configured, getState, KEY };
