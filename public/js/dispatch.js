// Dispatch route planning screens.
//  - renderDispatchPlanner: admin / management / sales manager — factory → distributors, saved as dispatch plans
//  - renderDeliveryRoute:   distributor / delivery executive — distributor → retailers for open orders
// Loaded before app.js; uses its globals (api, el, esc, fmtMoney, state) at call time only.

const RE = window.RouteEngine;

function localISO(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function tomorrowISO() { return localISO(new Date(Date.now() + 86400000)); }
function fmtPlanDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtLoad(n) { const v = Math.round(Number(n || 0) * 10) / 10; return Number.isInteger(v) ? String(v) : v.toFixed(1); }

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    flashToast('Copied — paste it into WhatsApp');
  } catch {
    const overlay = el(`<div class="modal-overlay"><div class="card modal-card">
      <p class="section-title">Copy this text</p>
      <p class="muted">Automatic copy was blocked — select all and copy.</p>
      <textarea style="height:260px;font-family:monospace;font-size:12px"></textarea>
      <div style="text-align:right;margin-top:8px"><button class="btn small secondary">Close</button></div></div></div>`);
    overlay.querySelector('textarea').value = text;
    overlay.querySelector('button').onclick = () => overlay.remove();
    document.body.appendChild(overlay);
    overlay.querySelector('textarea').select();
  }
}
function flashToast(msg) {
  let t = document.getElementById('dspToast');
  if (!t) { t = el('<div id="dspToast" class="dsp-toast"></div>'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Location picker (search / click map / paste coordinates) ----------
function pickLocation({ title, initial, query }) {
  return new Promise((resolve) => {
    const overlay = el(`<div class="modal-overlay"><div class="card modal-card">
      <p class="section-title">${esc(title)}</p>
      <div class="map-search-row"><input id="lpSearch" placeholder="Search a place, e.g. Kazipet, Warangal" /><button class="btn small" id="lpGo">Search</button></div>
      <div class="map-search-results" id="lpResults" style="display:none"></div>
      <div id="lpMap" style="height:320px;border-radius:8px;border:1px solid var(--border);margin-bottom:8px"></div>
      <div class="field"><label>Or paste coordinates / a Google Maps link</label><input id="lpPaste" placeholder="17.9689, 79.5941  or  https://www.google.com/maps/...@17.96,79.59,15z" /></div>
      <div class="field"><label>Location name (shown to drivers)</label><input id="lpLabel" /></div>
      <p class="muted" id="lpStatus">Search, tap the map, or paste coordinates to place the pin.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn small secondary" id="lpCancel">Cancel</button><button class="btn small" id="lpSave">Save location</button></div>
    </div></div>`);
    document.body.appendChild(overlay);
    const $ = (s) => overlay.querySelector(s);
    $('#lpSearch').value = query || '';
    $('#lpLabel').value = (initial && initial.label) || '';
    let pos = initial && initial.lat ? { lat: Number(initial.lat), lng: Number(initial.lng) } : null;
    const map = L.map($('#lpMap')).setView(pos ? [pos.lat, pos.lng] : [17.385, 78.4867], pos ? 13 : 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
    let marker = null;
    function setPos(lat, lng, how, zoom) {
      pos = { lat, lng };
      if (!marker) {
        marker = L.marker([lat, lng], { draggable: true }).addTo(map);
        marker.on('dragend', () => { const p = marker.getLatLng(); setPos(p.lat, p.lng, 'dragged pin'); });
      } else marker.setLatLng([lat, lng]);
      if (zoom) map.setView([lat, lng], zoom);
      $('#lpStatus').textContent = `Pin set (${how}): ${lat.toFixed(5)}, ${lng.toFixed(5)} — drag to fine-tune.`;
    }
    if (pos) setPos(pos.lat, pos.lng, 'saved');
    map.on('click', (e) => setPos(e.latlng.lat, e.latlng.lng, 'map tap'));
    setTimeout(() => map.invalidateSize(), 50);

    async function search() {
      const q = $('#lpSearch').value.trim();
      const box = $('#lpResults');
      if (!q) return;
      box.style.display = 'block';
      box.innerHTML = '<div class="muted">Searching...</div>';
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=in&q=${encodeURIComponent(q)}`);
        const results = await res.json();
        if (!results.length) { box.innerHTML = '<div class="muted">No results — try a nearby town, or tap the map.</div>'; return; }
        box.innerHTML = '';
        results.forEach((r) => {
          const item = el(`<div>${esc(r.display_name)}</div>`);
          item.onclick = () => {
            setPos(Number(r.lat), Number(r.lon), 'search', 14);
            if (!$('#lpLabel').value.trim()) $('#lpLabel').value = String(r.display_name).split(',').slice(0, 2).join(',').trim();
            box.style.display = 'none';
          };
          box.appendChild(item);
        });
      } catch {
        box.innerHTML = '<div class="muted">Search failed — tap the map or paste coordinates instead.</div>';
      }
    }
    $('#lpGo').onclick = search;
    $('#lpSearch').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
    $('#lpPaste').oninput = () => {
      const c = RE.parseCoords($('#lpPaste').value);
      if (c) setPos(c.lat, c.lng, 'pasted', 14);
      else if ($('#lpPaste').value.includes('goo.gl')) $('#lpStatus').textContent = 'Short maps.app.goo.gl links hide the coordinates — open the link, then copy the coordinates shown in Google Maps.';
    };
    const close = (v) => { map.remove(); overlay.remove(); resolve(v); };
    $('#lpCancel').onclick = () => close(null);
    $('#lpSave').onclick = () => {
      if (!pos) { $('#lpStatus').textContent = 'Place the pin first.'; return; }
      close({ lat: pos.lat, lng: pos.lng, label: $('#lpLabel').value.trim().replace(/[<>]/g, '') });
    };
  });
}

// ---------- Route result (shared by both screens) ----------
// view = { depot:{lat,lng,label}, departMinutes, returnToDepot, vehicles:[{legs,back,km,end,load,info}], cap,
//          unit:'cases'|'cartons', kind:'dispatch'|'delivery', dateISO, saved:{id,plan_no,status}|null, active }
function routeShareText(view, vi) {
  const v = view.vehicles[vi];
  const info = v.info || {};
  let t = `🚚 ${view.kind === 'dispatch' ? 'DISPATCH' : 'DELIVERY ROUTE'} – ${view.vehicles.length > 1 ? 'Vehicle ' + (vi + 1) + ' – ' : ''}${fmtPlanDate(view.dateISO)}\n`;
  if (view.saved) t += `Plan: ${view.saved.plan_no}\n`;
  if (info.vehicle_reg) t += `Vehicle: ${info.vehicle_reg}\n`;
  if (info.driver_name) t += `Driver: ${info.driver_name}${info.driver_mobile ? ' (' + info.driver_mobile + ')' : ''}\n`;
  t += `Start: ${view.depot.label} at ${RE.fmtClock(view.departMinutes)}\n\nDELIVERY ORDER\n`;
  v.legs.forEach((l) => {
    t += `${l.no}. ${l.stop.title}${l.stop.area ? ' – ' + l.stop.area : ''}${l.stop.load ? ' – ' + l.stop.loadText : ''} – ETA ${RE.fmtClock(l.arrive)}${l.stop.phone ? ' – ☎ ' + l.stop.phone : ''}\n`;
  });
  if (v.back) t += `Return to start ~ ${RE.fmtClock(v.back.arrive)}\n`;
  t += `\nTotal ≈ ${Math.round(v.km)} km${v.load ? ' · ' + fmtLoad(v.load) + ' ' + view.unit : ''}\n\nLOADING ORDER (load first → last)\n`;
  v.legs.slice().reverse().forEach((l, i) => {
    t += `${i + 1}. Stop ${l.no} – ${l.stop.title}${l.stop.load ? ' (' + l.stop.loadText + ')' : ''}${i === 0 ? '  ← deepest, behind cabin' : ''}${i === v.legs.length - 1 ? '  ← at the door' : ''}\n`;
  });
  t += '\nNAVIGATION\n';
  RE.mapsLinks(view.depot, v.legs, view.returnToDepot).forEach((m) => { t += `${m.label}: ${m.url}\n`; });
  return t;
}

function renderRouteResult(container, view, hooks = {}) {
  if (container._map) { container._map.remove(); container._map = null; }
  const vi = Math.min(view.active || 0, view.vehicles.length - 1);
  const v = view.vehicles[vi];
  const color = RE.COLORS[vi % RE.COLORS.length];
  const totKm = view.vehicles.reduce((a, x) => a + x.km, 0);
  const stopsN = view.vehicles.reduce((a, x) => a + x.legs.length, 0);
  const longest = Math.max(...view.vehicles.map((x) => x.end - view.departMinutes));
  const info = v.info || (v.info = {});
  const links = RE.mapsLinks(view.depot, v.legs, view.returnToDepot);
  const reversed = v.legs.slice().reverse();

  container.innerHTML = '';
  const node = el(`<div>
    ${view.saved ? `<div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div><p class="section-title" style="margin:0">${esc(view.saved.plan_no)} · ${esc(fmtPlanDate(view.dateISO))}</p></div>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="dspStatus" style="width:auto">${['planned', 'dispatched', 'completed', 'cancelled'].map((s) => `<option value="${s}" ${s === view.saved.status ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
          ${hooks.onDelete ? '<button class="btn small secondary" id="dspDelete">Delete plan</button>' : ''}
          <button class="btn small secondary" id="dspClose">Close</button>
        </div></div>` : ''}
    <div class="grid cols-4">
      <div class="card kpi"><div class="value">${stopsN}</div><div class="label">${view.kind === 'dispatch' ? 'distributors' : 'retailers'}</div></div>
      <div class="card kpi"><div class="value">${view.vehicles.length}</div><div class="label">vehicle${view.vehicles.length > 1 ? 's' : ''}</div></div>
      <div class="card kpi"><div class="value">≈ ${Math.round(totKm)} km</div><div class="label">total road distance (est.)</div></div>
      <div class="card kpi"><div class="value">${RE.fmtDuration(longest)}</div><div class="label">longest trip incl. unloading</div></div>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><div class="dsp-map"></div></div>
    <p class="muted" style="margin:-6px 2px 10px;font-size:12px">Lines on the map are straight between stops; distances are estimates (straight line × ${RE.ROAD_FACTOR}). Drivers should follow the Google Maps buttons for real roads.</p>
    ${view.vehicles.length > 1 ? `<div class="dsp-vtabs">${view.vehicles.map((x, i) => `<button data-v="${i}" class="${i === vi ? 'active' : ''}"><span class="dsp-dot" style="background:${RE.COLORS[i % RE.COLORS.length]}"></span>Vehicle ${i + 1} · ${x.legs.length} stops · ${Math.round(x.km)} km</button>`).join('')}</div>` : ''}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
        <div><p class="section-title" style="margin-bottom:4px">${view.vehicles.length > 1 ? `Vehicle ${vi + 1} — ` : ''}Driver route sheet</p>
          <span class="muted">≈ ${Math.round(v.km)} km · ${RE.fmtClock(view.departMinutes)} → ${RE.fmtClock(v.end)}${v.load ? ` · ${fmtLoad(v.load)} ${view.unit}` : ''}</span></div>
        <button class="btn small" id="dspShare">Copy for WhatsApp</button>
      </div>
      ${view.cap && v.load > view.cap ? `<div class="dsp-warn">Load of ${fmtLoad(v.load)} ${view.unit} is over the ${view.cap}-${view.unit} capacity. Add a vehicle or move a stop to another trip.</div>` : ''}
      ${hooks.showDriverFields ? `<div class="grid cols-3" style="margin-top:10px">
        <div class="field"><label>Vehicle number</label><input data-info="vehicle_reg" value="${esc(info.vehicle_reg || '')}" placeholder="TS 09 AB 1234" /></div>
        <div class="field"><label>Driver name</label><input data-info="driver_name" value="${esc(info.driver_name || '')}" /></div>
        <div class="field"><label>Driver mobile</label><input data-info="driver_mobile" value="${esc(info.driver_mobile || '')}" /></div>
      </div>${view.saved ? '<button class="btn small secondary" id="dspSaveDriver">Save vehicle &amp; driver details</button>' : ''}` : ''}
      <table style="margin-top:10px"><thead><tr><th>Stop</th><th>${view.kind === 'dispatch' ? 'Distributor' : 'Retailer'}</th><th>${view.kind === 'dispatch' ? 'Location' : 'Orders'}</th><th>${view.unit === 'cases' ? 'Cases' : 'Load'}</th><th>Leg km</th><th>ETA</th></tr></thead><tbody>
        <tr class="dsp-depot"><td>—</td><td colspan="3">Start: ${esc(view.depot.label)}</td><td></td><td>${RE.fmtClock(view.departMinutes)}</td></tr>
        ${v.legs.map((l) => `<tr>
          <td><span class="dsp-num" style="background:${color}">${l.no}</span></td>
          <td style="white-space:normal"><b>${esc(l.stop.title)}</b>${l.stop.phone ? `<br/><a href="tel:${esc(l.stop.phone)}" style="color:var(--brand);font-size:12px">☎ ${esc(l.stop.phone)}</a>` : ''}</td>
          <td style="white-space:normal">${esc(l.stop.area || '')}</td>
          <td>${l.stop.load ? esc(l.stop.loadText) : '—'}</td>
          <td>${Math.round(l.km)}</td>
          <td>${RE.fmtClock(l.arrive)}</td></tr>`).join('')}
        ${v.back ? `<tr class="dsp-depot"><td>—</td><td colspan="3">Return to start</td><td>${Math.round(v.back.km)}</td><td>${RE.fmtClock(v.back.arrive)}</td></tr>` : ''}
      </tbody></table>
      <p class="section-title" style="margin:14px 0 6px">Navigation</p>
      <div>${links.map((m) => `<a class="dsp-nav" href="${esc(m.url)}" target="_blank" rel="noopener">▶ Google Maps: ${esc(m.label)}</a>`).join('')}</div>
      ${links.length > 1 ? '<p class="muted" style="font-size:12px">Google Maps takes up to 8 stops per link, so this route is split into parts — open them one after another.</p>' : ''}
      <p class="section-title" style="margin:14px 0 4px">Truck loading sequence</p>
      <p class="muted" style="margin:0">Load the <b>last</b> drop first so it sits deepest, behind the cabin. The <b>first</b> drop goes in last, at the door.</p>
      <div class="dsp-truck"><div class="dsp-cab">Cabin</div><div class="dsp-bay">
        ${reversed.map((l) => `<div class="dsp-box" style="background:${color};opacity:${0.55 + 0.45 * (1 - (l.no - 1) / Math.max(1, v.legs.length))};flex:${Math.max(1, Number(l.stop.load) || 1)}"><b>Stop ${l.no}</b><span>${esc(String(l.stop.title).slice(0, 14))}</span></div>`).join('')}
      </div><div class="dsp-door">Door</div></div>
      <table><tbody>${reversed.map((l, i) => `<tr><td style="width:70px" class="muted">Load ${i + 1}</td><td style="width:34px"><span class="dsp-num" style="background:${color}">${l.no}</span></td><td style="white-space:normal"><b>${esc(l.stop.title)}</b>${l.stop.load ? ` · ${esc(l.stop.loadText)}` : ''}${i === 0 ? ' <span class="badge accepted">deepest</span>' : ''}${i === reversed.length - 1 ? ' <span class="badge delivered">at door</span>' : ''}</td></tr>`).join('')}</tbody></table>
    </div>
    ${hooks.onSave ? `<button class="btn" id="dspSavePlan" style="width:100%;padding:12px">Save dispatch plan</button><div class="error-msg" id="dspSaveErr"></div>` : ''}
  </div>`);
  container.appendChild(node);

  // Map
  const mapEl = node.querySelector('.dsp-map');
  const map = L.map(mapEl);
  container._map = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 18 }).addTo(map);
  const bounds = [[view.depot.lat, view.depot.lng]];
  view.vehicles.forEach((x, i) => {
    const c = RE.COLORS[i % RE.COLORS.length];
    const faded = view.vehicles.length > 1 && i !== vi;
    const path = [[view.depot.lat, view.depot.lng], ...x.legs.map((l) => [l.stop.lat, l.stop.lng])];
    L.polyline(path, { color: c, weight: faded ? 2 : 4, opacity: faded ? 0.35 : 0.9 }).addTo(map);
    if (x.back && x.legs.length) {
      const last = x.legs[x.legs.length - 1].stop;
      L.polyline([[last.lat, last.lng], [view.depot.lat, view.depot.lng]], { color: c, weight: faded ? 2 : 3, opacity: faded ? 0.3 : 0.7, dashArray: '6 8' }).addTo(map);
    }
    x.legs.forEach((l) => {
      bounds.push([l.stop.lat, l.stop.lng]);
      L.marker([l.stop.lat, l.stop.lng], {
        icon: L.divIcon({ className: '', html: `<div class="dsp-pin" style="background:${c};opacity:${faded ? 0.55 : 1}">${l.no}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: faded ? 0 : 1000,
      }).addTo(map).bindTooltip(`${view.vehicles.length > 1 ? 'V' + (i + 1) + ' · ' : ''}Stop ${l.no}: ${esc(l.stop.title)}`, { direction: 'top' });
    });
  });
  L.marker([view.depot.lat, view.depot.lng], {
    icon: L.divIcon({ className: '', html: '<div class="dsp-pin dsp-pin-depot">S</div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
    zIndexOffset: 2000,
  }).addTo(map).bindTooltip('Start: ' + esc(view.depot.label), { direction: 'top' });
  setTimeout(() => { map.invalidateSize(); map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 }); }, 0);

  // Interactions
  node.querySelectorAll('.dsp-vtabs button').forEach((b) => {
    b.onclick = () => { view.active = Number(b.dataset.v); renderRouteResult(container, view, hooks); };
  });
  node.querySelectorAll('[data-info]').forEach((inp) => {
    inp.oninput = () => { info[inp.dataset.info] = inp.value.replace(/[<>]/g, ''); };
  });
  node.querySelector('#dspShare').onclick = () => copyToClipboard(routeShareText(view, vi));
  if (hooks.onSave) node.querySelector('#dspSavePlan').onclick = (e) => hooks.onSave(e.target, node.querySelector('#dspSaveErr'));
  if (view.saved) {
    node.querySelector('#dspStatus').onchange = (e) => hooks.onStatus && hooks.onStatus(e.target.value);
    node.querySelector('#dspClose').onclick = () => hooks.onClose && hooks.onClose();
    if (hooks.onDelete) node.querySelector('#dspDelete').onclick = () => hooks.onDelete();
    const sd = node.querySelector('#dspSaveDriver');
    if (sd) sd.onclick = () => hooks.onSaveDriver && hooks.onSaveDriver();
  }
}

// ================= Factory → Distributor: Dispatch Planner =================
async function renderDispatchPlanner() {
  const [distributors, lastOrigin, plans] = await Promise.all([
    api('/dispatch/distributors'),
    api('/dispatch/plans/last-origin'),
    api('/dispatch/plans'),
  ]);
  const canEditLocations = ['super_admin', 'management'].includes(state.user.role);
  const canDelete = ['super_admin', 'management'].includes(state.user.role);

  if (!state.dispatch) {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem('dispatchDraft') || 'null'); } catch { draft = null; }
    state.dispatch = draft || {
      cases: {},
      origin: lastOrigin && lastOrigin.origin_lat
        ? { lat: Number(lastOrigin.origin_lat), lng: Number(lastOrigin.origin_lng), label: lastOrigin.origin_label }
        : { lat: 17.385, lng: 78.4867, label: 'Hyderabad (set your factory location)' },
      date: tomorrowISO(), depart: '06:00', vehicles: 1, cap: '', speed: 40, unload: 30, ret: true,
    };
    if (state.dispatch.date < localISO(new Date())) state.dispatch.date = tomorrowISO();
  }
  const D = state.dispatch;
  const saveDraft = () => { try { localStorage.setItem('dispatchDraft', JSON.stringify(D)); } catch { /* storage unavailable */ } };
  const byId = new Map(distributors.map((d) => [d.id, d]));

  const wrap = el(`<div>
    <div class="card">
      <p class="section-title">Factory → Distributor Dispatch</p>
      <p class="muted" style="margin-top:-4px">Enter the cases for each distributor, then plan. You get the best delivery order, a vehicle split, a route map, driver sheets and the truck loading sequence.</p>
      <div class="grid cols-4">
        <div class="field"><label>Dispatch date</label><input type="date" id="dDate" value="${esc(D.date)}" /></div>
        <div class="field" style="grid-column:span 2"><label>Start from</label>
          <div style="display:flex;gap:6px"><input id="dOriginLabel" value="${esc(D.origin.label)}" readonly style="background:#f9fafb" /><button class="btn small secondary" id="dOriginBtn">Change</button></div></div>
        <div class="field"><label>Departure time</label><input type="time" id="dDepart" value="${esc(D.depart)}" /></div>
      </div>
      <div class="grid cols-4">
        <div class="field"><label>Vehicles</label><select id="dVehicles">${[1, 2, 3, 4, 5, 6].map((n) => `<option ${n === Number(D.vehicles) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label>Capacity per vehicle (cases)</label><input type="number" min="0" id="dCap" value="${esc(D.cap)}" placeholder="optional" /></div>
        <div class="field"><label>Avg truck speed (km/h)</label><input type="number" min="10" max="90" id="dSpeed" value="${esc(D.speed)}" /></div>
        <div class="field"><label>Unloading time / stop (min)</label><input type="number" min="0" id="dUnload" value="${esc(D.unload)}" /></div>
      </div>
      <label style="display:flex;align-items:center;gap:6px;color:var(--ink);font-size:13px"><input type="checkbox" id="dRet" style="width:auto" ${D.ret ? 'checked' : ''}/> Vehicles return to start</label>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <p class="section-title" style="margin:0">Distributor orders</p>
        <div style="display:flex;gap:6px;align-items:center"><input id="dFilter" placeholder="Search distributor / territory" style="width:220px" /><button class="btn small secondary" id="dClear">Clear cases</button></div>
      </div>
      <table><thead><tr><th>Distributor</th><th>Territory</th><th>Location</th><th style="width:110px">Cases</th></tr></thead><tbody id="dRows"></tbody></table>
      ${!distributors.length ? '<p class="muted">No active distributors yet — add them under Masters → Distributors.</p>' : ''}
      <p class="muted" id="dSummary" style="margin-top:8px"></p>
    </div>
    <button class="btn" id="dPlan" style="width:100%;padding:12px;margin-bottom:12px">Plan route</button>
    <div id="dResult"></div>

    <div class="card">
      <p class="section-title">Saved dispatch plans</p>
      <div id="dPlans"></div>
    </div>
  </div>`);
  const $ = (s) => wrap.querySelector(s);

  function locationCell(d) {
    const has = d.gps_lat != null && d.gps_lng != null;
    return `${has ? `<span style="color:var(--ok)">✓ ${esc(d.location_label || 'Pinned')}</span>` : '<span style="color:var(--warn)">⚠ Not set</span>'}
      ${canEditLocations ? ` <button class="btn small secondary" data-loc="${d.id}" style="padding:2px 8px;margin-left:4px">${has ? 'Change' : 'Set'}</button>` : ''}`;
  }
  function renderRows() {
    const q = $('#dFilter').value.trim().toLowerCase();
    $('#dRows').innerHTML = distributors
      .filter((d) => !q || `${d.name} ${d.code} ${d.territory_name || ''} ${d.location_label || ''}`.toLowerCase().includes(q))
      .map((d) => `<tr data-id="${d.id}">
        <td style="white-space:normal"><b>${esc(d.name)}</b><br/><span class="muted" style="font-size:11px">${esc(d.code)}</span></td>
        <td>${esc(d.territory_name || '—')}</td>
        <td style="white-space:normal">${locationCell(d)}</td>
        <td><input type="number" min="0" step="1" data-cases="${d.id}" value="${esc(D.cases[d.id] || '')}" placeholder="0" /></td></tr>`).join('');
    updateSummary();
  }
  function selected() {
    return distributors.filter((d) => Number(D.cases[d.id]) > 0);
  }
  function updateSummary() {
    const sel = selected();
    const noLoc = sel.filter((d) => d.gps_lat == null);
    const total = sel.reduce((a, d) => a + Number(D.cases[d.id]), 0);
    $('#dSummary').innerHTML = sel.length
      ? `${sel.length} distributor${sel.length > 1 ? 's' : ''} · ${fmtLoad(total)} cases${noLoc.length ? ` · <span style="color:var(--warn)">${noLoc.length} without a location (set it before planning)</span>` : ''}`
      : 'Enter cases for the distributors you are shipping to.';
  }
  renderRows();

  $('#dFilter').oninput = renderRows;
  $('#dRows').addEventListener('input', (e) => {
    const id = e.target.dataset.cases;
    if (!id) return;
    if (Number(e.target.value) > 0) D.cases[id] = e.target.value; else delete D.cases[id];
    saveDraft(); updateSummary();
  });
  $('#dRows').addEventListener('click', async (e) => {
    const id = e.target.dataset.loc;
    if (!id) return;
    const d = byId.get(Number(id));
    const picked = await pickLocation({
      title: `Location of ${d.name}`,
      initial: d.gps_lat != null ? { lat: d.gps_lat, lng: d.gps_lng, label: d.location_label } : { label: d.location_label || '' },
      query: d.gps_lat == null ? [d.address, d.territory_name].filter(Boolean).join(', ') : '',
    });
    if (!picked) return;
    try {
      await api(`/dispatch/distributors/${d.id}/location`, { method: 'PATCH', body: JSON.stringify({ gps_lat: picked.lat, gps_lng: picked.lng, location_label: picked.label }) });
      d.gps_lat = picked.lat; d.gps_lng = picked.lng; d.location_label = picked.label;
      renderRows(); flashToast('Location saved');
    } catch (err) { alert(err.message); }
  });
  $('#dClear').onclick = () => { D.cases = {}; saveDraft(); renderRows(); };
  const bind = (id, key, fn) => { $(id).onchange = () => { D[key] = fn ? fn($(id)) : $(id).value; saveDraft(); }; };
  bind('#dDate', 'date'); bind('#dDepart', 'depart'); bind('#dVehicles', 'vehicles'); bind('#dCap', 'cap');
  bind('#dSpeed', 'speed'); bind('#dUnload', 'unload'); bind('#dRet', 'ret', (x) => x.checked);
  $('#dOriginBtn').onclick = async () => {
    const picked = await pickLocation({ title: 'Dispatch start location (factory / warehouse)', initial: D.origin, query: '' });
    if (!picked) return;
    D.origin = { lat: picked.lat, lng: picked.lng, label: picked.label || 'Factory' };
    $('#dOriginLabel').value = D.origin.label; saveDraft();
  };

  // Plan
  $('#dPlan').onclick = () => {
    const sel = selected();
    if (!sel.length) { alert('Enter cases for at least one distributor.'); return; }
    const noLoc = sel.filter((d) => d.gps_lat == null);
    if (noLoc.length) { alert(`Set the location first for: ${noLoc.map((d) => d.name).join(', ')}`); return; }
    const stops = sel.map((d) => {
      const cases = Number(D.cases[d.id]);
      return {
        distributor_id: d.id, title: d.name, area: d.location_label || d.territory_name || '', phone: d.mobile,
        lat: Number(d.gps_lat), lng: Number(d.gps_lng), load: cases, loadText: `${fmtLoad(cases)} cases`,
      };
    });
    const departMinutes = RE.timeToMinutes(D.depart);
    const vehicles = RE.plan(D.origin, stops, {
      vehicles: Number(D.vehicles), returnToDepot: D.ret, departMinutes, speedKmph: D.speed, unloadMinutes: D.unload,
    });
    const view = {
      kind: 'dispatch', unit: 'cases', depot: D.origin, departMinutes, returnToDepot: D.ret, dateISO: D.date,
      cap: Number(D.cap) || 0, vehicles, saved: null, active: 0,
    };
    renderRouteResult($('#dResult'), view, {
      showDriverFields: true,
      onSave: async (btn, errBox) => {
        errBox.textContent = '';
        btn.disabled = true; btn.textContent = 'Saving...';
        try {
          const r = await api('/dispatch/plans', {
            method: 'POST',
            body: JSON.stringify({
              plan_date: D.date, origin_label: D.origin.label, origin_lat: D.origin.lat, origin_lng: D.origin.lng,
              depart_time: D.depart, return_to_origin: D.ret, avg_speed_kmph: D.speed, unload_minutes: D.unload,
              vehicles: view.vehicles.map((v) => ({
                ...(v.info || {}), total_km: v.km,
                stops: v.legs.map((l) => ({ distributor_id: l.stop.distributor_id, cases: l.stop.load, leg_km: l.km, eta_minutes: l.arrive })),
              })),
            }),
          });
          D.cases = {}; saveDraft();
          flashToast(`Saved as ${r.plan_no}`);
          state.dispatchOpenPlan = r.id;
          refreshMain();
        } catch (err) {
          errBox.textContent = err.message;
          btn.disabled = false; btn.textContent = 'Save dispatch plan';
        }
      },
    });
    $('#dResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Saved plans
  function renderPlans() {
    $('#dPlans').innerHTML = plans.length
      ? `<table><thead><tr><th>Date</th><th>Plan</th><th>Vehicles</th><th>Distributors</th><th>Cases</th><th>Km</th><th>Status</th><th></th></tr></thead><tbody>
        ${plans.map((p) => `<tr><td>${esc(fmtPlanDate(p.plan_date))}</td><td>${esc(p.plan_no)}</td><td>${esc(p.vehicle_count)}</td><td>${esc(p.stop_count)}</td><td>${esc(fmtLoad(p.total_cases))}</td><td>${esc(Math.round(p.total_km))}</td>
          <td><span class="badge ${p.status === 'completed' ? 'delivered' : p.status === 'cancelled' ? 'cancelled' : p.status === 'dispatched' ? 'dispatched' : 'submitted'}">${esc(p.status)}</span></td>
          <td><button class="btn small secondary" data-open="${p.id}">Open</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No dispatch plans saved yet.</p>';
  }
  renderPlans();

  async function openPlan(id) {
    const p = await api(`/dispatch/plans/${id}`);
    const depot = { lat: Number(p.origin_lat), lng: Number(p.origin_lng), label: p.origin_label };
    const departMinutes = RE.timeToMinutes(String(p.depart_time).slice(0, 5));
    const vehicles = p.vehicles.map((v) => {
      const seq = v.stops.map((s) => ({
        distributor_id: s.distributor_id, title: s.distributor_name, area: s.location_label || '', phone: s.distributor_mobile,
        lat: Number(s.gps_lat), lng: Number(s.gps_lng), load: Number(s.cases), loadText: `${fmtLoad(s.cases)} cases`,
      }));
      const sch = RE.schedule(depot, seq, { returnToDepot: !!p.return_to_origin, departMinutes, speedKmph: p.avg_speed_kmph, unloadMinutes: p.unload_minutes });
      sch.info = { vehicle_reg: v.vehicle_reg || '', driver_name: v.driver_name || '', driver_mobile: v.driver_mobile || '' };
      sch.vehicle_no = v.vehicle_no;
      return sch;
    });
    const view = {
      kind: 'dispatch', unit: 'cases', depot, departMinutes, returnToDepot: !!p.return_to_origin, dateISO: String(p.plan_date).slice(0, 10),
      vehicles, saved: { id: p.id, plan_no: p.plan_no, status: p.status }, active: 0,
    };
    const box = $('#dResult');
    renderRouteResult(box, view, {
      showDriverFields: true,
      onStatus: async (status) => {
        try { await api(`/dispatch/plans/${p.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); view.saved.status = status; const row = plans.find((x) => x.id === p.id); if (row) row.status = status; renderPlans(); flashToast('Status updated'); } catch (err) { alert(err.message); }
      },
      onSaveDriver: async () => {
        try {
          await api(`/dispatch/plans/${p.id}`, { method: 'PATCH', body: JSON.stringify({ vehicles: view.vehicles.map((v) => ({ vehicle_no: v.vehicle_no, ...v.info })) }) });
          flashToast('Vehicle & driver details saved');
        } catch (err) { alert(err.message); }
      },
      onDelete: canDelete ? async () => {
        if (!confirm(`Delete dispatch plan ${p.plan_no}?`)) return;
        try { await api(`/dispatch/plans/${p.id}`, { method: 'DELETE' }); state.dispatchOpenPlan = null; refreshMain(); } catch (err) { alert(err.message); }
      } : null,
      onClose: () => { if (box._map) { box._map.remove(); box._map = null; } box.innerHTML = ''; state.dispatchOpenPlan = null; },
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#dPlans').addEventListener('click', (e) => {
    const id = e.target.dataset.open;
    if (id) { state.dispatchOpenPlan = Number(id); openPlan(id).catch((err) => alert(err.message)); }
  });
  if (state.dispatchOpenPlan) setTimeout(() => openPlan(state.dispatchOpenPlan).catch(() => { state.dispatchOpenPlan = null; }), 0);

  return wrap;
}

// ================= Distributor → Retailer: Delivery Route =================
async function renderDeliveryRoute() {
  const data = await api('/dispatch/delivery-stops');
  const isDistributor = state.user.role === 'distributor';
  if (!state.deliveryRoute) state.deliveryRoute = { scope: 'all', vehicles: 1, depart: '09:00', speed: 25, unload: 10, ret: true };
  const R = state.deliveryRoute;
  const origin = data.origin;
  const hasOrigin = origin.gps_lat != null && origin.gps_lng != null;

  const wrap = el(`<div>
    <div class="card">
      <p class="section-title">Delivery Route</p>
      <p class="muted" style="margin-top:-4px">Best order to deliver today's open orders, grouped by retailer, starting from ${esc(origin.name)}.</p>
      ${hasOrigin
        ? `<p style="margin:0 0 10px;font-size:13px">Start: <b>${esc(origin.label)}</b> ${isDistributor ? '<button class="btn small secondary" id="rOrigin" style="margin-left:6px">Change</button>' : ''}</p>`
        : `<div class="dsp-warn">${isDistributor ? 'Set your warehouse / godown location once to plan delivery routes. <button class="btn small" id="rOrigin" style="margin-left:6px">Set location</button>' : 'Your distributor has not set their warehouse location yet — ask them to set it from their Delivery Route screen.'}</div>`}
      <div class="grid cols-4">
        <div class="field"><label>Orders to include</label><select id="rScope">
          <option value="all" ${R.scope === 'all' ? 'selected' : ''}>All open (accepted → dispatched)</option>
          <option value="ready" ${R.scope === 'ready' ? 'selected' : ''}>Ready for dispatch &amp; dispatched only</option></select></div>
        <div class="field"><label>Vehicles</label><select id="rVehicles">${[1, 2, 3, 4].map((n) => `<option ${n === Number(R.vehicles) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label>Departure time</label><input type="time" id="rDepart" value="${esc(R.depart)}" /></div>
        <div class="field"><label>Avg speed (km/h) · stop time (min)</label><div style="display:flex;gap:6px"><input type="number" id="rSpeed" value="${esc(R.speed)}" min="5" /><input type="number" id="rUnload" value="${esc(R.unload)}" min="0" /></div></div>
      </div>
      <label style="display:flex;align-items:center;gap:6px;color:var(--ink);font-size:13px"><input type="checkbox" id="rRet" style="width:auto" ${R.ret ? 'checked' : ''}/> Return to start</label>
      <p class="muted" id="rSummary" style="margin-top:8px"></p>
      <button class="btn" id="rPlan" style="width:100%;padding:11px" ${hasOrigin ? '' : 'disabled'}>Plan delivery route</button>
    </div>
    <div id="rResult"></div>
  </div>`);
  const $ = (s) => wrap.querySelector(s);

  function currentStops() {
    const ready = ['ready_for_dispatch', 'dispatched'];
    return data.stops
      .map((s) => (R.scope === 'ready' ? { ...s, orders: s.orders.filter((o) => ready.includes(o.status)) } : s))
      .filter((s) => s.orders.length);
  }
  function summary() {
    const st = currentStops();
    const noGps = st.filter((s) => !s.gps_lat || !s.gps_lng);
    $('#rSummary').innerHTML = st.length
      ? `${st.length} retailer${st.length > 1 ? 's' : ''} · ${st.reduce((a, s) => a + s.orders.length, 0)} orders${noGps.length ? ` · <span style="color:var(--warn)">${noGps.length} without a GPS pin (left out): ${noGps.map((s) => esc(s.retailer_name)).join(', ')}</span>` : ''}`
      : 'No open orders to deliver right now.';
  }
  summary();

  const bind = (id, key, fn) => { $(id).onchange = () => { R[key] = fn ? fn($(id)) : $(id).value; summary(); }; };
  bind('#rScope', 'scope'); bind('#rVehicles', 'vehicles'); bind('#rDepart', 'depart');
  bind('#rSpeed', 'speed'); bind('#rUnload', 'unload'); bind('#rRet', 'ret', (x) => x.checked);

  const originBtn = wrap.querySelector('#rOrigin');
  if (originBtn) {
    originBtn.onclick = async () => {
      const picked = await pickLocation({
        title: 'Your warehouse / godown location',
        initial: hasOrigin ? { lat: origin.gps_lat, lng: origin.gps_lng, label: origin.label } : { label: '' },
        query: '',
      });
      if (!picked) return;
      try {
        await api(`/dispatch/distributors/${origin.id}/location`, { method: 'PATCH', body: JSON.stringify({ gps_lat: picked.lat, gps_lng: picked.lng, location_label: picked.label }) });
        flashToast('Location saved'); refreshMain();
      } catch (err) { alert(err.message); }
    };
  }

  $('#rPlan').onclick = () => {
    const st = currentStops().filter((s) => s.gps_lat && s.gps_lng);
    if (!st.length) { alert('No orders with a retailer GPS pin to plan.'); return; }
    const depot = { lat: Number(origin.gps_lat), lng: Number(origin.gps_lng), label: origin.label };
    const stops = st.map((s) => {
      const load = Math.round(s.carton_equiv * 10) / 10;
      const parts = [];
      if (s.cartons) parts.push(`${s.cartons} ctn`);
      if (s.loose_packs) parts.push(`${s.loose_packs} pcs`);
      return {
        retailer_id: s.retailer_id, title: s.retailer_name, phone: s.retailer_mobile,
        area: `${s.orders.map((o) => o.order_no).join(', ')}${s.retailer_address ? ' · ' + s.retailer_address : ''}`,
        lat: Number(s.gps_lat), lng: Number(s.gps_lng), load, loadText: parts.join(' + ') || '—',
      };
    });
    const departMinutes = RE.timeToMinutes(R.depart);
    const vehicles = RE.plan(depot, stops, { vehicles: Number(R.vehicles), returnToDepot: R.ret, departMinutes, speedKmph: R.speed, unloadMinutes: R.unload });
    renderRouteResult($('#rResult'), {
      kind: 'delivery', unit: 'cartons', depot, departMinutes, returnToDepot: R.ret, dateISO: localISO(new Date()),
      vehicles, saved: null, active: 0,
    }, {});
    $('#rResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return wrap;
}
