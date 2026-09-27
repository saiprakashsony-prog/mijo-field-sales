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
        <label>Shop Location * (search, click the map, or drag the pin to the exact spot)</label>
        <div class="map-search-row">
          <input id="mapSearchInput" placeholder="Search for the shop or area name..." />
          <button class="btn secondary small" id="mapSearchBtn">Search</button>
          <button class="btn secondary small" id="useMyLocationBtn">Use My Location</button>
        </div>
        <div id="mapSearchResults" class="map-search-results" style="display:none"></div>
        <div id="retailerMap"></div>
        <div id="gpsStatus" class="muted">Not captured yet — search, click the map, or use your current location.</div>
        <div id="deviceLocStatus" class="muted">Checking your current location for the 100m proximity check...</div>
      </div>
      <div id="dupWarning"></div>
      <button class="btn" id="saveRetailer" style="margin-top:10px">Save Retailer</button>
      <div class="error-msg" id="rErr"></div>
      <div id="rOk"></div>
    </div>`);

  let gps = null;
  let map, marker;
  let deviceLoc = null; // the employee's actual current device GPS, for the 100m proximity check
  const GEOFENCE_METERS = 100;
  const DEFAULT_CENTER = [17.3850, 78.4867]; // Hyderabad — used until a location is picked

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function refreshDeviceLocation() {
    const statusEl = wrap.querySelector('#deviceLocStatus');
    if (!navigator.geolocation) {
      statusEl.textContent = 'Your browser does not support location access — the 100m proximity check cannot run, so saving will be blocked.';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        deviceLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        statusEl.textContent = `Your current location is confirmed (±${Math.round(pos.coords.accuracy)}m). You must place the pin within ${GEOFENCE_METERS}m of here to save.`;
        checkGeofence();
      },
      () => {
        statusEl.textContent = 'Could not confirm your current location — enable location access in your browser, then reload this tab. Saving is blocked until this succeeds.';
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }
  refreshDeviceLocation();

  function checkGeofence() {
    const geoBox = wrap.querySelector('#dupWarning');
    if (!gps || !deviceLoc) return true; // nothing to compare yet — save button itself still blocks below
    const dist = Math.round(haversineMeters(gps.lat, gps.lng, deviceLoc.lat, deviceLoc.lng));
    const existing = geoBox.querySelector('.geofence-warning');
    if (existing) existing.remove();
    if (dist > GEOFENCE_METERS) {
      geoBox.insertAdjacentHTML('afterbegin', `<div class="card geofence-warning" style="border-color:var(--danger);background:#fef2f2"><b>Too far from your current location:</b> the pin is ${dist}m away, but it must be within ${GEOFENCE_METERS}m. Move closer, or adjust the pin to your actual position.</div>`);
      return false;
    }
    return true;
  }

  async function checkDuplicates() {
    if (!gps) return;
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
  }

  function setLocation(lat, lng, source) {
    gps = { lat, lng };
    if (marker) marker.setLatLng([lat, lng]);
    wrap.querySelector('#gpsStatus').textContent = `Captured (${source}): ${lat.toFixed(6)}, ${lng.toFixed(6)} — drag the pin to fine-tune.`;
    checkGeofence();
    checkDuplicates();
  }

  // Leaflet needs the container to already be in the DOM with real size, so this
  // runs after the caller has appended `wrap` (see the setTimeout note below).
  function initMap() {
    map = L.map('retailerMap').setView(DEFAULT_CENTER, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    marker = L.marker(DEFAULT_CENTER, { draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      setLocation(pos.lat, pos.lng, 'dragged pin');
    });
    map.on('click', (e) => {
      map.setView(e.latlng, map.getZoom());
      setLocation(e.latlng.lat, e.latlng.lng, 'map click');
    });
  }
  setTimeout(initMap, 0);

  wrap.querySelector('#useMyLocationBtn').onclick = () => {
    const statusEl = wrap.querySelector('#gpsStatus');
    statusEl.textContent = 'Getting your current location...';
    if (!navigator.geolocation) { statusEl.textContent = 'Geolocation not supported by this browser.'; return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 17);
        setLocation(pos.coords.latitude, pos.coords.longitude, `your location, ±${Math.round(pos.coords.accuracy)}m`);
      },
      (err) => { statusEl.textContent = 'Could not get your location: ' + err.message; },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  async function runSearch() {
    const q = wrap.querySelector('#mapSearchInput').value.trim();
    const resultsBox = wrap.querySelector('#mapSearchResults');
    if (!q) return;
    resultsBox.style.display = 'block';
    resultsBox.innerHTML = '<div class="muted">Searching...</div>';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=in&q=${encodeURIComponent(q)}`);
      const results = await res.json();
      if (!results.length) { resultsBox.innerHTML = '<div class="muted">No results — try clicking the map directly instead.</div>'; return; }
      resultsBox.innerHTML = '';
      results.forEach((r) => {
        const item = el(`<div>${r.display_name}</div>`);
        item.onclick = () => {
          const lat = Number(r.lat), lng = Number(r.lon);
          map.setView([lat, lng], 17);
          setLocation(lat, lng, 'search result');
          resultsBox.style.display = 'none';
        };
        resultsBox.appendChild(item);
      });
    } catch {
      resultsBox.innerHTML = '<div class="muted">Search failed — try clicking the map directly instead.</div>';
    }
  }
  wrap.querySelector('#mapSearchBtn').onclick = runSearch;
  wrap.querySelector('#mapSearchInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } };

  wrap.querySelector('#saveRetailer').onclick = async () => {
    const errBox = wrap.querySelector('#rErr');
    const okBox = wrap.querySelector('#rOk');
    errBox.textContent = ''; okBox.textContent = '';
    if (!gps) { errBox.textContent = 'Please set the shop location on the map before saving.'; return; }
    if (!deviceLoc) { errBox.textContent = 'Your current location could not be confirmed, so this cannot be saved yet — enable location access and wait for confirmation above, then try again.'; return; }
    if (!checkGeofence()) { errBox.textContent = 'The pin is too far from your current location. Move closer or adjust the pin, then save again.'; return; }
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
        device_lat: deviceLoc.lat, device_lng: deviceLoc.lng,
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
  // rate = Retailer Price (MRP marked down by the product's retailer margin), GST-inclusive —
  // this is what the retailer actually pays, no GST added on top. Each line can be ordered as
  // full cartons, loose packs, or both — total qty = cartons * units_per_carton + packs.
  const productOptions = products.map((p) => `<option value="${p.id}" data-rate="${p.retailer_price}" data-upc="${p.units_per_carton}">${p.name} — ${p.sku_code} (${p.pack_size || ''}, ${p.units_per_carton} packs/carton)</option>`).join('');

  function addLine() {
    const row = el(`
      <div class="line-item">
        <div class="field" style="margin:0"><label>Product</label><select class="lp">${productOptions}</select></div>
        <div class="field" style="margin:0"><label>Cartons</label><input class="lc" type="number" min="0" value="0" /></div>
        <div class="field" style="margin:0"><label>Loose Packs</label><input class="lq" type="number" min="0" value="1" /></div>
        <div class="field" style="margin:0"><label>Rate/pack</label><input class="lr" disabled /></div>
        <div class="field" style="margin:0"><label>Net</label><input class="ln" disabled /></div>
        <button class="btn small secondary" style="height:36px">✕</button>
      </div>`);
    function recalc() {
      const opt = row.querySelector('.lp').selectedOptions[0];
      const rate = Number(opt.dataset.rate);
      const upc = Number(opt.dataset.upc) || 1;
      const cartons = Number(row.querySelector('.lc').value || 0);
      const packs = Number(row.querySelector('.lq').value || 0);
      const totalQty = cartons * upc + packs;
      const net = totalQty * rate;
      row.querySelector('.lr').value = rate.toFixed(2);
      row.querySelector('.ln').value = net.toFixed(2);
      updateTotal();
    }
    row.querySelector('.lp').onchange = recalc;
    row.querySelector('.lc').oninput = recalc;
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
      carton_qty: Number(r.querySelector('.lc').value || 0),
      pack_qty: Number(r.querySelector('.lq').value || 0),
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
        <thead><tr><th>SKU</th><th>Product</th><th>Pack</th><th>Pick as</th><th>Total Qty (packs)</th><th>Orders</th><th>Total Value</th></tr></thead>
        <tbody>${data.sku_summary.map((s) => `<tr><td>${s.sku_code}</td><td>${s.product_name}</td><td>${s.pack_size || ''}</td><td>${s.pick_cartons > 0 ? `${s.pick_cartons} carton${s.pick_cartons > 1 ? 's' : ''}` : ''}${s.pick_cartons > 0 && s.pick_loose_packs > 0 ? ' + ' : ''}${s.pick_loose_packs > 0 ? `${s.pick_loose_packs} loose` : (s.pick_cartons > 0 ? '' : `${s.total_qty} loose`)}</td><td>${s.total_qty}</td><td>${s.order_count}</td><td>${fmtMoney(s.total_value)}</td></tr>`).join('')}</tbody>
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
          <div class="field"><label>State</label>
            <select id="mtState"><option value="">-- select state --</option>${window.INDIA_STATE_LIST.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
          </div>
          <div class="field"><label>District</label>
            <select id="mtDistrict"><option value="">-- select state first --</option></select>
          </div>
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
        <div id="editEmployeeBox"></div>
        <div id="employeeList" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <p class="section-title">Categories</p>
        <div class="grid cols-3">
          <div class="field"><label>Category Name</label><input id="mcName" /></div>
        </div>
        <button class="btn small" id="addCategory">Add Category</button>
        <div id="categoryList" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <p class="section-title">Product / SKU Master</p>
        <p class="muted">All prices are GST-inclusive. Retailer Price = MRP marked down by Retailer Margin %. Distributor Price = Retailer Price marked down by Distributor Margin % (informational, used for your own costing reference).</p>
        <div class="grid cols-4">
          <div class="field"><label>SKU Code</label><input id="mpCode" /></div>
          <div class="field"><label>Name</label><input id="mpName" /></div>
          <div class="field"><label>Category</label><select id="mpCategory"><option value="">-- none --</option></select></div>
          <div class="field"><label>Pack Size</label><input id="mpPack" /></div>
          <div class="field"><label>MRP (incl. GST)</label><input id="mpMrp" type="number" /></div>
          <div class="field"><label>Retailer Margin %</label><input id="mpRetailerMargin" type="number" step="0.01" /></div>
          <div class="field"><label>Distributor Margin %</label><input id="mpDistMargin" type="number" step="0.01" /></div>
          <div class="field"><label>GST % (for invoice display only)</label><input id="mpGst" type="number" value="5" /></div>
          <div class="field"><label>Packs per Carton</label><input id="mpUnitsPerCarton" type="number" min="1" value="1" /></div>
        </div>
        <button class="btn small" id="addProduct">Add Product</button>
        <div id="editProductBox"></div>
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
    const box = wrap.querySelector('#territoryList');
    box.innerHTML = `<table><thead><tr><th>Name</th><th>State</th><th>District</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr data-id="${r.id}"><td>${r.name}</td><td>${r.state || ''}</td><td>${r.district || ''}</td><td><button class="btn small secondary delTerritoryBtn">Delete</button></td></tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('.delTerritoryBtn').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Delete this territory?')) return;
        try {
          await api(`/territories/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
          loadTerritories();
        } catch (e) { alert(e.message); }
      };
    });
    return rows;
  }
  async function loadDistributors() {
    const rows = await api('/distributors');
    const box = wrap.querySelector('#distributorList');
    box.innerHTML = `<table><thead><tr><th>Code</th><th>Name</th><th>Mobile</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr data-id="${r.id}"><td>${r.code}</td><td>${r.name}</td><td>${r.mobile}</td><td><button class="btn small secondary delDistributorBtn">Delete</button></td></tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('.delDistributorBtn').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Delete this distributor?')) return;
        try {
          await api(`/distributors/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
          loadDistributors();
        } catch (e) { alert(e.message); }
      };
    });
    wrap.querySelector('#meDistributor').innerHTML = rows.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
    return rows;
  }
  async function loadEmployees() {
    const rows = await api('/employees');
    const box = wrap.querySelector('#employeeList');
    box.innerHTML = `<table><thead><tr><th>Code</th><th>Name</th><th>Mobile</th><th>Distributors</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-id="${r.id}">
        <td>${r.code}</td><td>${r.name}</td><td>${r.mobile}</td><td>${r.distributors || ''}</td>
        <td><span class="badge ${r.status === 'active' ? 'delivered' : 'cancelled'}">${r.status}</span></td>
        <td>
          <button class="btn small secondary editEmployeeBtn">Edit</button>
          ${r.status === 'active' ? '<button class="btn small secondary toggleEmpBtn" data-next="inactive">Deactivate</button>' : '<button class="btn small secondary toggleEmpBtn" data-next="active">Reactivate</button>'}
        </td>
      </tr>`).join('')}</tbody></table>`;

    box.querySelectorAll('.toggleEmpBtn').forEach((btn) => {
      btn.onclick = async () => {
        const tr = btn.closest('tr');
        await api(`/employees/${tr.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.next }) });
        loadEmployees();
      };
    });
    box.querySelectorAll('.editEmployeeBtn').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.closest('tr').dataset.id;
        openEmployeeEditor(rows.find((r) => String(r.id) === id));
      };
    });
    return rows;
  }

  function openEmployeeEditor(emp) {
    const editBox = wrap.querySelector('#editEmployeeBox');
    editBox.innerHTML = `
      <div class="card" style="border-color:var(--brand)">
        <p class="section-title">Edit Employee — ${emp.code}</p>
        <div class="grid cols-3">
          <div class="field"><label>Name</label><input id="eeName" value="${emp.name}" /></div>
          <div class="field"><label>Mobile</label><input id="eeMobile" value="${emp.mobile}" /></div>
          <div class="field"><label>Designation</label><input id="eeDesignation" value="${emp.designation || ''}" /></div>
          <div class="field"><label>Assigned Distributor</label><select id="eeDistributor">${wrap.querySelector('#meDistributor').innerHTML}</select></div>
          <div class="field"><label>Status</label>
            <select id="eeStatus"><option value="active" ${emp.status === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${emp.status === 'inactive' ? 'selected' : ''}>Inactive</option></select>
          </div>
        </div>
        <button class="btn small" id="eeSave">Save</button>
        <button class="btn small secondary" id="eeCancel">Cancel</button>
      </div>`;
    editBox.querySelector('#eeCancel').onclick = () => { editBox.innerHTML = ''; };
    editBox.querySelector('#eeSave').onclick = async () => {
      try {
        await api(`/employees/${emp.id}`, { method: 'PATCH', body: JSON.stringify({
          name: editBox.querySelector('#eeName').value,
          mobile: editBox.querySelector('#eeMobile').value,
          designation: editBox.querySelector('#eeDesignation').value,
          distributor_ids: [editBox.querySelector('#eeDistributor').value],
          status: editBox.querySelector('#eeStatus').value,
        }) });
        editBox.innerHTML = '';
        loadEmployees();
      } catch (e) { alert(e.message); }
    };
  }
  async function loadCategories() {
    const rows = await api('/categories');
    const box = wrap.querySelector('#categoryList');
    box.innerHTML = `<table><thead><tr><th>Name</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr data-id="${r.id}"><td>${r.name}</td><td>
      <button class="btn small secondary renameCatBtn">Rename</button>
      <button class="btn small secondary delCatBtn">Delete</button>
    </td></tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('.renameCatBtn').forEach((btn) => {
      btn.onclick = async () => {
        const tr = btn.closest('tr');
        const current = tr.querySelector('td').textContent;
        const next = prompt('Rename category to:', current);
        if (!next || next.trim() === current) return;
        try {
          await api(`/categories/${tr.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ name: next.trim() }) });
          loadCategories();
        } catch (e) { alert(e.message); }
      };
    });
    box.querySelectorAll('.delCatBtn').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Delete this category? Existing products keep their current category text either way.')) return;
        await api(`/categories/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
        loadCategories();
      };
    });
    wrap.querySelector('#mpCategory').innerHTML = '<option value="">-- none --</option>' + rows.map((r) => `<option value="${r.name}">${r.name}</option>`).join('');
    return rows;
  }

  function productFormValues() {
    return {
      sku_code: wrap.querySelector('#mpCode').value,
      name: wrap.querySelector('#mpName').value,
      category: wrap.querySelector('#mpCategory').value || null,
      pack_size: wrap.querySelector('#mpPack').value,
      mrp: wrap.querySelector('#mpMrp').value,
      retailer_margin_pct: wrap.querySelector('#mpRetailerMargin').value,
      distributor_margin_pct: wrap.querySelector('#mpDistMargin').value,
      gst_pct: wrap.querySelector('#mpGst').value,
      units_per_carton: wrap.querySelector('#mpUnitsPerCarton').value || 1,
    };
  }
  function clearProductForm() {
    wrap.querySelector('#mpCode').value = '';
    wrap.querySelector('#mpName').value = '';
    wrap.querySelector('#mpCategory').value = '';
    wrap.querySelector('#mpPack').value = '';
    wrap.querySelector('#mpMrp').value = '';
    wrap.querySelector('#mpRetailerMargin').value = '';
    wrap.querySelector('#mpDistMargin').value = '';
    wrap.querySelector('#mpGst').value = '5';
    wrap.querySelector('#mpUnitsPerCarton').value = '1';
  }

  async function loadProducts() {
    const rows = await api('/products');
    const box = wrap.querySelector('#productList');
    box.innerHTML = `<table><thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>MRP</th><th>Retailer Price</th><th>Distributor Price</th><th>GST%</th><th>Packs/Carton</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-id="${r.id}">
        <td>${r.sku_code}</td><td>${r.name}</td><td>${r.category || ''}</td><td>${fmtMoney(r.mrp)}</td><td>${fmtMoney(r.retailer_price)}</td><td>${fmtMoney(r.distributor_price)}</td><td>${r.gst_pct}</td><td>${r.units_per_carton}</td>
        <td><button class="btn small secondary editProductBtn">Edit</button> <button class="btn small secondary delProductBtn">Delete</button></td>
      </tr>`).join('')}</tbody></table>`;

    box.querySelectorAll('.delProductBtn').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Delete this product?')) return;
        try {
          await api(`/products/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
          loadProducts();
        } catch (e) { alert(e.message); }
      };
    });
    box.querySelectorAll('.editProductBtn').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.closest('tr').dataset.id;
        const p = rows.find((r) => String(r.id) === id);
        openProductEditor(p);
      };
    });
  }

  function openProductEditor(p) {
    const editBox = wrap.querySelector('#editProductBox');
    editBox.innerHTML = `
      <div class="card" style="border-color:var(--brand)">
        <p class="section-title">Edit Product — ${p.sku_code}</p>
        <div class="grid cols-4">
          <div class="field"><label>Name</label><input id="epName" value="${p.name}" /></div>
          <div class="field"><label>Category</label><select id="epCategory">${wrap.querySelector('#mpCategory').innerHTML}</select></div>
          <div class="field"><label>Pack Size</label><input id="epPack" value="${p.pack_size || ''}" /></div>
          <div class="field"><label>MRP (incl. GST)</label><input id="epMrp" type="number" value="${p.mrp}" /></div>
          <div class="field"><label>Retailer Margin %</label><input id="epRetailerMargin" type="number" step="0.01" value="${p.retailer_margin_pct}" /></div>
          <div class="field"><label>Distributor Margin %</label><input id="epDistMargin" type="number" step="0.01" value="${p.distributor_margin_pct}" /></div>
          <div class="field"><label>GST %</label><input id="epGst" type="number" value="${p.gst_pct}" /></div>
          <div class="field"><label>Packs per Carton</label><input id="epUnitsPerCarton" type="number" min="1" value="${p.units_per_carton}" /></div>
          <div class="field"><label>Status</label>
            <select id="epStatus"><option value="active" ${p.status === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${p.status === 'inactive' ? 'selected' : ''}>Inactive</option></select>
          </div>
        </div>
        <button class="btn small" id="epSave">Save</button>
        <button class="btn small secondary" id="epCancel">Cancel</button>
      </div>`;
    editBox.querySelector('#epCategory').value = p.category || '';
    editBox.querySelector('#epCancel').onclick = () => { editBox.innerHTML = ''; };
    editBox.querySelector('#epSave').onclick = async () => {
      await api(`/products/${p.id}`, { method: 'PATCH', body: JSON.stringify({
        name: editBox.querySelector('#epName').value,
        category: editBox.querySelector('#epCategory').value || null,
        pack_size: editBox.querySelector('#epPack').value,
        mrp: editBox.querySelector('#epMrp').value,
        retailer_margin_pct: editBox.querySelector('#epRetailerMargin').value,
        distributor_margin_pct: editBox.querySelector('#epDistMargin').value,
        gst_pct: editBox.querySelector('#epGst').value,
        units_per_carton: editBox.querySelector('#epUnitsPerCarton').value || 1,
        status: editBox.querySelector('#epStatus').value,
      }) });
      editBox.innerHTML = '';
      loadProducts();
    };
  }

  wrap.querySelector('#mtState').onchange = (e) => {
    const districts = window.INDIA_STATES_DISTRICTS[e.target.value] || [];
    wrap.querySelector('#mtDistrict').innerHTML = districts.length
      ? districts.map((d) => `<option value="${d}">${d}</option>`).join('')
      : '<option value="">-- select state first --</option>';
  };

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
  wrap.querySelector('#addCategory').onclick = async () => {
    const name = wrap.querySelector('#mcName').value.trim();
    if (!name) return;
    try {
      await api('/categories', { method: 'POST', body: JSON.stringify({ name }) });
      wrap.querySelector('#mcName').value = '';
      loadCategories();
    } catch (e) { alert(e.message); }
  };

  wrap.querySelector('#addProduct').onclick = async () => {
    try {
      await api('/products', { method: 'POST', body: JSON.stringify(productFormValues()) });
      clearProductForm();
      loadProducts();
    } catch (e) { alert(e.message); }
  };

  async function loadLogins() {
    const rows = await api('/users');
    const box = wrap.querySelector('#loginList');
    box.innerHTML = `<table><thead><tr><th>Name</th><th>Mobile</th><th>Role</th><th>Linked To</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-id="${r.id}">
        <td>${r.name}</td><td>${r.mobile}</td><td>${r.role.replace(/_/g, ' ')}</td><td>${r.employee_name || r.distributor_name || ''}</td>
        <td><span class="badge ${r.status === 'active' ? 'delivered' : 'cancelled'}">${r.status}</span></td>
        <td>${r.status === 'active' ? '<button class="btn small secondary toggleLoginBtn" data-next="inactive">Deactivate</button>' : '<button class="btn small secondary toggleLoginBtn" data-next="active">Reactivate</button>'}</td>
      </tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('.toggleLoginBtn').forEach((btn) => {
      btn.onclick = async () => {
        const tr = btn.closest('tr');
        await api(`/users/${tr.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.next }) });
        loadLogins();
      };
    });
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
  await loadCategories();
  await loadProducts();
  await loadEmployeeOptions();
  await loadDistributorOptions();
  await loadLogins();
  return wrap;
}

render();
