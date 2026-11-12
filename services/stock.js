// Finished-goods stock in packs, per DMS product (SKU).
//
//   produced    = MMS production batches linked to the SKU (see mms_products)
//   dispatched  = distributor-order lines whose order is dispatched or delivered
//   reserved    = distributor-order lines approved / on a dispatch plan, not yet dispatched
//   adjusted    = manual adjustments (opening stock, damage, samples ...)
//   in stock    = produced − dispatched + adjusted
//   free        = in stock − reserved   (what can still be promised to new orders)
const pool = require('../db');

// Packs in one batch: a manual "packs per unit" on the link wins, then the MMS pack size,
// otherwise the batch quantity is already in packs.
const PACKS_SQL = `CASE WHEN mp.packs_per_unit IS NOT NULL THEN pb.actual_qty * mp.packs_per_unit
                        WHEN pb.packs_reported IS NOT NULL THEN pb.packs_reported
                        ELSE pb.actual_qty END`;

async function stockByProduct(conn = pool) {
  const [rows] = await conn.query(
    `SELECT p.id, p.sku_code, p.name, p.pack_size, p.units_per_carton, p.status,
            COALESCE(pr.packs, 0) AS produced, COALESCE(pr.cost, 0) AS produced_cost,
            COALESCE(dq.packs, 0) AS dispatched, COALESCE(rq.packs, 0) AS reserved, COALESCE(aq.packs, 0) AS adjusted,
            (pr.product_id IS NOT NULL OR lk.product_id IS NOT NULL) AS linked
     FROM products p
     LEFT JOIN (SELECT mp.product_id, SUM(${PACKS_SQL}) AS packs, SUM(pb.total_cost) AS cost
                FROM production_batches pb JOIN mms_products mp ON mp.mms_product_id = pb.mms_product_id
                WHERE mp.product_id IS NOT NULL GROUP BY mp.product_id) pr ON pr.product_id = p.id
     LEFT JOIN (SELECT DISTINCT product_id FROM mms_products WHERE product_id IS NOT NULL) lk ON lk.product_id = p.id
     LEFT JOIN (SELECT l.product_id, SUM(l.qty) AS packs FROM distributor_order_lines l
                JOIN distributor_orders o ON o.id = l.order_id
                WHERE o.status IN ('dispatched','delivered') GROUP BY l.product_id) dq ON dq.product_id = p.id
     LEFT JOIN (SELECT l.product_id, SUM(l.qty) AS packs FROM distributor_order_lines l
                JOIN distributor_orders o ON o.id = l.order_id
                WHERE o.status IN ('approved','dispatch_planned') GROUP BY l.product_id) rq ON rq.product_id = p.id
     LEFT JOIN (SELECT product_id, SUM(packs) AS packs FROM stock_adjustments GROUP BY product_id) aq ON aq.product_id = p.id
     ORDER BY p.name`
  );
  return rows.map((r) => {
    const produced = Number(r.produced), dispatched = Number(r.dispatched), reserved = Number(r.reserved), adjusted = Number(r.adjusted);
    const inStock = produced - dispatched + adjusted;
    return {
      ...r,
      linked: !!Number(r.linked),
      produced, dispatched, reserved, adjusted,
      in_stock: inStock,
      free: inStock - reserved,
      avg_cost_per_pack: produced > 0 ? Number(r.produced_cost) / produced : null,
    };
  });
}

module.exports = { stockByProduct, PACKS_SQL };
