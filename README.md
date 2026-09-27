# MIJO Foods — Field Sales & Distributor Order Management

A working v1 implementation of the BRD: employee/distributor/retailer/product masters,
GPS-verified retailer onboarding, order booking that auto-routes to the retailer's
mapped distributor, a distributor order book with a consolidated SKU picking list,
the dispatch status flow, and a management dashboard.

Stack: Node.js + Express API, MySQL, vanilla JS single-page frontend (same pattern as
your other in-house tools — VendorPay and the production costing app).

## What's implemented (BRD sections)
- 5. Employee master + employee→distributor mapping (many-to-many)
- 6. Retailer master, GPS-mandatory creation, duplicate check (mobile/GSTIN/name/GPS proximity)
- 7. Field visit check-in (`/api/visits/checkin`)
- 8. Order booking with auto rate/GST/net calculation from the product master
- 9. Distributor order book + consolidated SKU picking list (by day)
- 10. Dispatch status flow: submitted → accepted → picking → packing → ready_for_dispatch → dispatched → delivered, plus cancellation with a required reason
- 11. Management dashboard: today's orders/value, new retailers, visits, by-distributor, by-employee, top SKUs, by-status
- 12. Product/SKU master
- 18/19. Status history audit trail per order, role-based access, lock-after-accept business rule, mandatory GPS/distributor-mapping validations

## What's intentionally out of v1 (see "Future Modules" in the BRD)
Targets/schemes engine (13), geofencing enforcement (14 beyond capture), true offline
sync (15 — the browser app needs connectivity today), push/SMS/WhatsApp notifications (16),
stock/collections/incentives and ERP integration (21). The schema and API are structured
so these can be layered on without a rework — happy to build any of these out next.

## 1. Local setup
```bash
npm install
cp .env.example .env   # fill in DB credentials and a real JWT_SECRET
npm run initdb          # creates tables and seeds a Super Admin login
npm start                # http://localhost:4000
```
The seeded login is mobile `9999999999` / password `admin123` — log in, then use
**Masters → Create Login** to add your real admin, sales managers, field employees
and distributor logins, and retire the seeded one.

## 2. Deploy on Railway (same as VendorPay / production costing)
1. Push this folder to a new GitHub repo, e.g. `saiprakashsony-prog/mijo-field-sales`.
2. In Railway: New Project → Deploy from GitHub repo → select it.
3. Add a MySQL plugin to the project. Railway injects `DATABASE_URL` automatically —
   `db.js` already prefers that over the individual `DB_*` vars, so no extra config needed there.
4. Add environment variables on the service: `JWT_SECRET` (long random string) and
   optionally `PORT` (Railway sets this itself).
5. Open a one-off shell (Railway → your service → the "..." menu → Run a command, or
   `railway run npm run initdb` via the Railway CLI) and run `npm run initdb` once against
   the production database to create tables and the seed admin.
6. Attach your domain (e.g. `sales.dakshinampm.co.in` or similar) under Settings → Domains.

## 3. How the roles work
- **Super Admin / Management / Sales Manager** — sign in, see the Dashboard, All Orders,
  and Masters (territories, distributors, employees, products, and creating logins for others).
- **Field Employee** — needs a login created under Masters → Create Login → "Field Employee",
  linked to their Employee record. They get New Retailer, Book Order, and My Orders.
- **Distributor** — needs a login linked to their Distributor record. They get the
  Order Book (with one-tap status advance) and the Consolidated Picking List.

## 4. Project layout
```
server.js            Express app entry point
db.js                 MySQL connection pool (DATABASE_URL or DB_* env vars)
schema.sql            Full table definitions
scripts/init-db.js    Applies schema.sql + seeds the first Super Admin login
routes/                One file per resource (auth, employees, distributors,
                        territories, products, retailers, visits, orders, dashboard, users)
middleware/auth.js    JWT verification + role gating
public/                Vanilla JS frontend (index.html, css/style.css, js/app.js)
```

## 5. Notable business rules enforced in code
- A retailer cannot be created without GPS lat/lng (`routes/retailers.js`).
- An order is always routed to the *retailer's* mapped distributor — the field employee
  never chooses the distributor manually (`routes/orders.js`).
- Cancelling an order requires a reason, and dispatched/delivered orders can't be cancelled.
- Every status change is written to `order_status_history` for the audit trail.
- A distributor login can only see and act on its own orders; a field employee login only
  sees its own.

## 6. Suggested next increments
1. Targets & achievement tracking (BRD 13) — table + dashboard cards already have a natural home.
2. Scheme/discount engine on top of the existing `discount_amt` field.
3. Convert the frontend into an installable PWA with an offline queue for visits/orders (BRD 15), matching the VendorPay pattern.
4. Notifications (BRD 16) — start with the WhatsApp Business template integration you already use on VendorPay.
5. GPS geofencing enforcement (warn/block outside a configurable radius at check-in), building on the duplicate-check haversine helper already in `routes/retailers.js`.
