// Distributor (primary) orders screen — stock a distributor buys from MIJO.
//  ASM / SO: place orders for distributors in their area, see their area's orders, cancel own unapproved ones
//  RM: see their area's orders
//  Admin roles: place for any distributor, approve / reject / cancel, mark delivered
//  Distributor login: see its own stock orders
// Loaded before app.js; uses its globals (api, el, esc, fmtMoney, state, LEVEL_LABELS) at call time only.

const DO_STATUS_LABEL = {
  submitted: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected', dispatch_planned: 'Dispatch planned',
  dispatched: 'Dispatched', delivered: 'Delivered', cancelled: 'Cancelled',
};
const DO_BADGE = {
  submitted: 'submitted', approved: 'accepted', rejected: 'cancelled', dispatch_planned: 'packing',
  dispatched: 'dispatched', delivered: 'delivered', cancelled: 'cancelled',
};
const doFmtQty = (n) => { const v = Math.round(Number(n || 0) * 10) / 10; return Number.isInteger(v) ? String(v) : v.toFixed(1); };

async function renderDistributorOrders() {
  const u = state.user;
  const isAdminUser = ['super_admin', 'management', 'sales_manager'].includes(u.role);
  const canBook = isAdminUser || (u.role === 'field_employee' && ['ASM', 'SO'].includes(u.level));
  const [distributors, products] = canBook
    ? await Promise.all([api('/distributor-orders/distributors'), api('/products?active=1')])
    : [[], []];

  const wrap = el(`<div>
    ${canBook ? `<div class="card">
      <p class="section-title">New Distributor Order</p>
      <p class="muted" style="margin-top:-4px">Stock the distributor is buying from MIJO, at distributor price. ${isAdminUser ? '' : 'It goes to the head office for approval, then onto a dispatch plan.'}</p>
      ${distributors.length ? `
      <div class="grid cols-2">
        <div class="field"><label>Distributor *</label><select id="doDist"><option value="">-- select --</option>
          ${distributors.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (${esc(d.code)})${d.territory_name ? ' — ' + esc(d.territory_name) : ''}</option>`).join('')}</select></div>
        <div class="field"><label>Search products</label><input id="doFilter" placeholder="Name or SKU" /></div>
      </div>
      <div style="overflow-x:auto"><table class="do-grid"><thead><tr><th>Product</th><th>Packs / carton</th><th>Price / pack</th><th>Price / carton</th><th style="width:90px">Cartons</th><th style="width:90px">Loose packs</th><th>Amount</th></tr></thead>
        <tbody id="doLines">${products.map((p) => `<tr data-pid="${esc(p.id)}" data-rate="${esc(p.distributor_price)}" data-upc="${esc(p.units_per_carton || 1)}" data-search="${esc(`${p.name} ${p.sku_code}`.toLowerCase())}">
          <td style="white-space:normal"><b>${esc(p.name)}</b><br/><span class="muted" style="font-size:11px">${esc(p.sku_code)}${p.pack_size ? ' · ' + esc(p.pack_size) : ''}</span></td>
          <td class="hide-m">${esc(p.units_per_carton || 1)}</td><td data-l="Price / pack">${fmtMoney(p.distributor_price)}</td><td data-l="Price / carton (${esc(p.units_per_carton || 1)} packs)">${fmtMoney(Number(p.distributor_price) * (Number(p.units_per_carton) || 1))}</td>
          <td data-l="Cartons"><input type="number" min="0" step="1" inputmode="numeric" class="doC" placeholder="0" /></td>
          <td data-l="Loose packs"><input type="number" min="0" step="1" inputmode="numeric" class="doP" placeholder="0" /></td>
          <td data-l="Amount" class="doAmt">—</td></tr>`).join('')}</tbody></table></div>
      ${!products.length ? '<p class="muted">No active products yet.</p>' : ''}
      <div class="field" style="margin-top:10px"><label>Notes (optional)</label><input id="doNotes" maxlength="250" placeholder="e.g. urgent for festival stock" /></div>
      <div class="total-row">Total: <span id="doTotCartons">0</span> cartons · <span id="doTotAmt">₹0.00</span></div>
      <button class="btn" id="doSubmit" style="margin-top:8px">Place order</button>
      <div class="error-msg" id="doErr"></div>` : `<p class="muted">${isAdminUser ? 'No active distributors.' : 'No distributors in your area yet — ask your admin to set your area in Masters → Field Employees.'}</p>`}
    </div>` : ''}

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <p class="section-title" style="margin:0">${u.role === 'distributor' ? 'My Stock Orders' : 'Distributor Orders'}</p>
        <select id="doStatusFilter" style="width:auto">
          <option value="">All statuses</option>
          ${Object.entries(DO_STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${isAdminUser && k === 'submitted' ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div id="doList"></div>
    </div>
  </div>`);
  const $ = (q) => wrap.querySelector(q);

  // ----- order form
  function recalc() {
    let cartons = 0, amount = 0;
    wrap.querySelectorAll('#doLines tr').forEach((tr) => {
      const upc = Number(tr.dataset.upc) || 1, rate = Number(tr.dataset.rate);
      const c = Math.max(0, Math.floor(Number(tr.querySelector('.doC').value) || 0));
      const p = Math.max(0, Math.floor(Number(tr.querySelector('.doP').value) || 0));
      const qty = c * upc + p;
      tr.querySelector('.doAmt').textContent = qty ? fmtMoney(qty * rate) : '—';
      cartons += qty / upc; amount += qty * rate;
    });
    $('#doTotCartons').textContent = doFmtQty(cartons);
    $('#doTotAmt').textContent = fmtMoney(amount);
  }
  if (canBook && distributors.length) {
    $('#doLines').addEventListener('input', recalc);
    $('#doFilter').oninput = () => {
      const q = $('#doFilter').value.trim().toLowerCase();
      wrap.querySelectorAll('#doLines tr').forEach((tr) => {
        const hasQty = tr.querySelector('.doC').value || tr.querySelector('.doP').value;
        tr.style.display = !q || tr.dataset.search.includes(q) || hasQty ? '' : 'none';
      });
    };
    $('#doSubmit').onclick = async () => {
      const err = $('#doErr');
      err.textContent = '';
      const lines = [...wrap.querySelectorAll('#doLines tr')].map((tr) => ({
        product_id: Number(tr.dataset.pid),
        carton_qty: Math.max(0, Math.floor(Number(tr.querySelector('.doC').value) || 0)),
        pack_qty: Math.max(0, Math.floor(Number(tr.querySelector('.doP').value) || 0)),
      })).filter((l) => l.carton_qty || l.pack_qty);
      if (!$('#doDist').value) { err.textContent = 'Select a distributor.'; return; }
      if (!lines.length) { err.textContent = 'Enter cartons or packs for at least one product.'; return; }
      const btn = $('#doSubmit');
      btn.disabled = true; btn.textContent = 'Placing...';
      try {
        const r = await api('/distributor-orders', { method: 'POST', body: JSON.stringify({ distributor_id: Number($('#doDist').value), lines, notes: $('#doNotes').value }) });
        alert(`Order ${r.order_no} placed — ${doFmtQty(r.total_cartons)} cartons, ${fmtMoney(r.total_amount)}.`);
        wrap.querySelectorAll('#doLines input').forEach((i) => { i.value = ''; });
        $('#doNotes').value = '';
        recalc(); loadList();
      } catch (e) { err.textContent = e.message; }
      btn.disabled = false; btn.textContent = 'Place order';
    };
  }

  // ----- list
  async function loadList() {
    const st = $('#doStatusFilter').value;
    const rows = await api(`/distributor-orders${st ? `?status=${encodeURIComponent(st)}` : ''}`);
    const box = $('#doList');
    if (!rows.length) { box.innerHTML = '<p class="muted">No orders.</p>'; return; }
    box.innerHTML = `<div style="overflow-x:auto"><table><thead><tr><th>Order</th><th>Date</th>${u.role === 'distributor' ? '' : '<th>Distributor</th>'}<th>Booked by</th><th>Cartons</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((o) => {
        const actions = [];
        actions.push('<button class="btn small secondary" data-act="view">View</button>');
        if (isAdminUser && o.status === 'submitted') actions.push('<button class="btn small" data-act="approved">Approve</button>', '<button class="btn small secondary" data-act="rejected">Reject</button>');
        if ((isAdminUser && ['submitted', 'approved'].includes(o.status)) || (!isAdminUser && o.status === 'submitted' && o.booked_by_user === u.id)) actions.push('<button class="btn small secondary" data-act="cancelled">Cancel</button>');
        if (isAdminUser && ['dispatch_planned', 'dispatched'].includes(o.status)) actions.push('<button class="btn small secondary" data-act="delivered">Mark delivered</button>');
        return `<tr data-id="${esc(o.id)}" data-no="${esc(o.order_no)}">
          <td>${esc(o.order_no)}</td><td>${esc(o.order_date)}</td>
          ${u.role === 'distributor' ? '' : `<td style="white-space:normal"><b>${esc(o.distributor_name)}</b>${o.territory_name ? `<br/><span class="muted" style="font-size:11px">${esc(o.territory_name)}</span>` : ''}</td>`}
          <td style="white-space:normal">${esc(o.booked_by_name || '—')}${o.booked_by_designation ? `<br/><span class="muted" style="font-size:11px">${esc(o.booked_by_designation)}</span>` : ''}</td>
          <td>${doFmtQty(o.total_cartons)}</td><td>${fmtMoney(o.total_amount)}</td>
          <td><span class="badge ${DO_BADGE[o.status] || ''}">${esc(DO_STATUS_LABEL[o.status] || o.status)}</span>${o.dispatch_plan_no ? `<br/><span class="muted" style="font-size:11px">${esc(o.dispatch_plan_no)}</span>` : ''}${o.review_note ? `<br/><span class="muted" style="font-size:11px">Note: ${esc(o.review_note)}</span>` : ''}</td>
          <td style="white-space:nowrap">${actions.join(' ')}</td></tr>
          <tr class="doDetail" data-for="${esc(o.id)}" style="display:none"><td colspan="8"></td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
  $('#doStatusFilter').onchange = loadList;
  $('#doList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    const act = btn.dataset.act;
    if (act === 'view') {
      const det = wrap.querySelector(`.doDetail[data-for="${id}"]`);
      if (det.style.display !== 'none') { det.style.display = 'none'; return; }
      const o = await api(`/distributor-orders/${id}`);
      det.querySelector('td').innerHTML = `<table style="background:#f9fafb"><thead><tr><th>Product</th><th>Cartons</th><th>Loose packs</th><th>Total packs</th><th>Rate / pack</th><th>Amount</th></tr></thead><tbody>
        ${o.lines.map((l) => `<tr><td>${esc(l.product_name)} <span class="muted">(${esc(l.sku_code)})</span></td><td>${esc(l.carton_qty)}</td><td>${esc(l.pack_qty)}</td><td>${esc(l.qty)}</td><td>${fmtMoney(l.rate)}</td><td>${fmtMoney(l.net_amount)}</td></tr>`).join('')}
        </tbody></table>${o.notes ? `<p class="muted" style="margin:6px 0 0">Notes: ${esc(o.notes)}</p>` : ''}`;
      det.style.display = '';
      return;
    }
    let note = null;
    if (act === 'rejected') {
      note = prompt(`Reason for rejecting ${tr.dataset.no}?`);
      if (note === null) return;
    } else if (act === 'cancelled') {
      if (!confirm(`Cancel order ${tr.dataset.no}?`)) return;
    }
    try {
      await api(`/distributor-orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: act, note }) });
      loadList();
    } catch (err) { alert(err.message); }
  });
  await loadList();
  return wrap;
}
