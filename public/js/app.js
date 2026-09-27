const API = '/api';
let state = {
  token: localStorage.getItem('token') || null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  tab: null,
  cache: {},
};

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function fmtMoney(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function fmtDate(d) { return d ? new Date(d).toLocaleString('en-IN') : ''; }
function todayISO() { return new Date().toISOString().slice(0, 10); }

// ---------- Root render ----------
function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  if (!state.user) {
    app.appendChild(renderLogin());
    return;
  }
  app.appendChild(renderShell());
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  state.token = null;
  state.user = null;
  render();
}

// ---------- Login ----------
function renderLogin() {
  const wrap = el(`
    <div class="login-wrap">
      <div class="card login-box">
        <p class="section-title">MIJO Foods — Field Sales Login</p>
        <div class="field"><label>Mobile Number</label><input id="mobile" placeholder="10-digit mobile" /></div>
        <div class="field"><label>Password</label><input id="password" type="password" /></div>
        <button class="btn" id="loginBtn" style="width:100%">Log in</button>
        <div class="error-msg" id="loginErr"></div>
        <p class="muted" style="margin-top:14px">First time setup? Run <code>npm run initdb</code> on the server, then sign in with the seeded Super Admin login shown in the console.</p>
      </div>
    </div>`);
  wrap.querySelector('#loginBtn').onclick = async () => {
    const mobile = wrap.querySelector('#mobile').value.trim();
    const password = wrap.querySelector('#password').value;
    const errBox = wrap.querySelector('#loginErr');
    errBox.textContent = '';
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ mobile, password }) });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      render();
    } catch (e) {
      errBox.textContent = e.message;
    }
  };
  return wrap;
}

// ---------- Shell / nav ----------
const TABS_BY_ROLE = {
  field_employee: [['newretailer', 'New Retailer'], ['booking', 'Book Order'], ['myorders', 'My Orders']],
  distributor: [['orderbook', 'Order Book'], ['consolidated', 'Consolidated Picking List']],
  sales_manager: [['dashboard', 'Dashboard'], ['orders', 'All Orders'], ['masters', 'Masters']],
  management: [['dashboard', 'Dashboard'], ['orders', 'All Orders'], ['masters', 'Masters']],
  super_admin: [['dashboard', 'Dashboard'], ['orders', 'All Orders'], ['masters', 'Masters']],
};

