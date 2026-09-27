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
