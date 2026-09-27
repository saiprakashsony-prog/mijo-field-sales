-- MIJO Foods :: Field Sales & Distributor Order Management
-- Schema v1 (covers BRD sections 5-12, 18-19)

CREATE TABLE IF NOT EXISTS categories (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) UNIQUE NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS territories (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  state         VARCHAR(100),
  district      VARCHAR(100),
  status        ENUM('active','inactive') DEFAULT 'active',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS distributors (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  code              VARCHAR(30) UNIQUE NOT NULL,
  name              VARCHAR(150) NOT NULL,
  mobile            VARCHAR(20) NOT NULL,
  email             VARCHAR(150),
  address           TEXT,
  territory_id      INT,
  status            ENUM('active','inactive') DEFAULT 'active',
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (territory_id) REFERENCES territories(id)
);

CREATE TABLE IF NOT EXISTS employees (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  code                  VARCHAR(30) UNIQUE NOT NULL,
  name                  VARCHAR(150) NOT NULL,
  mobile                VARCHAR(20) NOT NULL,
  email                 VARCHAR(150),
  date_of_joining       DATE,
  designation           VARCHAR(100),
  reporting_manager_id  INT NULL,
  territory_id          INT,
  status                ENUM('active','inactive') DEFAULT 'active',
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporting_manager_id) REFERENCES employees(id),
  FOREIGN KEY (territory_id) REFERENCES territories(id)
);

-- One employee can be mapped to multiple distributors (BRD 5)
CREATE TABLE IF NOT EXISTS employee_distributors (
  employee_id    INT NOT NULL,
  distributor_id INT NOT NULL,
  is_primary     TINYINT(1) DEFAULT 0,
  PRIMARY KEY (employee_id, distributor_id),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(150) NOT NULL,
  mobile         VARCHAR(20) UNIQUE NOT NULL,
  email          VARCHAR(150),
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('super_admin','management','sales_manager','field_employee','distributor') NOT NULL,
  employee_id    INT NULL,
  distributor_id INT NULL,
  status         ENUM('active','inactive') DEFAULT 'active',
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (distributor_id) REFERENCES distributors(id)
);

CREATE TABLE IF NOT EXISTS retailers (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  code              VARCHAR(30) UNIQUE NOT NULL,
  name              VARCHAR(150) NOT NULL,
  owner_name        VARCHAR(150),
  mobile            VARCHAR(20) NOT NULL,
  address           TEXT NOT NULL,
  pincode           VARCHAR(10),
  territory_id      INT,
  gstin             VARCHAR(20),
  pan               VARCHAR(20),
  shop_type         VARCHAR(100) NOT NULL,
  photo_url         VARCHAR(255),
  gps_lat           DECIMAL(10,7) NOT NULL,
  gps_lng           DECIMAL(10,7) NOT NULL,
  distributor_id    INT NOT NULL,
  created_by        INT NOT NULL,        -- employees.id
  status            ENUM('active','inactive') DEFAULT 'active',
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (territory_id) REFERENCES territories(id),
  FOREIGN KEY (distributor_id) REFERENCES distributors(id),
  FOREIGN KEY (created_by) REFERENCES employees(id),
  INDEX idx_mobile (mobile),
  INDEX idx_gstin (gstin),
  INDEX idx_gps (gps_lat, gps_lng)
);

-- Pricing model: MRP is GST-inclusive (all prices in this app are GST-inclusive —
-- gst_pct is stored only for invoice/reporting display, never added on top).
-- Retailer Price = MRP marked down by retailer_margin_pct (what the retailer pays the distributor).
-- Distributor Price = Retailer Price marked down by distributor_margin_pct (what the distributor pays the company).
-- Both are computed at read time from mrp/retailer_margin_pct/distributor_margin_pct — not stored directly.
CREATE TABLE IF NOT EXISTS products (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  sku_code              VARCHAR(30) UNIQUE NOT NULL,
  name                  VARCHAR(150) NOT NULL,
  category              VARCHAR(100),
  brand                 VARCHAR(100),
  pack_size             VARCHAR(50),
  uom                   VARCHAR(20),
  mrp                   DECIMAL(10,2) NOT NULL,
  retailer_margin_pct   DECIMAL(5,2) NOT NULL DEFAULT 0,
  distributor_margin_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_pct               DECIMAL(5,2) NOT NULL DEFAULT 0,
  units_per_carton      INT NOT NULL DEFAULT 1,
  scheme_note           VARCHAR(255),
  moq                   INT DEFAULT 1,
  status                ENUM('active','inactive') DEFAULT 'active',
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS visits (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  employee_id    INT NOT NULL,
  retailer_id    INT NOT NULL,
  checkin_lat    DECIMAL(10,7),
  checkin_lng    DECIMAL(10,7),
  checkin_time   DATETIME DEFAULT CURRENT_TIMESTAMP,
  visit_type     ENUM('productive','non_productive') DEFAULT 'productive',
  np_reason      VARCHAR(255) NULL,
  status         ENUM('open','completed') DEFAULT 'open',
  completed_at   DATETIME NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (retailer_id) REFERENCES retailers(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  order_no       VARCHAR(40) UNIQUE NOT NULL,
  order_date     DATE NOT NULL,
  employee_id    INT NOT NULL,
  distributor_id INT NOT NULL,
  retailer_id    INT NOT NULL,
  visit_id       INT NULL,
  status         ENUM('draft','submitted','accepted','picking','packing','ready_for_dispatch','dispatched','delivered','cancelled') DEFAULT 'submitted',
  total_amount   DECIMAL(12,2) DEFAULT 0,
  invoice_no     VARCHAR(60) NULL,
  invoice_url    VARCHAR(255) NULL,
  cancel_reason  VARCHAR(255) NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (distributor_id) REFERENCES distributors(id),
  FOREIGN KEY (retailer_id) REFERENCES retailers(id),
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  INDEX idx_order_date (order_date),
  INDEX idx_status (status)
);

CREATE TABLE IF NOT EXISTS order_lines (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  order_id      INT NOT NULL,
  product_id    INT NOT NULL,
  qty           INT NOT NULL,        -- total quantity in individual packs (carton_qty * units_per_carton + pack_qty)
  carton_qty    INT NOT NULL DEFAULT 0,  -- number of full cartons ordered
  pack_qty      INT NOT NULL DEFAULT 0,  -- loose individual packs ordered on top of full cartons
  rate          DECIMAL(10,2) NOT NULL,
  discount_amt  DECIMAL(10,2) DEFAULT 0,
  gst_amt       DECIMAL(10,2) DEFAULT 0,
  net_amount    DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Audit trail: status changes and edits (BRD 18)
CREATE TABLE IF NOT EXISTS order_status_history (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  order_id     INT NOT NULL,
  from_status  VARCHAR(30),
  to_status    VARCHAR(30) NOT NULL,
  changed_by   INT NOT NULL,   -- users.id
  remarks      VARCHAR(255),
  changed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  entity_type  VARCHAR(50) NOT NULL,   -- retailer / order / product / employee ...
  entity_id    INT NOT NULL,
  action       VARCHAR(30) NOT NULL,   -- create / update / delete / status_change
  changed_by   INT,                    -- users.id
  before_json  JSON NULL,
  after_json   JSON NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed a super admin login: mobile 9999999999 / password "admin123" (bcrypt hash below)
-- Generated separately in scripts/init-db.js so the hash always matches bcryptjs's own output.