function renderShell() {
  const tabs = TABS_BY_ROLE[state.user.role] || [];
  if (!state.tab) state.tab = tabs[0][0];
  const shell = el(`
    <div>
      <header class="topbar">
        <h1>MIJO Foods · Field Sales</h1>
        <div class="who">${state.user.name} (${state.user.role.replace('_', ' ')}) &nbsp;
          <button class="btn small secondary" id="logoutBtn">Log out</button>
        </div>
      </header>
      <nav class="tabs">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${id === state.tab ? 'active' : ''}">${label}</button>`).join('')}</nav>
      <main id="main"></main>
    </div>`);
  shell.querySelector('#logoutBtn').onclick = logout;
  shell.querySelectorAll('nav.tabs button').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; render(); };
  });
  const main = shell.querySelector('#main');
  const renderers = {
    newretailer: renderNewRetailer,
    booking: renderBooking,
    myorders: renderMyOrders,
    orderbook: renderOrderBook,
    consolidated: renderConsolidated,
    dashboard: renderDashboard,
    orders: renderAllOrders,
    masters: renderMasters,
  };
  (renderers[state.tab] || (() => el('<div/>')))().then((node) => main.appendChild(node)).catch((e) => {
    main.appendChild(el(`<div class="card error-msg">${e.message}</div>`));
  });
  return shell;
}

function refreshMain() {
  const main = document.getElementById('main');
  if (!main) return render();
  main.innerHTML = '';
  const renderers = {
    newretailer: renderNewRetailer, booking: renderBooking, myorders: renderMyOrders,
    orderbook: renderOrderBook, consolidated: renderConsolidated, dashboard: renderDashboard,
    orders: renderAllOrders, masters: renderMasters,
  };
  renderers[state.tab]().then((node) => main.appendChild(node));
}

// ---------- Field Employee: New Retailer ----------
async function renderNewRetailer() {
  const distributors = await api('/distributors');
  const territories = await api('/territories');
  const wrap = el(`
    <div class="card">
      <p class="section-title">New Retailer (first-visit onboarding)</p>
      <div class="grid cols-2">
        <div class="field"><label>Shop / Retailer Name *</label><input id="rname" /></div>
        <div class="field"><label>Owner Name</label><input id="rowner" /></div>
        <div class="field"><label>Mobile Number *</label><input id="rmobile" /></div>
        <div class="field"><label>Shop Type *</label>
          <select id="rshoptype"><option value="Kirana">Kirana</option><option value="Supermarket">Supermarket</option><option value="General Store">General Store</option><option value="Café/HORECA">Café/HORECA</option><option value="Other">Other</option></select>
        </div>
        <div class="field"><label>GSTIN (optional)</label><input id="rgstin" /></div>
        <div class="field"><label>PIN Code</label><input id="rpincode" /></div>
        <div class="field"><label>Territory</label>
          <select id="rterritory"><option value="">--</option>${territories.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Distributor (order routing) *</label>
          <select id="rdistributor">${distributors.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field"><label>Address *</label><textarea id="raddress" rows="2"></textarea></div>
      <div class="field">
        <label>GPS Location * (captured automatically, required)</label>
        <div id="gpsStatus" class="muted">Not captured yet.</div>
        <button class="btn secondary small" id="captureGps" style="margin-top:6px">Capture GPS Location</button>
      </div>
      <div id="dupWarning"></div>
      <button class="btn" id="saveRetailer" style="margin-top:10px">Save Retailer</button>
      <div class="error-msg" id="rErr"></div>
      <div id="rOk"></div>
    </div>`);

  let gps = null;
  wrap.querySelector('#captureGps').onclick = () => {
    const statusEl = wrap.querySelector('#gpsStatus');
    statusEl.textContent = 'Capturing...';
    if (!navigator.geolocation) { statusEl.textContent = 'Geolocation not supported by this browser.'; return; }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        statusEl.textContent = `Captured: ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)} (±${Math.round(pos.coords.accuracy)}m)`;
        try {
          const dup = await api('/retailers/check-duplicate', {
            method: 'POST',
            body: JSON.stringify({
              mobile: wrap.querySelector('#rmobile').value.trim(),
              gstin: wrap.querySelector('#rgstin').value.trim(),
              name: wrap.querySelector('#rname').value.trim(),
              gps_lat: gps.lat, gps_lng: gps.lng,
            }),
          });
          const box = wrap.querySelector('#dupWarning');
          if (dup.possible_duplicates.length) {
            box.innerHTML = `<div class="card" style="border-color:#f59e0b;background:#fffbeb"><b>Possible duplicate retailer(s) found:</b><ul>${dup.possible_duplicates.map((d) => `<li>${d.name} (${d.code}) — matched on ${d.matched_on}${d.distance_m != null ? `, ${d.distance_m}m away` : ''}</li>`).join('')}</ul></div>`;
          } else { box.innerHTML = ''; }
        } catch {}
      },
      (err) => { statusEl.textContent = 'Could not get location: ' + err.message; },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  wrap.querySelector('#saveRetailer').onclick = async () => {
    const errBox = wrap.querySelector('#rErr');
    const okBox = wrap.querySelector('#rOk');
    errBox.textContent = ''; okBox.textContent = '';
    if (!gps) { errBox.textContent = 'Please capture GPS location before saving.'; return; }
    try {
      const payload = {
        name: wrap.querySelector('#rname').value.trim(),
        owner_name: wrap.querySelector('#rowner').value.trim(),
        mobile: wrap.querySelector('#rmobile').value.trim(),
        address: wrap.querySelector('#raddress').value.trim(),
        pincode: wrap.querySelector('#rpincode').value.trim(),
        territory_id: wrap.querySelector('#rterritory').value || null,
        gstin: wrap.querySelector('#rgstin').value.trim() || null,
        shop_type: wrap.querySelector('#rshoptype').value,
        gps_lat: gps.lat, gps_lng: gps.lng,
        distributor_id: wrap.querySelector('#rdistributor').value,
      };
      const result = await api('/retailers', { method: 'POST', body: JSON.stringify(payload) });
      okBox.innerHTML = `<p style="color:var(--ok)">Retailer saved: ${result.code}. You can now book an order for this retailer from the "Book Order" tab.</p>`;
    } catch (e) { errBox.textContent = e.message; }
  };

  return wrap;
}

// ---------- Field Employee: Book Order ----------
async function renderBooking() {
  const [retailers, products] = await Promise.all([
    api(`/retailers?employee_id=${state.user.employee_id}`),
    api('/products?active=1'),
  ]);
  const wrap = el(`
    <div class="card">
      <p class="section-title">Book Order</p>
      <div class="field"><label>Retailer *</label>
        <select id="bRetailer"><option value="">-- select --</option>${retailers.map((r) => `<option value="${r.id}">${r.name} (${r.code}) — ${r.distributor_name}</option>`).join('')}</select>
      </div>
      <div id="lines"></div>
      <button class="btn secondary small" id="addLine">+ Add Product Line</button>
      <div class="total-row">Total: <span id="totalVal">₹0.00</span></div>
      <button class="btn" id="submitOrder" style="margin-top:10px">Submit Order</button>
      <div class="error-msg" id="bErr"></div>
      <div id="bOk"></div>
    </div>`);

  const linesBox = wrap.querySelector('#lines');
  const productOptions = products.map((p) => `<option value="${p.id}" data-rate="${p.distributor_rate}" data-gst="${p.gst_pct}">${p.name} — ${p.sku_code} (${p.pack_size || ''})</option>`).join('');

  function addLine() {
    const row = el(`
      <div class="line-item">
        <div class="field" style="margin:0"><label>Product</label><select class="lp">${productOptions}</select></div>
        <div class="field" style="margin:0"><label>Qty</label><input class="lq" type="number" min="1" value="1" /></div>
        <div class="field" style="margin:0"><label>Rate</label><input class="lr" disabled /></div>
        <div class="field" style="margin:0"><label>Net</label><input class="ln" disabled /></div>
        <button class="btn small secondary" style="height:36px">✕</button>
      </div>`);
    function recalc() {
      const opt = row.querySelector('.lp').selectedOptions[0];
      const rate = Number(opt.dataset.rate);
      const gst = Number(opt.dataset.gst);
      const qty = Number(row.querySelector('.lq').value || 0);
      const net = qty * rate * (1 + gst / 100);
      row.querySelector('.lr').value = rate.toFixed(2);
      row.querySelector('.ln').value = net.toFixed(2);
      updateTotal();
    }
    row.querySelector('.lp').onchange = recalc;
    row.querySelector('.lq').oninput = recalc;
    row.querySelector('button').onclick = () => { row.remove(); updateTotal(); };
    linesBox.appendChild(row);
    recalc();
  }
  function updateTotal() {
    let total = 0;
    linesBox.querySelectorAll('.line-item').forEach((r) => { total += Number(r.querySelector('.ln').value || 0); });
    wrap.querySelector('#totalVal').textContent = fmtMoney(total);
  }
  wrap.querySelector('#addLine').onclick = addLine;
  addLine();

  wrap.querySelector('#submitOrder').onclick = async () => {
    const errBox = wrap.querySelector('#bErr');
    const okBox = wrap.querySelector('#bOk');
    errBox.textContent = ''; okBox.textContent = '';
    const retailerId = wrap.querySelector('#bRetailer').value;
    if (!retailerId) { errBox.textContent = 'Select a retailer.'; return; }
    const lines = [...linesBox.querySelectorAll('.line-item')].map((r) => ({
      product_id: r.querySelector('.lp').value,
      qty: Number(r.querySelector('.lq').value),
    }));
    try {
      const result = await api('/orders', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, lines }) });
      okBox.innerHTML = `<p style="color:var(--ok)">Order ${result.order_no} submitted for ${fmtMoney(result.total_amount)}. It has been routed to the mapped distributor and is now visible on the management dashboard.</p>`;
    } catch (e) { errBox.textContent = e.message; }
  };

  return wrap;
}

// ---------- Field Employee: My Orders ----------
async function renderMyOrders() {
  const orders = await api('/orders');
  return el(`
    <div class="card">
      <p class="section-title">My Orders</p>
      ${ordersTable(orders)}
    </div>`);
}

function ordersTable(orders, opts = {}) {
  if (!orders.length) return '<p class="muted">No orders yet.</p>';
  return `<table>
    <thead><tr><th>Order No</th><th>Date</th><th>Retailer</th>${opts.showEmployee ? '<th>Employee</th>' : ''}${opts.showDistributor ? '<th>Distributor</th>' : ''}<th>Value</th><th>Status</th></tr></thead>
    <tbody>${orders.map((o) => `<tr>
      <td>${o.order_no}</td><td>${o.order_date}</td><td>${o.retailer_name} (${o.retailer_code})</td>
      ${opts.showEmployee ? `<td>${o.employee_name}</td>` : ''}
      ${opts.showDistributor ? `<td>${o.distributor_name}</td>` : ''}
      <td>${fmtMoney(o.total_amount)}</td><td><span class="badge ${o.status}">${o.status.replace(/_/g, ' ')}</span></td>
    </tr>`).join('')}</tbody></table>`;
}

// ---------- Distributor: Order Book ----------
async function renderOrderBook() {
  const date = todayISO();
  const orders = await api(`/orders?date=${date}`);
  const STATUS_NEXT = { submitted: 'accepted', accepted: 'picking', picking: 'packing', packing: 'ready_for_dispatch', ready_for_dispatch: 'dispatched', dispatched: 'delivered' };
  const wrap = el(`
    <div class="card">
      <p class="section-title">Today's Order Book — ${date}</p>
      <table>
        <thead><tr><th>Order No</th><th>Retailer</th><th>Sales Employee</th><th>Value</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${orders.map((o) => `<tr data-id="${o.id}" data-status="${o.status}">
          <td>${o.order_no}</td><td>${o.retailer_name}</td><td>${o.employee_name}</td>
          <td>${fmtMoney(o.total_amount)}</td>
          <td><span class="badge ${o.status}">${o.status.replace(/_/g, ' ')}</span></td>
          <td>${STATUS_NEXT[o.status] ? `<button class="btn small advanceBtn">Mark ${STATUS_NEXT[o.status].replace(/_/g, ' ')}</button>` : ''}
              ${o.status === 'submitted' ? `<button class="btn small secondary cancelBtn">Cancel</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table>
      ${!orders.length ? '<p class="muted">No orders received today.</p>' : ''}
    </div>`);

  wrap.querySelectorAll('.advanceBtn').forEach((btn) => {
    btn.onclick = async () => {
      const tr = btn.closest('tr');
      const next = STATUS_NEXT[tr.dataset.status];
      await api(`/orders/${tr.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      refreshMain();
    };
  });
  wrap.querySelectorAll('.cancelBtn').forEach((btn) => {
    btn.onclick = async () => {
      const reason = prompt('Reason for cancellation?');
      if (!reason) return;
      const tr = btn.closest('tr');
      await api(`/orders/${tr.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', cancel_reason: reason }) });
      refreshMain();
    };
  });
  return wrap;
}

// ---------- Distributor: Consolidated Picking List ----------
async function renderConsolidated() {
  const date = todayISO();
  const data = await api(`/orders/consolidated/${state.user.distributor_id}?date=${date}`);
  return el(`
    <div class="card">
      <p class="section-title">Consolidated Picking List — ${date}</p>
      <table>
        <thead><tr><th>SKU</th><th>Product</th><th>Pack</th><th>Total Qty</th><th>Orders</th><th>Total Value</th></tr></thead>
        <tbody>${data.sku_summary.map((s) => `<tr><td>${s.sku_code}</td><td>${s.product_name}</td><td>${s.pack_size || ''}</td><td>${s.total_qty}</td><td>${s.order_count}</td><td>${fmtMoney(s.total_value)}</td></tr>`).join('')}</tbody>
      </table>
      ${!data.sku_summary.length ? '<p class="muted">No orders to consolidate for today.</p>' : ''}
    </div>`);
}

// ---------- Management: Dashboard ----------
async function renderDashboard() {
  const date = todayISO();
  const d = await api(`/dashboard/summary?date=${date}`);
  const wrap = el(`
    <div>
      <div class="grid cols-4">
        <div class="card kpi"><div class="value">${d.orderStats.order_count}</div><div class="label">Today's Orders</div></div>
        <div class="card kpi"><div class="value">${fmtMoney(d.orderStats.order_value)}</div><div class="label">Order Value</div></div>
        <div class="card kpi"><div class="value">${d.retailerStats.new_today}</div><div class="label">New Retailers Today</div></div>
        <div class="card kpi"><div class="value">${d.visitStats.total_visits || 0}</div><div class="label">Field Visits Today</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <p class="section-title">Orders by Distributor</p>
          <table><thead><tr><th>Distributor</th><th>Orders</th><th>Value</th></tr></thead>
          <tbody>${d.byDistributor.map((r) => `<tr><td>${r.name}</td><td>${r.order_count}</td><td>${fmtMoney(r.order_value)}</td></tr>`).join('')}</tbody></table>
        </div>
        <div class="card">
          <p class="section-title">Orders by Sales Employee</p>
          <table><thead><tr><th>Employee</th><th>Orders</th><th>Value</th></tr></thead>
          <tbody>${d.byEmployee.map((r) => `<tr><td>${r.name}</td><td>${r.order_count}</td><td>${fmtMoney(r.order_value)}</td></tr>`).join('')}</tbody></table>
        </div>
      </div>
      <div class="card">
        <p class="section-title">Top SKUs Today</p>
        <table><thead><tr><th>SKU</th><th>Qty</th><th>Value</th></tr></thead>
        <tbody>${d.topSkus.map((r) => `<tr><td>${r.name} (${r.sku_code})</td><td>${r.qty}</td><td>${fmtMoney(r.value)}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="card">
        <p class="section-title">Orders by Status</p>
        <table><thead><tr><th>Status</th><th>Count</th><th>Value</th></tr></thead>
        <tbody>${d.byStatus.map((r) => `<tr><td><span class="badge ${r.status}">${r.status.replace(/_/g, ' ')}</span></td><td>${r.cnt}</td><td>${fmtMoney(r.value)}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>`);
  return wrap;
}

// ---------- Management: All Orders ----------
async function renderAllOrders() {
  const orders = await api('/orders');
  return el(`<div class="card"><p class="section-title">All Orders</p>${ordersTable(orders, { showEmployee: true, showDistributor: true })}</div>`);
}

// ---------- Management: Masters ----------
async function renderMasters() {
  const wrap = el(`
    <div>
      <div class="card">
        <p class="section-title">Territories</p>
        <div class="grid cols-3">
          <div class="field"><label>Name</label><input id="mtName" /></div>
          <div class="field"><label>State</label><input id="mtState" /></div>
          <div class="field"><label>District</label><input id="mtDistrict" /></div>
        </div>
        <button class="btn small" id="addTerritory">Add Territory</button>
        <div id="territoryList" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <p class="section-title">Distributors</p>
        <div class="grid cols-3">
          <div class="field"><label>Name</label><input id="mdName" /></div>
          <div class="field"><label>Mobile</label><input id="mdMobile" /></div>
          <div class="field"><label>Address</label><input id="mdAddress" /></div>
        </div>
        <button class="btn small" id="addDistributor">Add Distributor</button>
        <div id="distributorList" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <p class="section-title">Field Employees</p>
        <div class="grid cols-3">
          <div class="field"><label>Name</label><input id="meName" /></div>
          <div class="field"><label>Mobile</label><input id="meMobile" /></div>
          <div class="field"><label>Designation</label><input id="meDesignation" /></div>
          <div class="field"><label>Assigned Distributor</label><select id="meDistributor"></select></div>
        </div>
        <button class="btn small" id="addEmployee">Add Employee</button>
        <div id="employeeList" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <p class="section-title">Product / SKU Master</p>
        <div class="grid cols-4">
          <div class="field"><label>SKU Code</label><input id="mpCode" /></div>
          <div class="field"><label>Name</label><input id="mpName" /></div>
          <div class="field"><label>Pack Size</label><input id="mpPack" /></div>
          <div class="field"><label>MRP</label><input id="mpMrp" type="number" /></div>
          <div class="field"><label>Distributor Rate</label><input id="mpDistRate" type="number" /></div>
          <div class="field"><label>GST %</label><input id="mpGst" type="number" value="5" /></div>
        </div>
        <button class="btn small" id="addProduct">Add Product</button>
        <div id="productList" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <p class="section-title">Create Login</p>
        <p class="muted">Give an employee or distributor their own sign-in. Field staff use "Field Employee" and pick the matching Employee record; a distributor's warehouse/office staff use "Distributor" and pick their Distributor record.</p>
        <div class="grid cols-4">
          <div class="field"><label>Name</label><input id="ulName" /></div>
          <div class="field"><label>Mobile (login ID)</label><input id="ulMobile" /></div>
          <div class="field"><label>Password</label><input id="ulPassword" type="password" /></div>
          <div class="field"><label>Role</label>
            <select id="ulRole">
              <option value="field_employee">Field Employee</option>
              <option value="distributor">Distributor</option>
              <option value="sales_manager">Sales Manager</option>
              <option value="management">Management</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
        </div>
        <div class="grid cols-2">
          <div class="field" id="ulEmployeeWrap"><label>Employee</label><select id="ulEmployee"></select></div>
          <div class="field" id="ulDistributorWrap"><label>Distributor</label><select id="ulDistributor"></select></div>
        </div>
        <button class="btn small" id="addLogin">Create Login</button>
        <div class="error-msg" id="ulErr"></div>
        <div id="loginList" style="margin-top:10px"></div>
      </div>
    </div>`);

  async function loadTerritories() {
    const rows = await api('/territories');
    wrap.querySelector('#territoryList').innerHTML = `<table><thead><tr><th>Name</th><th>State</th><th>District</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.name}</td><td>${r.state || ''}</td><td>${r.district || ''}</td></tr>`).join('')}</tbody></table>`;
    return rows;
  }
  async function loadDistributors() {
    const rows = await api('/distributors');
    wrap.querySelector('#distributorList').innerHTML = `<table><thead><tr><th>Code</th><th>Name</th><th>Mobile</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.code}</td><td>${r.name}</td><td>${r.mobile}</td></tr>`).join('')}</tbody></table>`;
    wrap.querySelector('#meDistributor').innerHTML = rows.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
    return rows;
  }
  async function loadEmployees() {
    const rows = await api('/employees');
    wrap.querySelector('#employeeList').innerHTML = `<table><thead><tr><th>Code</th><th>Name</th><th>Mobile</th><th>Distributors</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.code}</td><td>${r.name}</td><td>${r.mobile}</td><td>${r.distributors || ''}</td></tr>`).join('')}</tbody></table>`;
  }
  async function loadProducts() {
    const rows = await api('/products');
    wrap.querySelector('#productList').innerHTML = `<table><thead><tr><th>SKU</th><th>Name</th><th>MRP</th><th>Dist. Rate</th><th>GST%</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.sku_code}</td><td>${r.name}</td><td>${fmtMoney(r.mrp)}</td><td>${fmtMoney(r.distributor_rate)}</td><td>${r.gst_pct}</td></tr>`).join('')}</tbody></table>`;
  }

  wrap.querySelector('#addTerritory').onclick = async () => {
    await api('/territories', { method: 'POST', body: JSON.stringify({ name: wrap.querySelector('#mtName').value, state: wrap.querySelector('#mtState').value, district: wrap.querySelector('#mtDistrict').value }) });
    loadTerritories();
  };
  wrap.querySelector('#addDistributor').onclick = async () => {
    await api('/distributors', { method: 'POST', body: JSON.stringify({ name: wrap.querySelector('#mdName').value, mobile: wrap.querySelector('#mdMobile').value, address: wrap.querySelector('#mdAddress').value }) });
    loadDistributors();
  };
  wrap.querySelector('#addEmployee').onclick = async () => {
    const distId = wrap.querySelector('#meDistributor').value;
    await api('/employees', { method: 'POST', body: JSON.stringify({ name: wrap.querySelector('#meName').value, mobile: wrap.querySelector('#meMobile').value, designation: wrap.querySelector('#meDesignation').value, distributor_ids: distId ? [distId] : [] }) });
    loadEmployees();
  };
  wrap.querySelector('#addProduct').onclick = async () => {
    await api('/products', { method: 'POST', body: JSON.stringify({
      sku_code: wrap.querySelector('#mpCode').value, name: wrap.querySelector('#mpName').value, pack_size: wrap.querySelector('#mpPack').value,
      mrp: wrap.querySelector('#mpMrp').value, distributor_rate: wrap.querySelector('#mpDistRate').value, gst_pct: wrap.querySelector('#mpGst').value,
    }) });
    loadProducts();
  };

  async function loadLogins() {
    const rows = await api('/users');
    wrap.querySelector('#loginList').innerHTML = `<table><thead><tr><th>Name</th><th>Mobile</th><th>Role</th><th>Linked To</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.name}</td><td>${r.mobile}</td><td>${r.role.replace(/_/g, ' ')}</td><td>${r.employee_name || r.distributor_name || ''}</td></tr>`).join('')}</tbody></table>`;
  }
  async function loadEmployeeOptions() {
    const rows = await api('/employees');
    wrap.querySelector('#ulEmployee').innerHTML = rows.map((r) => `<option value="${r.id}">${r.name} (${r.code})</option>`).join('');
  }
  async function loadDistributorOptions() {
    const rows = await api('/distributors');
    wrap.querySelector('#ulDistributor').innerHTML = rows.map((r) => `<option value="${r.id}">${r.name} (${r.code})</option>`).join('');
  }

  wrap.querySelector('#addLogin').onclick = async () => {
    const errBox = wrap.querySelector('#ulErr');
    errBox.textContent = '';
    const role = wrap.querySelector('#ulRole').value;
    try {
      await api('/users', { method: 'POST', body: JSON.stringify({
        name: wrap.querySelector('#ulName').value,
        mobile: wrap.querySelector('#ulMobile').value,
        password: wrap.querySelector('#ulPassword').value,
        role,
        employee_id: role === 'field_employee' ? wrap.querySelector('#ulEmployee').value : null,
        distributor_id: role === 'distributor' ? wrap.querySelector('#ulDistributor').value : null,
      }) });
      loadLogins();
    } catch (e) { errBox.textContent = e.message; }
  };

  await loadTerritories();
  await loadDistributors();
  await loadEmployees();
  await loadProducts();
  await loadEmployeeOptions();
  await loadDistributorOptions();
  await loadLogins();
  return wrap;
}

render();
