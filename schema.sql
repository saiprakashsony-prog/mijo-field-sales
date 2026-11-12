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
  state         VARCHAR(100),   -- legacy single state/district, kept for old rows; a territory's
  district      VARCHAR(100),   -- real district list now lives in territory_districts below
  status        ENUM('active','inactive') DEFAULT 'active',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- A territory can span multiple districts (within one state, in the current UI).
CREATE TABLE IF NOT EXISTS territory_districts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  territory_id  INT NOT NULL,
  state         VARCHAR(100) NOT NULL,
  district      VARCHAR(100) NOT NULL,
  FOREIGN KEY (territory_id) REFERENCES territories(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_territory_district (territory_id, state, district)
);

-- Mandals (sub-district administrative units) aren't a fixed nationwide list like
-- states/districts, so this is a master you populate yourself per district as needed —
-- same pattern as Categories.
CREATE TABLE IF NOT EXISTS mandals (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  state         VARCHAR(100) NOT NULL,
  district      VARCHAR(100) NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_mandal (name, state, district)
);

CREATE TABLE IF NOT EXISTS distributors (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  code              VARCHAR(30) UNIQUE NOT NULL,
  name              VARCHAR(150) NOT NULL,
  mobile            VARCHAR(20) NOT NULL,
  email             VARCHAR(150),
  address           TEXT,
  territory_id      INT,
  gps_lat           DECIMAL(10,7) NULL,   -- warehouse/godown location, used for dispatch route planning
  gps_lng           DECIMAL(10,7) NULL,
  location_label    VARCHAR(150) NULL,
  status            ENUM('active','inactive') DEFAULT 'active',
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (territory_id) REFERENCES territories(id)
);

-- A distributor's serviceable mandals (chosen from the mandals under their territory's districts).
CREATE TABLE IF NOT EXISTS distributor_mandals (
  distributor_id  INT NOT NULL,
  mandal_id       INT NOT NULL,
  PRIMARY KEY (distributor_id, mandal_id),
  FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE CASCADE,
  FOREIGN KEY (mandal_id) REFERENCES mandals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employees (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  code                  VARCHAR(30) UNIQUE NOT NULL,
  name                  VARCHAR(150) NOT NULL,
  mobile                VARCHAR(20) NOT NULL,
  email                 VARCHAR(150),
  date_of_joining       DATE,
  designation           VARCHAR(100),
  level                 ENUM('RM','ASM','SO','SR') NULL,  -- RM: whole state(s) · ASM: territories · SO/SR: distributors
  reporting_manager_id  INT NULL,
  territory_id          INT,
  status                ENUM('active','inactive') DEFAULT 'active',
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporting_manager_id) REFERENCES employees(id),
  FOREIGN KEY (territory_id) REFERENCES territories(id)
);

