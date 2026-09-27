// Run once after provisioning the database: `npm run initdb`
// - Executes schema.sql against the configured database
// - Creates a first Super Administrator login so you can sign in and
//   start adding real employees, distributors, retailers and products.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config();

const ADMIN_MOBILE = '9999999999';
const ADMIN_PASSWORD = 'admin123'; // change this immediately after first login

// Idempotent migrations for databases created before a schema change — each checks
// information_schema first and only acts if not already applied, so it's safe to run
// on every startup alongside schema.sql's CREATE TABLE IF NOT EXISTS statements.
async function migrate(conn) {
  const [[{ db }]] = await conn.query('SELECT DATABASE() AS db');
  async function columnExists(table, column) {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [db, table, column]
    );
    return rows[0].cnt > 0;
  }
  async function addColumnIfMissing(table, column, ddl) {
    if (!(await columnExists(table, column))) {
      console.log(`Migrating ${table}: adding ${column}...`);
      await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }
  async function dropColumnIfPresent(table, column) {
    if (await columnExists(table, column)) {
      console.log(`Migrating ${table}: dropping old ${column} column...`);
      await conn.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }

  // Margin-based, GST-inclusive pricing (replaces the old flat distributor_rate/retailer_rate)
  await addColumnIfMissing('products', 'retailer_margin_pct', 'retailer_margin_pct DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER mrp');
  await addColumnIfMissing('products', 'distributor_margin_pct', 'distributor_margin_pct DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER retailer_margin_pct');
  await dropColumnIfPresent('products', 'distributor_rate');
  await dropColumnIfPresent('products', 'retailer_rate');

  // Carton packing: order by carton + loose packs
  await addColumnIfMissing('products', 'units_per_carton', 'units_per_carton INT NOT NULL DEFAULT 1 AFTER gst_pct');
  await addColumnIfMissing('order_lines', 'carton_qty', 'carton_qty INT NOT NULL DEFAULT 0 AFTER qty');
  await addColumnIfMissing('order_lines', 'pack_qty', 'pack_qty INT NOT NULL DEFAULT 0 AFTER carton_qty');

  // Scheme engine: track which scheme (if any) produced a line's discount
  await addColumnIfMissing('order_lines', 'scheme_id', 'scheme_id INT NULL AFTER discount_amt');

  // Credit limits & overdue controls
  await addColumnIfMissing('retailers', 'credit_limit', 'credit_limit DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER status');
  await addColumnIfMissing('retailers', 'payment_terms_days', 'payment_terms_days INT NOT NULL DEFAULT 0 AFTER credit_limit');

  // Delivery executive role — safe to re-run every time (just resets the same ENUM definition)
  await conn.query(
    `ALTER TABLE users MODIFY COLUMN role ENUM('super_admin','management','sales_manager','field_employee','distributor','delivery_executive') NOT NULL`
  );
}

async function run() {
  // schema.sql contains many statements in one file, so multipleStatements must be enabled
  // on the connection either way. When connecting via a URI, mysql2 needs that passed as
  // { uri, multipleStatements } rather than the bare string, or the flag is silently ignored.
  const conn = process.env.DATABASE_URL
    ? await mysql.createConnection({ uri: process.env.DATABASE_URL, multipleStatements: true })
    : await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        multipleStatements: true,
      });

  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  console.log('Applying schema...');
  await conn.query(schema);

  await migrate(conn);

  const [existing] = await conn.query('SELECT id FROM users WHERE mobile = ?', [ADMIN_MOBILE]);
  if (existing.length === 0) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await conn.query(
      'INSERT INTO users (name, mobile, password_hash, role, status) VALUES (?, ?, ?, ?, ?)',
      ['Super Admin', ADMIN_MOBILE, hash, 'super_admin', 'active']
    );
    console.log(`Seeded super admin login -> mobile: ${ADMIN_MOBILE}  password: ${ADMIN_PASSWORD}`);
    console.log('Please log in and change this password / create your real admin user.');
  } else {
    console.log('Super admin already exists, skipping seed.');
  }

  await conn.end();
  console.log('Done.');
}

run().catch((err) => {
  console.error('DB init failed:', err);
  process.exit(1);
});
