// Distributor Sales dashboard (primary sales) — the stock MIJO sells and dispatches to distributors.
// Shown as the second view of the Dashboard tab (admin roles, and RM / ASM / SO for their area).

function ddLocalISO(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function ddRange(key) {
  const now = new Date();
  const to = ddLocalISO(now);
  const back = (n) => ddLocalISO(new Date(now.getTime() - n * 86400000));
  switch (key) {
    case 'today': return { from: to, to };
    case '7': return { from: back(6), to };
    case 'month': return { from: to.slice(0, 8) + '01', to };
    case 'lastmonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: ddLocalISO(first), to: ddLocalISO(last) };
    }
    case '90': return { from: back(89), to };
    default: return { from: back(29), to };
  }
}
const DD_RANGES = [['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['90', 'Last 90 days']];
const DD_STATUS = {
  submitted: 'Awaiting approval', approved: 'Approved', dispatch_planned: 'Dispatch planned',
  dispatched: 'Dispatched', delivered: 'Delivered', rejected: 'Rejected', cancelled: 'Cancelled',
};
const ddNum = (n) => (Math.round(Number(n || 0) * 10) / 10).toLocaleString('en-IN');

function ddDaysSince(iso, toISO) {
  if (!iso) return null;
  return Math.round((new Date(`${toISO}T00:00:00Z`) - new Date(`${iso}T00:00:00Z`)) / 86400000);
}

function ddTrendChart(canvasEl, labels, ordered, dispatched) {
  if (!canvasEl || !window.Chart) return;
  const id = canvasEl.id;
  if (chartRegistry[id]) { chartRegistry[id].destroy(); delete chartRegistry[id]; }
  if (!labels.length) return;
  chartRegistry[id] = new Chart(canvasEl.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Ordered', data: ordered, backgroundColor: '#d84315', borderRadius: 3, maxBarThickness: 22 },
        { label: 'Dispatched', data: dispatched, backgroundColor: '#1b8a5a', borderRadius: 3, maxBarThickness: 22 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.raw)}` } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => '₹' + Number(v).toLocaleString('en-IN') } } },
    },
  });
}

async function renderDistributorDashboard() {
  const key = state.ddRange || '30';
  const { from, to } = ddRange(key);
  const d = await api(`/dashboard/distributor?from=${from}&to=${to}`);

  const st = Object.fromEntries(d.byStatus.map((r) => [r.status, r]));
  const sumSt = (keys, k) => keys.reduce((a, x) => a + Number((st[x] || {})[k] || 0), 0);
  const LIVE = ['submitted', 'approved', 'dispatch_planned', 'dispatched', 'delivered'];
  const orderedCnt = sumSt(LIVE, 'cnt');
  const orderedVal = sumSt(LIVE, 'value');
  const orderedCartons = sumSt(LIVE, 'cartons');
  const pl = d.pipeline || {};
  const active = d.byDistributor.filter((r) => Number(r.order_count) > 0);
  const quiet = d.byDistributor.filter((r) => !Number(r.order_count));

  // one bar per day for ranges up to ~3 months
  const days = [];
  for (let t = new Date(`${from}T00:00:00Z`); t <= new Date(`${to}T00:00:00Z`); t = new Date(t.getTime() + 86400000)) days.push(t.toISOString().slice(0, 10));
  const oMap = Object.fromEntries(d.orderedDaily.map((r) => [r.d, Number(r.value)]));
  const xMap = Object.fromEntries(d.dispatchedDaily.map((r) => [r.d, Number(r.value)]));
  const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  const kpi = (value, label, sub) => `<div class="card kpi"><div class="value">${value}</div><div class="label">${label}</div>${sub ? `<div class="muted" style="font-size:12px;margin-top:2px">${sub}</div>` : ''}</div>`;

  const wrap = el(`<div>
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <p class="section-title" style="margin:0">Distributor Sales (Primary)</p>
        <p class="muted" style="margin:2px 0 0;font-size:12px">Stock sold to distributors · ${esc(from === to ? from : `${from} to ${to}`)}. Ordered goes by order date, dispatched by dispatch date.</p>
      </div>
      <select id="ddRange" style="width:auto">${DD_RANGES.map(([k, l]) => `<option value="${k}" ${k === key ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>

    <div class="grid cols-4">
      ${kpi(fmtMoney(orderedVal), 'Ordered', `${orderedCnt} order${orderedCnt === 1 ? '' : 's'} · ${ddNum(orderedCartons)} cartons`)}
      ${kpi(fmtMoney(d.dispatched.value), 'Dispatched', `${d.dispatched.cnt} order${Number(d.dispatched.cnt) === 1 ? '' : 's'} · ${ddNum(d.dispatched.cartons)} cartons`)}
      ${kpi(Number(pl.awaiting_approval || 0), 'Awaiting approval now', fmtMoney(pl.awaiting_value))}
      ${kpi(Number(pl.to_dispatch || 0), 'Approved, to dispatch now', `${ddNum(pl.to_dispatch_cartons)} cartons · ${fmtMoney(pl.to_dispatch_value)}`)}
    </div>
    <div class="grid cols-4">
      ${kpi(`${active.length} / ${d.byDistributor.length}`, 'Distributors ordering', 'active distributors with an order in this period')}
      ${kpi(active.length ? fmtMoney(orderedVal / Math.max(orderedCnt, 1)) : '₹0', 'Average order value', '')}
      ${kpi(fmtMoney(sumSt(['delivered'], 'value')), 'Delivered', `${sumSt(['delivered'], 'cnt')} orders`)}
      ${kpi(sumSt(['rejected', 'cancelled'], 'cnt'), 'Rejected / cancelled', fmtMoney(sumSt(['rejected', 'cancelled'], 'value')))}
    </div>

    ${days.length > 1 ? `<div class="card">
      <p class="section-title">Ordered vs Dispatched — daily value</p>
      <div class="chart-box" style="height:240px"><canvas id="ddTrend"></canvas></div>
    </div>` : ''}

    <div class="card">
      <p class="section-title">By Distributor</p>
      <div class="chart-box" style="height:${Math.max(160, Math.min(active.length, 15) * 26)}px"><canvas id="ddByDist"></canvas></div>
      ${active.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Distributor</th><th>Territory</th><th>Orders</th><th>Cartons</th><th>Ordered</th><th>Dispatched</th><th>Pending</th><th>Last order</th></tr></thead>
        <tbody>${active.map((r) => `<tr><td>${esc(r.name)} <span class="muted" style="font-size:11px">${esc(r.code)}</span></td><td>${esc(r.territory_name || '—')}</td>
          <td>${esc(r.order_count)}</td><td>${ddNum(r.cartons)}</td><td>${fmtMoney(r.order_value)}</td><td>${fmtMoney(r.dispatched_value)}</td>
          <td>${Number(r.pending_value) ? fmtMoney(r.pending_value) : '—'}</td><td>${esc(r.last_order_date || '—')}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">No distributor orders in this period.</p>'}
    </div>

    ${quiet.length ? `<div class="card">
      <p class="section-title">No orders in this period (${quiet.length})</p>
      <p class="muted" style="margin-top:-4px;font-size:12px">Active distributors who did not order in the selected period — oldest last order first.</p>
      <div style="overflow-x:auto"><table><thead><tr><th>Distributor</th><th>Territory</th><th>Last order</th><th>Days since</th></tr></thead>
      <tbody>${quiet.slice().sort((x, y) => String(x.last_order_date || '').localeCompare(String(y.last_order_date || ''))).map((r) => {
        const ds = ddDaysSince(r.last_order_date, to);
        return `<tr><td>${esc(r.name)} <span class="muted" style="font-size:11px">${esc(r.code)}</span></td><td>${esc(r.territory_name || '—')}</td>
          <td>${esc(r.last_order_date || 'Never ordered')}</td><td>${ds === null ? '—' : `<span style="color:${ds > 30 ? 'var(--warn)' : 'inherit'}">${ds}</span>`}</td></tr>`;
      }).join('')}</tbody></table></div>
    </div>` : ''}

    <div class="grid cols-2">
      <div class="card">
        <p class="section-title">Top SKUs</p>
        <div class="chart-box" style="height:200px"><canvas id="ddSkus"></canvas></div>
        ${d.topSkus.length ? `<table><thead><tr><th>SKU</th><th>Cartons</th><th>Value</th></tr></thead>
          <tbody>${d.topSkus.map((r) => `<tr><td>${esc(r.name)} (${esc(r.sku_code)})</td><td>${ddNum(r.cartons)}</td><td>${fmtMoney(r.value)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">No SKUs ordered in this period.</p>'}
      </div>
      <div class="card">
        <p class="section-title">Orders by Status</p>
        <div class="chart-box" style="height:200px"><canvas id="ddStatus"></canvas></div>
        ${d.byStatus.length ? `<table><thead><tr><th>Status</th><th>Orders</th><th>Cartons</th><th>Value</th></tr></thead>
          <tbody>${Object.keys(DD_STATUS).filter((k) => st[k]).map((k) => `<tr><td><span class="badge ${esc((typeof DO_BADGE !== 'undefined' && DO_BADGE[k]) || k)}">${esc(DD_STATUS[k])}</span></td><td>${esc(st[k].cnt)}</td><td>${ddNum(st[k].cartons)}</td><td>${fmtMoney(st[k].value)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">No orders in this period.</p>'}
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <p class="section-title">Booked by (ASM / SO / Admin)</p>
        ${d.byBooker.length ? `<table><thead><tr><th>Booked by</th><th>Orders</th><th>Cartons</th><th>Value</th></tr></thead>
          <tbody>${d.byBooker.map((r) => `<tr><td>${esc(r.name)}${r.designation ? ` <span class="muted" style="font-size:11px">${esc(r.designation)}</span>` : ''}</td><td>${esc(r.order_count)}</td><td>${ddNum(r.cartons)}</td><td>${fmtMoney(r.order_value)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">No orders in this period.</p>'}
      </div>
      <div class="card">
        <p class="section-title">By Territory</p>
        ${d.byTerritory.length ? `<table><thead><tr><th>Territory</th><th>Orders</th><th>Cartons</th><th>Value</th></tr></thead>
          <tbody>${d.byTerritory.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.order_count)}</td><td>${ddNum(r.cartons)}</td><td>${fmtMoney(r.order_value)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">No orders in this period.</p>'}
      </div>
    </div>
  </div>`);

  wrap.querySelector('#ddRange').onchange = (e) => { state.ddRange = e.target.value; render(); };

  // Chart.js needs the canvases attached to the page, which happens after this returns
  setTimeout(() => {
    if (days.length > 1) ddTrendChart(wrap.querySelector('#ddTrend'), days.map(dayLabel), days.map((x) => oMap[x] || 0), days.map((x) => xMap[x] || 0));
    const top = active.slice(0, 15);
    drawBarChart(wrap.querySelector('#ddByDist'), top.map((r) => r.name), top.map((r) => Number(r.order_value)), { label: 'Ordered value', tooltipFormatter: fmtMoney, colorful: true });
    drawBarChart(wrap.querySelector('#ddSkus'), d.topSkus.map((r) => r.name), d.topSkus.map((r) => Number(r.value)), { label: 'Value', tooltipFormatter: fmtMoney, color: '#1d4ed8' });
    const sk = Object.keys(DD_STATUS).filter((k) => st[k]);
    drawDoughnutChart(wrap.querySelector('#ddStatus'), sk.map((k) => DD_STATUS[k]), sk.map((k) => Number(st[k].cnt)));
  }, 0);

  return wrap;
}
