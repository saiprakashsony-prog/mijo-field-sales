// Production & Stock, Expenses and P&L screens (admin).
// Loaded before app.js; uses its globals (api, el, esc, fmtMoney, state, chartRegistry) at call time only.

const fmtN = (n, d = 0) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: d });
const fmtPct = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);
const canEditFinance = () => ['super_admin', 'management'].includes(state.user.role);
function ymOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function ymLabel(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); }
function ymAdd(ym, n) { const [y, m] = ym.split('-').map(Number); return ymOf(new Date(y, m - 1 + n, 1)); }

// ================= Production & Stock =================
async function renderProductionStock() {
  const [status, mmsProducts, products, stock, batches, adjustments] = await Promise.all([
    api('/production/status'), api('/production/mms-products'), api('/products'),
    api('/production/stock'), api('/production/batches'), api('/production/adjustments'),
  ]);
  const edit = canEditFinance();
  const ls = status.last_sync;
  const wrap = el(`<div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
        <div><p class="section-title" style="margin-bottom:4px">Production link (MMS)</p>
          ${!status.configured ? '<div class="dsp-warn">Not connected yet. Set <b>MMS_URL</b> and <b>INTEGRATION_KEY</b> on the DMS (and the same <b>INTEGRATION_KEY</b> plus <b>DMS_SYNC_URL</b> on the MMS) in Railway.</div>'
            : `<span class="muted">${ls ? (ls.ok ? `Last sync ${esc(new Date(ls.at).toLocaleString('en-IN'))} — ${esc(ls.products)} products, ${esc(ls.batches)} batches` : `<span style="color:var(--bad)">Last sync failed: ${esc(ls.error)}</span>`) : 'Not synced yet'}</span>`}
        </div>
        ${status.configured && edit ? '<button class="btn small" id="psSync">Sync now</button>' : ''}
      </div>
    </div>

    <div class="card">
      <p class="section-title">Link MMS products to SKUs</p>
      <p class="muted" style="margin-top:-4px">Do this once per product. Production of an unlinked product is not counted in stock or cost.
        "Packs per unit" converts the MMS quantity into packs — leave it blank to use the pack size set in the MMS.</p>
      ${mmsProducts.length ? `<div style="overflow-x:auto"><table><thead><tr><th>MMS product</th><th>Made in</th><th>MMS pack size</th><th>Batches</th><th>DMS SKU</th><th style="width:120px">Packs per unit</th>${edit ? '<th></th>' : ''}</tr></thead><tbody>
        ${mmsProducts.map((m) => `<tr data-id="${esc(m.mms_product_id)}">
          <td><b>${esc(m.name)}</b></td><td>${esc(m.output_unit || '—')}</td>
          <td>${m.pack_size ? `${esc(fmtN(m.pack_size, 4))} ${esc(m.output_unit || '')} <span class="muted">(= ${esc(fmtN(1 / m.pack_size, 2))} packs / ${esc(m.output_unit || 'unit')})</span>` : '<span class="muted">not set — 1 unit = 1 pack</span>'}</td>
          <td>${esc(m.batch_count)}</td>
          <td><select class="psSku" ${edit ? '' : 'disabled'}><option value="">-- not linked --</option>${products.map((p) => `<option value="${esc(p.id)}" ${p.id === m.product_id ? 'selected' : ''}>${esc(p.name)} (${esc(p.sku_code)})</option>`).join('')}</select></td>
          <td><input class="psPpu" type="number" min="0" step="any" value="${m.packs_per_unit == null ? '' : esc(Number(m.packs_per_unit))}" placeholder="${m.pack_size ? esc(fmtN(1 / m.pack_size, 2)) : '1'}" ${edit ? '' : 'disabled'} /></td>
          ${edit ? '<td><button class="btn small secondary psSave">Save</button></td>' : ''}
        </tr>`).join('')}</tbody></table></div>`
        : `<p class="muted">${status.configured ? 'No products received from the MMS yet — press Sync now.' : 'Connect the MMS first.'}</p>`}
    </div>

    <div class="card">
      <p class="section-title">Finished-goods stock</p>
      <p class="muted" style="margin-top:-4px">In stock = produced − dispatched ± adjustments. Free = in stock − already approved/planned orders. Approving an order that needs more than the free stock asks for confirmation.</p>
      <div style="overflow-x:auto"><table><thead><tr><th>SKU</th><th>Produced</th><th>Dispatched</th><th>Adjusted</th><th>In stock</th><th>Reserved</th><th>Free</th><th>Avg cost / pack</th><th>Stock value</th></tr></thead><tbody>
        ${stock.filter((s) => s.linked || s.produced || s.dispatched || s.adjusted || s.reserved).map((s) => {
          const upc = Number(s.units_per_carton) || 1;
          const ctn = (n) => `<span class="muted" style="font-size:11px"><br/>${fmtN(n / upc, 1)} ctn</span>`;
          return `<tr><td style="white-space:normal"><b>${esc(s.name)}</b><br/><span class="muted" style="font-size:11px">${esc(s.sku_code)}${s.linked ? '' : ' · not linked to MMS'}</span></td>
            <td>${fmtN(s.produced)}</td><td>${fmtN(s.dispatched)}</td><td>${fmtN(s.adjusted)}</td>
            <td><b>${fmtN(s.in_stock)}</b>${ctn(s.in_stock)}</td><td>${fmtN(s.reserved)}</td>
            <td style="color:${s.free < 0 ? 'var(--bad)' : 'inherit'}"><b>${fmtN(s.free)}</b>${ctn(s.free)}</td>
            <td>${s.avg_cost_per_pack == null ? '—' : fmtMoney(s.avg_cost_per_pack)}</td>
            <td>${s.avg_cost_per_pack == null ? '—' : fmtMoney(Math.max(0, s.in_stock) * s.avg_cost_per_pack)}</td></tr>`;
        }).join('') || '<tr><td colspan="9" class="muted">No stock movements yet.</td></tr>'}
      </tbody></table></div>
    </div>

    ${edit ? `<div class="card">
      <p class="section-title">Stock adjustment</p>
      <p class="muted" style="margin-top:-4px">Use <b>Opening stock</b> once for goods already in the godown before the MMS link, and the others for damage, samples or count corrections.</p>
      <div class="grid cols-4">
        <div class="field"><label>SKU</label><select id="adjSku"><option value="">-- select --</option>${products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.sku_code)})</option>`).join('')}</select></div>
        <div class="field"><label>Packs (+ add, − remove)</label><input id="adjPacks" type="number" step="1" placeholder="e.g. 500 or -24" /></div>
        <div class="field"><label>Date</label><input id="adjDate" type="date" value="${esc(localISO(new Date()))}" /></div>
        <div class="field"><label>Reason</label><select id="adjReason"><option value="opening_stock">Opening stock</option><option value="damage">Damage / expiry</option><option value="samples">Samples / free goods</option><option value="correction">Count correction</option><option value="other">Other</option></select></div>
      </div>
      <div class="field"><label>Notes</label><input id="adjNotes" maxlength="250" /></div>
      <button class="btn small" id="adjSave">Save adjustment</button><div class="error-msg" id="adjErr"></div>
      ${adjustments.length ? `<table style="margin-top:10px"><thead><tr><th>Date</th><th>SKU</th><th>Packs</th><th>Reason</th><th>Notes</th><th>By</th><th></th></tr></thead><tbody>
        ${adjustments.map((a) => `<tr data-id="${esc(a.id)}"><td>${esc(a.adj_date)}</td><td>${esc(a.product_name)}</td><td>${a.packs > 0 ? '+' : ''}${esc(a.packs)}</td><td>${esc(a.reason.replace('_', ' '))}</td><td style="white-space:normal">${esc(a.notes || '')}</td><td>${esc(a.created_by_name || '')}</td><td><button class="btn small secondary adjDel">Delete</button></td></tr>`).join('')}
      </tbody></table>` : ''}
    </div>` : ''}

    <div class="card">
      <p class="section-title">Recent production (from MMS)</p>
      ${batches.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>MMS product</th><th>SKU</th><th>Quantity</th><th>Packs</th><th>Batch cost</th><th>Cost / pack</th></tr></thead><tbody>
        ${batches.map((b) => `<tr><td>${esc(b.batch_date)}</td><td>${esc(b.mms_product_name || '—')}</td><td>${b.sku_code ? esc(b.product_name) : '<span style="color:var(--warn)">not linked</span>'}</td>
          <td>${esc(fmtN(b.actual_qty, 3))} ${esc(b.unit || '')}</td><td>${fmtN(b.packs)}</td><td>${fmtMoney(b.total_cost)}</td><td>${b.cost_per_pack == null ? '—' : fmtMoney(b.cost_per_pack)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No production received yet.</p>'}
    </div>
  </div>`);
  const $ = (q) => wrap.querySelector(q);

  const syncBtn = wrap.querySelector('#psSync');
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.disabled = true; syncBtn.textContent = 'Syncing...';
    try { const r = await api('/production/sync', { method: 'POST' }); flashToast(`Synced ${r.batches} batches`); refreshMain(); }
    catch (e) { alert(e.message); syncBtn.disabled = false; syncBtn.textContent = 'Sync now'; }
  };
  wrap.querySelectorAll('.psSave').forEach((btn) => {
    btn.onclick = async () => {
      const tr = btn.closest('tr');
      try {
        await api(`/production/mms-products/${encodeURIComponent(tr.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ product_id: tr.querySelector('.psSku').value || null, packs_per_unit: tr.querySelector('.psPpu').value }) });
        flashToast('Link saved'); refreshMain();
      } catch (e) { alert(e.message); }
    };
  });
  const adjSave = wrap.querySelector('#adjSave');
  if (adjSave) adjSave.onclick = async () => {
    $('#adjErr').textContent = '';
    try {
      await api('/production/adjustments', { method: 'POST', body: JSON.stringify({ product_id: $('#adjSku').value, packs: $('#adjPacks').value, adj_date: $('#adjDate').value, reason: $('#adjReason').value, notes: $('#adjNotes').value }) });
      flashToast('Adjustment saved'); refreshMain();
    } catch (e) { $('#adjErr').textContent = e.message; }
  };
  wrap.querySelectorAll('.adjDel').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this adjustment?')) return;
      await api(`/production/adjustments/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
      refreshMain();
    };
  });
  return wrap;
}

// ================= Monthly expenses =================
async function renderExpenses() {
  if (!state.expMonth) state.expMonth = ymOf(new Date());
  const data = await api(`/finance/expenses?month=${state.expMonth}`);
  const amounts = Object.fromEntries(data.items.map((i) => [i.category, i]));
  const cats = [...new Set([...data.categories, ...data.items.map((i) => i.category)])];

  const wrap = el(`<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
      <p class="section-title" style="margin:0">Monthly expenses</p>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn small secondary" id="exPrev">‹</button><input type="month" id="exMonth" value="${esc(state.expMonth)}" style="width:auto" /><button class="btn small secondary" id="exNext">›</button>
      </div>
    </div>
    <p class="muted" style="margin-top:0">Operating costs not in production cost (production raw material, packing and batch costs come from the MMS). Leave a line blank if it doesn't apply.</p>
    <table><thead><tr><th>Category</th><th style="width:170px">Amount (₹)</th><th>Notes</th></tr></thead><tbody id="exRows">
      ${cats.map((c) => `<tr><td><input class="exCat" value="${esc(c)}" /></td><td><input class="exAmt" type="number" min="0" step="any" value="${amounts[c] ? esc(amounts[c].amount) : ''}" placeholder="0" /></td><td><input class="exNote" value="${esc(amounts[c] && amounts[c].notes || '')}" maxlength="250" /></td></tr>`).join('')}
    </tbody></table>
    <button class="btn small secondary" id="exAdd" style="margin-top:6px">+ Add category</button>
    <div class="total-row">Total: <span id="exTotal">₹0</span></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="exSave">Save ${esc(ymLabel(state.expMonth))}</button>
      <button class="btn secondary" id="exCopy">Copy amounts from ${esc(ymLabel(ymAdd(state.expMonth, -1)))}</button>
    </div>
    <div class="error-msg" id="exErr"></div>
  </div>`);
  const $ = (q) => wrap.querySelector(q);
  const total = () => { $('#exTotal').textContent = fmtMoney([...wrap.querySelectorAll('.exAmt')].reduce((a, i) => a + (Number(i.value) || 0), 0)); };
  total();
  $('#exRows').addEventListener('input', total);
  const go = (m) => { state.expMonth = m; refreshMain(); };
  $('#exMonth').onchange = (e) => e.target.value && go(e.target.value);
  $('#exPrev').onclick = () => go(ymAdd(state.expMonth, -1));
  $('#exNext').onclick = () => go(ymAdd(state.expMonth, 1));
  $('#exAdd').onclick = () => {
    const tr = el('<table><tbody><tr><td><input class="exCat" placeholder="Category name" /></td><td><input class="exAmt" type="number" min="0" step="any" placeholder="0" /></td><td><input class="exNote" maxlength="250" /></td></tr></tbody></table>').querySelector('tr');
    $('#exRows').appendChild(tr); tr.querySelector('.exCat').focus();
  };
  $('#exCopy').onclick = async () => {
    const prev = await api(`/finance/expenses?month=${ymAdd(state.expMonth, -1)}`);
    if (!prev.items.length) { alert('Nothing was entered for the previous month.'); return; }
    const byCat = Object.fromEntries(prev.items.map((i) => [i.category, i.amount]));
    wrap.querySelectorAll('#exRows tr').forEach((tr) => {
      const c = tr.querySelector('.exCat').value.trim();
      if (byCat[c] != null) { tr.querySelector('.exAmt').value = byCat[c]; delete byCat[c]; }
    });
    Object.entries(byCat).forEach(([c, a]) => { $('#exAdd').click(); const tr = $('#exRows').lastElementChild; tr.querySelector('.exCat').value = c; tr.querySelector('.exAmt').value = a; });
    total(); flashToast('Copied — check and save');
  };
  $('#exSave').onclick = async () => {
    $('#exErr').textContent = '';
    const items = [...wrap.querySelectorAll('#exRows tr')].map((tr) => ({
      category: tr.querySelector('.exCat').value, amount: tr.querySelector('.exAmt').value || 0, notes: tr.querySelector('.exNote').value,
    })).filter((i) => i.category.trim());
    try {
      const r = await api(`/finance/expenses/${state.expMonth}`, { method: 'PUT', body: JSON.stringify({ items }) });
      flashToast(`Saved — ${fmtMoney(r.total)}`);
    } catch (e) { $('#exErr').textContent = e.message; }
  };
  return wrap;
}

// ================= P&L =================
async function renderPnl() {
  if (!state.pnlRange) { const now = ymOf(new Date()); state.pnlRange = { from: ymAdd(now, -5), to: now }; }
  const R = state.pnlRange;
  const d = await api(`/finance/pnl?from=${R.from}&to=${R.to}`);
  const t = d.totals;
  const w = d.warnings;
  const money = (n) => { const v = Math.round(n || 0); return v < 0 ? `−${fmtMoney(-v)}` : fmtMoney(v); };
  const neg = (n) => (n < 0 ? 'color:var(--bad)' : '');

  const lineRows = [
    ['Sales (incl. GST)', (m) => m.revenue_gross],
    ['Less: GST', (m) => -m.gst],
    ['Net revenue', (m) => m.revenue_net, true],
    ['Cost of goods sold', (m) => -m.cogs],
    ['Gross profit', (m) => m.gross_profit, true],
    ['Gross margin', (m) => m.gross_margin_pct, false, true],
    ...d.expense_categories.map((c) => [`  ${c}`, (m) => -(m.expenses[c] || 0)]),
    ['Total expenses', (m) => -m.expenses_total, true],
    ['Net profit', (m) => m.net_profit, true],
    ['Net margin', (m) => m.net_margin_pct, false, true],
  ];
  const cell = (v, pct) => (pct ? fmtPct(v) : `<span style="${neg(v)}">${money(v)}</span>`);
  const breakdown = (title, rows, label) => `<div class="card"><p class="section-title">${title}</p>
    ${rows.length ? `<div style="overflow-x:auto"><table><thead><tr><th>${label}</th><th>Packs</th><th>Net revenue</th><th>COGS</th><th>Gross profit</th><th>Margin</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td style="white-space:normal"><b>${esc(r.name)}</b>${r.sku_code ? `<br/><span class="muted" style="font-size:11px">${esc(r.sku_code)}</span>` : ''}${r.territory ? `<br/><span class="muted" style="font-size:11px">${esc(r.territory)}</span>` : ''}</td>
        <td>${fmtN(r.packs)}</td><td>${money(r.revenue_net)}</td><td>${money(r.cogs)}</td><td style="${neg(r.gross_profit)}">${money(r.gross_profit)}</td><td>${fmtPct(r.gross_margin_pct)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No dispatches in this period.</p>'}</div>`;

  const wrap = el(`<div>
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <p class="section-title" style="margin:0">Profit &amp; Loss</p>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <input type="month" id="plFrom" value="${esc(R.from)}" style="width:auto" /> to <input type="month" id="plTo" value="${esc(R.to)}" style="width:auto" />
        <select id="plQuick" style="width:auto"><option value="">Quick range</option><option value="1">This month</option><option value="3">Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last 12 months</option><option value="fy">This financial year</option></select>
      </div>
    </div>
    ${w.uncosted_skus.length || w.unlinked_mms_products || w.months_without_expenses.length ? `<div class="dsp-warn">
      ${w.uncosted_skus.length ? `<div>No production cost yet for: <b>${esc(w.uncosted_skus.join(', '))}</b> — their cost of goods is counted as ₹0. Link them in Production &amp; Stock.</div>` : ''}
      ${w.unlinked_mms_products ? `<div>${esc(w.unlinked_mms_products)} MMS product(s) not linked to a SKU — link them in Production &amp; Stock.</div>` : ''}
      ${w.months_without_expenses.length ? `<div>No expenses entered for ${esc(w.months_without_expenses.map(ymLabel).join(', '))} — net profit for those months is overstated.</div>` : ''}
    </div>` : ''}
    <div class="grid cols-4">
      <div class="card kpi"><div class="value">${money(t.revenue_net)}</div><div class="label">Net revenue</div></div>
      <div class="card kpi"><div class="value">${money(t.gross_profit)}</div><div class="label">Gross profit · ${fmtPct(t.gross_margin_pct)}</div></div>
      <div class="card kpi"><div class="value">${money(t.expenses_total)}</div><div class="label">Expenses</div></div>
      <div class="card kpi"><div class="value" style="${neg(t.net_profit)}">${money(t.net_profit)}</div><div class="label">Net profit · ${fmtPct(t.net_margin_pct)}</div></div>
    </div>
    <div class="card"><p class="section-title">Month by month</p><div style="height:280px"><canvas id="plChart"></canvas></div></div>
    <div class="card"><p class="section-title">P&amp;L statement</p>
      <div style="overflow-x:auto"><table><thead><tr><th></th>${d.months.map((m) => `<th style="text-align:right">${esc(ymLabel(m.month))}</th>`).join('')}<th style="text-align:right">Total</th></tr></thead><tbody>
        ${lineRows.map(([label, f, bold, pct]) => `<tr style="${bold ? 'font-weight:700;background:#f9fafb' : ''}"><td style="white-space:pre">${esc(label)}</td>
          ${d.months.map((m) => `<td style="text-align:right">${cell(f(m), pct)}</td>`).join('')}<td style="text-align:right">${cell(f(t), pct)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12px;margin-top:8px">Sales are distributor orders dispatched in the month (dispatch plan date), at distributor price. Cost of goods = packs dispatched × average production cost per pack from the MMS up to that month. Production in the period: ${fmtN(t.produced_packs)} packs at ${money(t.production_cost)}.</p>
    </div>
    ${breakdown('By SKU', d.by_sku, 'SKU')}
    ${breakdown('By distributor', d.by_distributor, 'Distributor')}
    ${breakdown('By territory', d.by_territory, 'Territory')}
  </div>`);
  const $ = (q) => wrap.querySelector(q);
  const set = (from, to) => { if (from && to && from <= to) { state.pnlRange = { from, to }; refreshMain(); } };
  $('#plFrom').onchange = () => set($('#plFrom').value, $('#plTo').value);
  $('#plTo').onchange = () => set($('#plFrom').value, $('#plTo').value);
  $('#plQuick').onchange = (e) => {
    const now = ymOf(new Date());
    if (e.target.value === 'fy') { const [y, m] = now.split('-').map(Number); set(`${m >= 4 ? y : y - 1}-04`, now); } else if (e.target.value) set(ymAdd(now, -(Number(e.target.value) - 1)), now);
  };
  setTimeout(() => {
    const c = wrap.querySelector('#plChart');
    if (!c || !window.Chart) return;
    if (chartRegistry.plChart) { chartRegistry.plChart.destroy(); delete chartRegistry.plChart; }
    chartRegistry.plChart = new Chart(c.getContext('2d'), {
      data: {
        labels: d.months.map((m) => ymLabel(m.month)),
        datasets: [
          { type: 'bar', label: 'Net revenue', data: d.months.map((m) => m.revenue_net), backgroundColor: '#1d4ed8', borderRadius: 4, maxBarThickness: 30 },
          { type: 'bar', label: 'Cost of goods', data: d.months.map((m) => m.cogs), backgroundColor: '#f57c34', borderRadius: 4, maxBarThickness: 30 },
          { type: 'bar', label: 'Expenses', data: d.months.map((m) => m.expenses_total), backgroundColor: '#9ca3af', borderRadius: 4, maxBarThickness: 30 },
          { type: 'line', label: 'Net profit', data: d.months.map((m) => m.net_profit), borderColor: '#1b8a5a', backgroundColor: '#1b8a5a', tension: 0.25 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(Math.round(ctx.raw))}` } } },
        scales: { y: { ticks: { callback: (v) => '₹' + Number(v).toLocaleString('en-IN') } } },
      },
    });
  }, 0);
  return wrap;
}