-- Beats (routes): a named, repeating set of retailers a sales rep visits on specific
-- days of the week — BRD's "beat planning". A beat's retailer list order (visit_order)
-- is the intended visiting sequence for that route.
CREATE TABLE IF NOT EXISTS beats (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(150) NOT NULL,
  territory_id  INT NULL,
  employee_id   INT NULL,      -- the rep who walks this beat
  status        ENUM('active','inactive') DEFAULT 'active',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (territory_id) REFERENCES territories(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS beat_days (
  beat_id       INT NOT NULL,
  day_of_week   ENUM('mon','tue','wed','thu','fri','sat','sun') NOT NULL,
  PRIMARY KEY (beat_id, day_of_week),
  FOREIGN KEY (beat_id) REFERENCES beats(id) ON DELETE CASCADE
);

-- One employee can be mapped to multiple distributors (BRD 5)
-- Sales hierarchy areas. A Regional Manager covers whole states; an Area Sales Manager covers
-- territories; a Sales Officer / Sales Representative covers distributors (employee_distributors).
CREATE TABLE IF NOT EXISTS employee_states (
  employee_id  INT NOT NULL,
  state        VARCHAR(100) NOT NULL,
  PRIMARY KEY (employee_id, state),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employee_territories (
  employee_id   INT NOT NULL,
  territory_id  INT NOT NULL,
  PRIMARY KEY (employee_id, territory_id),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (territory_id) REFERENCES territories(id) ON DELETE CASCADE
);

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
  role           ENUM('super_admin','management','sales_manager','field_employee','distributor','delivery_executive') NOT NULL,
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
  credit_limit      DECIMAL(12,2) NOT NULL DEFAULT 0,  -- 0 = no credit control for this retailer
  payment_terms_days INT NOT NULL DEFAULT 0,           -- days after order_date an invoice is due (0 = due same day)
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (territory_id) REFERENCES territories(id),
  FOREIGN KEY (distributor_id) REFERENCES distributors(id),
  FOREIGN KEY (created_by) REFERENCES employees(id),
  INDEX idx_mobile (mobile),
  INDEX idx_gstin (gstin),
  INDEX idx_gps (gps_lat, gps_lng)
);

CREATE TABLE IF NOT EXISTS beat_retailers (
  beat_id       INT NOT NULL,
  retailer_id   INT NOT NULL,
  visit_order   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (beat_id, retailer_id),
  FOREIGN KEY (beat_id) REFERENCES beats(id) ON DELETE CASCADE,
  FOREIGN KEY (retailer_id) REFERENCES retailers(id) ON DELETE CASCADE
);

-- Payments/collections recorded against a retailer's outstanding balance. Kept simple
-- (retailer-level running balance) rather than allocating a payment to specific orders —
-- outstanding = SUM(billed order totals) - SUM(payments); overdue is a heuristic (see
-- computeCreditStatus in routes/retailers.js), not per-invoice ageing.
CREATE TABLE IF NOT EXISTS payments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  retailer_id   INT NOT NULL,
  amount        DECIMAL(12,2) NOT NULL,
  payment_date  DATE NOT NULL,
  method        VARCHAR(30),   -- cash / upi / cheque / bank_transfer / other
  reference     VARCHAR(100),
  notes         VARCHAR(255),
  recorded_by   INT,           -- users.id
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (retailer_id) REFERENCES retailers(id)
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

-- Schemes: admin-defined discounts, auto-applied at order booking time (never entered
-- manually by a field employee) and always recomputed server-side on order creation so a
-- tampered client request can't apply a discount that wasn't actually authorized.
-- NULL on product_id/territory_id/distributor_id means "applies to all" for that dimension.
-- NULL on valid_from/valid_to means "no start/end limit" on that side.
CREATE TABLE IF NOT EXISTS schemes (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(150) NOT NULL,
  discount_type   ENUM('percent','flat') NOT NULL,
  discount_value  DECIMAL(10,2) NOT NULL,   -- percent (0-100) or a flat ₹ amount per pack
  min_qty         INT NOT NULL DEFAULT 1,   -- minimum total pack qty on the line to qualify
  product_id      INT NULL,
  territory_id    INT NULL,
  distributor_id  INT NULL,
  valid_from      DATE NULL,
  valid_to        DATE NULL,
  status          ENUM('active','inactive') DEFAULT 'active',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (territory_id) REFERENCES territories(id),
  FOREIGN KEY (distributor_id) REFERENCES distributors(id)
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

-- Sales returns: damaged, expired, unsold, or wrong-item stock a retailer sends back.
-- A field employee reports one (status 'requested'); the distributor (or admin/management)
-- approves or rejects it. Only an APPROVED return counts as a credit against the retailer's
-- outstanding balance — see computeCreditStatus in routes/retailers.js, which now also
-- subtracts SUM(amount) of approved returns, exactly like it already does for payments.
CREATE TABLE IF NOT EXISTS sales_returns (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  return_no       VARCHAR(40) UNIQUE NOT NULL,
  order_id        INT NULL,      -- optional link to the original order, for traceability
  retailer_id     INT NOT NULL,
  distributor_id  INT NOT NULL,
  product_id      INT NOT NULL,
  qty             INT NOT NULL,           -- packs being returned
  rate            DECIMAL(10,2) NOT NULL, -- credit rate per pack (from the order if linked, else current retailer price)
  amount          DECIMAL(12,2) NOT NULL, -- qty * rate — the credit note value once approved
  return_type     ENUM('damage','expiry','unsold','wrong_item','other') NOT NULL,
  reason          VARCHAR(255),
  status          ENUM('requested','approved','rejected') DEFAULT 'requested',
  requested_by    INT,           -- employees.id
  reviewed_by     INT,           -- users.id (whoever approved/rejected)
  reviewed_at     DATETIME,
  review_note     VARCHAR(255),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (retailer_id) REFERENCES retailers(id),
  FOREIGN KEY (distributor_id) REFERENCES distributors(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
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
  scheme_id     INT NULL,                -- which scheme (if any) produced discount_amt, for audit
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

-- Distributor (primary) orders: stock a distributor buys from MIJO, booked by an ASM / SO
-- (or an admin) on the distributor's behalf. Approved orders feed the Dispatch Planner.
CREATE TABLE IF NOT EXISTS distributor_orders (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  order_no           VARCHAR(40) UNIQUE NOT NULL,
  order_date         DATE NOT NULL,
  distributor_id     INT NOT NULL,
  booked_by_employee INT NULL,        -- employees.id when an ASM / SO booked it
  booked_by_user     INT NOT NULL,    -- users.id
  status             ENUM('submitted','approved','rejected','dispatch_planned','dispatched','delivered','cancelled') NOT NULL DEFAULT 'submitted',
  total_cartons      DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes              VARCHAR(255),
  reviewed_by        INT NULL,        -- users.id who approved / rejected
  reviewed_at        DATETIME NULL,
  review_note        VARCHAR(255),
  dispatch_plan_id   INT NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (distributor_id) REFERENCES distributors(id),
  INDEX idx_do_status (status),
  INDEX idx_do_distributor (distributor_id)
);

CREATE TABLE IF NOT EXISTS distributor_order_lines (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_id    INT NOT NULL,
  product_id  INT NOT NULL,
  carton_qty  INT NOT NULL DEFAULT 0,
  pack_qty    INT NOT NULL DEFAULT 0,
  qty         INT NOT NULL,              -- total packs = carton_qty * units_per_carton + pack_qty
  rate        DECIMAL(10,2) NOT NULL,    -- Distributor Price per pack (GST-inclusive)
  gst_amt     DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_amount  DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES distributor_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ---------------------------------------------------------------------------
-- Production link with the MMS (mms.mijofoods.co.in)
-- Products and batches are pulled from the MMS; each MMS product is linked to a
-- DMS SKU once. Finished-goods stock = produced − dispatched ± adjustments.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mms_products (
  mms_product_id  VARCHAR(64) PRIMARY KEY,
  name            VARCHAR(150) NOT NULL,
  output_unit     VARCHAR(50),
  pack_size       DECIMAL(14,4) NULL,       -- MMS: quantity of output unit per pack (e.g. 0.05 kg)
  product_id      INT NULL,                 -- linked DMS SKU
  packs_per_unit  DECIMAL(14,4) NULL,       -- manual override: packs per 1 MMS output unit
  active          TINYINT(1) NOT NULL DEFAULT 1,
  synced_at       DATETIME NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS production_batches (
  mms_batch_id    VARCHAR(64) PRIMARY KEY,
  mms_product_id  VARCHAR(64) NOT NULL,
  batch_date      DATE NOT NULL,
  actual_qty      DECIMAL(14,3) NOT NULL,
  unit            VARCHAR(50),
  packs_reported  DECIMAL(14,2) NULL,       -- packs as computed by MMS from its pack size
  rm_cost         DECIMAL(14,2) NOT NULL DEFAULT 0,
  extra_cost      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_cost      DECIMAL(14,2) NOT NULL DEFAULT 0,
  mms_updated_at  VARCHAR(40) NULL,
  synced_at       DATETIME NULL,
  INDEX idx_pb_date (batch_date),
  INDEX idx_pb_product (mms_product_id)
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  product_id  INT NOT NULL,
  adj_date    DATE NOT NULL,
  packs       INT NOT NULL,                 -- + adds stock, − removes it
  reason      VARCHAR(40) NOT NULL,         -- opening_stock / damage / samples / correction / other
  notes       VARCHAR(255),
  created_by  INT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS integration_state (
  k           VARCHAR(60) PRIMARY KEY,
  v           TEXT,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Monthly operating expenses for the net P&L (one amount per category per month)
CREATE TABLE IF NOT EXISTS monthly_expenses (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  month       CHAR(7) NOT NULL,             -- YYYY-MM
  category    VARCHAR(60) NOT NULL,
  amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes       VARCHAR(255),
  updated_by  INT,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_month_category (month, category)
);

-- Dispatch planning: a saved plan for shipping stock from the factory (origin) to distributors,
-- split across one or more vehicles. Each vehicle's stops are stored in delivery order; the
-- truck is loaded in the reverse of that order (last drop goes in first).
CREATE TABLE IF NOT EXISTS dispatch_plans (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  plan_no          VARCHAR(40) UNIQUE NOT NULL,
  plan_date        DATE NOT NULL,
  origin_label     VARCHAR(150) NOT NULL,
  origin_lat       DECIMAL(10,7) NOT NULL,
  origin_lng       DECIMAL(10,7) NOT NULL,
  depart_time      TIME NOT NULL,
  return_to_origin TINYINT(1) NOT NULL DEFAULT 1,
  avg_speed_kmph   INT NOT NULL DEFAULT 40,
  unload_minutes   INT NOT NULL DEFAULT 30,
  capacity_cases   DECIMAL(10,2) NULL,     -- max cases per vehicle; every vehicle in the plan must fit
  total_km         DECIMAL(10,1) NOT NULL DEFAULT 0,
  status           ENUM('planned','dispatched','completed','cancelled') DEFAULT 'planned',
  notes            VARCHAR(255),
  created_by       INT,          -- users.id
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_plan_date (plan_date)
);

CREATE TABLE IF NOT EXISTS dispatch_plan_vehicles (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  plan_id        INT NOT NULL,
  vehicle_no     INT NOT NULL,            -- 1, 2, 3 ... within the plan
  vehicle_reg    VARCHAR(30),
  driver_name    VARCHAR(100),
  driver_mobile  VARCHAR(20),
  total_km       DECIMAL(10,1) NOT NULL DEFAULT 0,
  FOREIGN KEY (plan_id) REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_plan_vehicle (plan_id, vehicle_no)
);

CREATE TABLE IF NOT EXISTS dispatch_plan_stops (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  plan_id         INT NOT NULL,
  vehicle_no      INT NOT NULL,
  stop_seq        INT NOT NULL,            -- delivery order within the vehicle (1 = first drop)
  distributor_id  INT NOT NULL,
  cases           DECIMAL(10,2) NOT NULL DEFAULT 0,
  leg_km          DECIMAL(10,1) NOT NULL DEFAULT 0,
  eta_minutes     INT NOT NULL DEFAULT 0,  -- minutes after midnight of plan_date (may exceed 1440 for next-day arrivals)
  FOREIGN KEY (plan_id) REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (distributor_id) REFERENCES distributors(id)
);

-- Seed a super admin login: mobile 9999999999 / password "admin123" (bcrypt hash below)
-- Generated separately in scripts/init-db.js so the hash always matches bcryptjs's own output.
