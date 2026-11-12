// Route engine shared by the Dispatch Planner (factory → distributors) and the Delivery Route
// (distributor → retailers). Pure functions, no DOM — exposed as window.RouteEngine.
//
// Distances are road ESTIMATES: straight-line (haversine) × ROAD_FACTOR. Good enough to decide
// stop order and vehicle split; drivers navigate with the Google Maps links for real roads.
(function () {
  const ROAD_FACTOR = 1.3;

  function haversineKm(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLa = (b.lat - a.lat) * toR, dLo = (b.lng - a.lng) * toR;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const roadKm = (a, b) => haversineKm(a, b) * ROAD_FACTOR;

  // Best visiting order from the depot. Exact for up to 8 stops, otherwise nearest-neighbour +
  // 2-opt + or-opt with random restarts. Returns indices into `stops`.
  function solveOrder(depot, stops, returnToDepot, thorough = true) {
    const n = stops.length;
    if (!n) return { seq: [], cost: 0 };
    const pts = [depot, ...stops];
    const M = pts.map((a) => pts.map((b) => roadKm(a, b)));
    const cost = (s) => {
      let c = M[0][s[0]];
      for (let i = 0; i < s.length - 1; i++) c += M[s[i]][s[i + 1]];
      if (returnToDepot) c += M[s[s.length - 1]][0];
      return c;
    };
    const base = [...Array(n)].map((_, i) => i + 1);

    if (n <= 8) { // Heap's algorithm over all permutations
      const a = base.slice(), c = new Array(n).fill(0);
      let best = a.slice(), bc = cost(a), i = 0;
      while (i < n) {
        if (c[i] < i) {
          const k = i % 2 ? c[i] : 0;
          [a[k], a[i]] = [a[i], a[k]];
          const v = cost(a);
          if (v < bc) { bc = v; best = a.slice(); }
          c[i]++; i = 0;
        } else { c[i] = 0; i++; }
      }
      return { seq: best.map((x) => x - 1), cost: bc };
    }

    const improve = (s) => {
      let bc = cost(s), improved = true;
      while (improved) {
        improved = false;
        for (let i = 0; i < n - 1; i++) {
          for (let j = i + 1; j < n; j++) {
            const t = s.slice(0, i).concat(s.slice(i, j + 1).reverse(), s.slice(j + 1));
            const v = cost(t);
            if (v < bc - 1e-9) { s = t; bc = v; improved = true; }
          }
        }
        for (let L = 1; L <= 3; L++) {
          for (let i = 0; i + L <= n; i++) {
            const seg = s.slice(i, i + L), rest = s.slice(0, i).concat(s.slice(i + L));
            for (let p = 0; p <= rest.length; p++) {
              if (p === i) continue;
              for (const sg of [seg, seg.slice().reverse()]) {
                const t = rest.slice(0, p).concat(sg, rest.slice(p));
                const v = cost(t);
                if (v < bc - 1e-9) { s = t; bc = v; improved = true; }
              }
            }
          }
        }
      }
      return { s, bc };
    };

    const nn = [], used = new Set();
    let cur = 0;
    while (nn.length < n) {
      let b = -1, bd = Infinity;
      for (let k = 1; k <= n; k++) if (!used.has(k) && M[cur][k] < bd) { bd = M[cur][k]; b = k; }
      nn.push(b); used.add(b); cur = b;
    }
    let best = improve(nn);
    const restarts = thorough ? (n > 30 ? 6 : 20) : 2;
    for (let r = 0; r < restarts; r++) {
      const shuffled = base.slice().sort(() => Math.random() - 0.5);
      const t = improve(shuffled);
      if (t.bc < best.bc) best = t;
    }
    return { seq: best.s.map((x) => x - 1), cost: best.bc };
  }

  // Split stops across vehicles by direction from the depot (sweep), balanced by load, choosing
  // the sweep start that gives the lowest total distance. With a capacity, no vehicle may carry
  // more than `capacity`: more vehicles are added until every group fits.
  // Returns arrays of indices into `stops`.
  function splitByDirection(depot, stops, k, returnToDepot, capacity = 0) {
    const n = stops.length;
    if (!n) return [];
    const w = stops.map((s) => (Number(s.load) > 0 ? Number(s.load) : capacity ? 0 : 1));
    const total = w.reduce((a, b) => a + b, 0);
    let kk = Math.max(1, Math.min(k, n));
    if (capacity > 0) kk = Math.min(n, Math.max(kk, Math.ceil(total / capacity - 1e-9)));
    if (kk <= 1 && !(capacity > 0 && total > capacity)) return [stops.map((_, i) => i)];

    const kx = Math.cos(depot.lat * Math.PI / 180);
    const ord = stops.map((s, i) => ({ i, b: Math.atan2((s.lng - depot.lng) * kx, s.lat - depot.lat) }))
      .sort((a, b) => a.b - b.b).map((o) => o.i);

    for (; kk <= n; kk++) {
      let best = null;
      for (let r = 0; r < n; r++) {
        const rot = ord.slice(r).concat(ord.slice(0, r));
        const groups = [];
        let g = [], cum = 0, gl = 0;
        rot.forEach((idx, pos) => {
          // start a new vehicle if this stop would overflow the current one
          if (capacity > 0 && g.length && gl + w[idx] > capacity + 1e-9) { groups.push(g); g = []; gl = 0; }
          g.push(idx); cum += w[idx]; gl += w[idx];
          const c = groups.length + 1, left = n - pos - 1, need = kk - c;
          if (c < kk && left > 0 && (cum >= total * c / kk - 1e-9 || left === need)) { groups.push(g); g = []; gl = 0; }
        });
        if (g.length) groups.push(g);
        if (groups.length > kk || groups.some((x) => !x.length)) continue;
        if (capacity > 0 && groups.some((gr) => gr.reduce((a, i) => a + w[i], 0) > capacity + 1e-9)) continue;
        const dist = groups.reduce((a, gr) => a + solveOrder(depot, gr.map((i) => stops[i]), returnToDepot, false).cost, 0);
        if (!best || dist < best.dist) best = { dist, groups };
      }
      if (best) return capacity > 0 ? mergeUnderfilled(best.groups) : best.groups;
      if (!(capacity > 0)) break;
    }
    return mergeUnderfilled(stops.map((_, i) => [i])); // fallback: one vehicle per stop, then combine

    // Combine part-loaded vehicles whose loads fit together (fewest extra km first), down to
    // the number of vehicles asked for.
    function mergeUnderfilled(groups) {
      groups = groups.map((g) => g.slice());
      const load = (g) => g.reduce((a, i) => a + w[i], 0);
      const routeCost = (g) => solveOrder(depot, g.map((i) => stops[i]), returnToDepot, false).cost;
      while (groups.length > Math.max(1, k)) {
        let best = null;
        for (let x = 0; x < groups.length; x++) {
          for (let y = x + 1; y < groups.length; y++) {
            if (load(groups[x]) + load(groups[y]) > capacity + 1e-9) continue;
            const extra = routeCost(groups[x].concat(groups[y])) - routeCost(groups[x]) - routeCost(groups[y]);
            if (!best || extra < best.extra) best = { x, y, extra };
          }
        }
        if (best) {
          groups[best.x] = groups[best.x].concat(groups[best.y]);
          groups.splice(best.y, 1);
          continue;
        }
        // No whole vehicles fit together: try spreading the lightest vehicle's stops into the
        // spare room of the others.
        const order = groups.map((g, gi) => gi).sort((p, q) => load(groups[p]) - load(groups[q]));
        let emptied = false;
        for (const gi of order) {
          const room = groups.map((g, j) => (j === gi ? -1 : capacity - load(g)));
          const moves = [];
          let ok = true;
          for (const idx of groups[gi].slice().sort((p, q) => w[q] - w[p])) {
            let tgt = -1;
            for (let j = 0; j < groups.length; j++) if (room[j] >= w[idx] - 1e-9 && (tgt < 0 || room[j] < room[tgt])) tgt = j;
            if (tgt < 0) { ok = false; break; }
            room[tgt] -= w[idx]; moves.push([idx, tgt]);
          }
          if (!ok) continue;
          moves.forEach(([idx, tgt]) => groups[tgt].push(idx));
          groups.splice(gi, 1);
          emptied = true;
          break;
        }
        if (!emptied) break;
      }
      return groups;
    }
  }

  // A stop bigger than one vehicle is split into full-vehicle parts plus a remainder.
  function splitOversizeStops(stops, capacity) {
    if (!(capacity > 0)) return { stops, splits: [] };
    const out = [], splits = [];
    stops.forEach((s) => {
      const load = Number(s.load) || 0;
      if (load <= capacity + 1e-9) { out.push(s); return; }
      const parts = [];
      let left = load;
      while (left > 1e-9) { const p = Math.min(capacity, left); parts.push(p); left -= p; }
      parts.forEach((p, i) => out.push({ ...s, load: p, part: i + 1, parts: parts.length }));
      splits.push({ stop: s, parts });
    });
    return { stops: out, splits };
  }

  // stops: [{lat, lng, load, ...anything}]
  // opts: {vehicles, returnToDepot, departMinutes, speedKmph, unloadMinutes, capacity}
  // Returns an array of vehicles [{legs:[{stop, no, km, cumKm, arrive}], back, km, end, load}] with
  // .meta = {requested, used, splits:[{stop, parts}]}
  function plan(depot, stopsIn, opts) {
    const capacity = Number(opts.capacity) || 0;
    const { stops, splits } = splitOversizeStops(stopsIn, capacity);
    const groups = splitByDirection(depot, stops, opts.vehicles || 1, opts.returnToDepot, capacity);
    const speed = Math.max(5, Number(opts.speedKmph) || 40);
    const unload = Math.max(0, Number(opts.unloadMinutes) || 0);
    const vehicles = groups.map((g) => {
      const gs = g.map((i) => stops[i]);
      const seq = solveOrder(depot, gs, opts.returnToDepot, true).seq.map((i) => gs[i]);
      return schedule(depot, seq, { ...opts, speedKmph: speed, unloadMinutes: unload });
    });
    vehicles.meta = { requested: Number(opts.vehicles) || 1, used: vehicles.length, splits };
    return vehicles;
  }

  // Times/distances for a fixed stop order (also used to redisplay a saved plan)
  function schedule(depot, seq, opts) {
    const speed = Math.max(5, Number(opts.speedKmph) || 40);
    const unload = Math.max(0, Number(opts.unloadMinutes) || 0);
    let t = Number(opts.departMinutes) || 0, prev = depot, cum = 0;
    const legs = seq.map((s, j) => {
      const km = roadKm(prev, s);
      cum += km; t += (km / speed) * 60;
      const leg = { stop: s, no: j + 1, km, cumKm: cum, arrive: t };
      t += unload; prev = s;
      return leg;
    });
    let back = null;
    if (opts.returnToDepot && seq.length) {
      const km = roadKm(prev, depot);
      cum += km; t += (km / speed) * 60;
      back = { km, arrive: t };
    }
    return { legs, back, km: cum, end: t, load: seq.reduce((a, s) => a + (Number(s.load) || 0), 0) };
  }

  // Google Maps directions links, max 8 waypoints per link (Google's limit), chained.
  function mapsLinks(depot, legs, returnToDepot) {
    const pts = [{ lat: depot.lat, lng: depot.lng, lbl: 'Start' }, ...legs.map((l) => ({ lat: l.stop.lat, lng: l.stop.lng, lbl: 'Stop ' + l.no }))];
    if (returnToDepot && legs.length) pts.push({ lat: depot.lat, lng: depot.lng, lbl: 'Start' });
    const f = (p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`;
    const MAX = 10;
    const out = [];
    for (let i = 0; i < pts.length - 1; i += MAX - 1) {
      const ch = pts.slice(i, i + MAX);
      if (ch.length < 2) break;
      let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${f(ch[0])}&destination=${f(ch[ch.length - 1])}`;
      if (ch.length > 2) url += `&waypoints=${ch.slice(1, -1).map(f).join('%7C')}`;
      out.push({ url, label: `${ch[0].lbl} → ${ch[ch.length - 1].lbl}` });
    }
    if (out.length === 1) out[0].label = `Full route (${legs.length} stop${legs.length === 1 ? '' : 's'}${returnToDepot ? ', back to start' : ''})`;
    return out;
  }

  function fmtClock(min) {
    const day = Math.floor(min / 1440);
    const m = Math.round(min) % 1440;
    const h = Math.floor(m / 60), mi = m % 60;
    return `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}${day ? ` (Day ${day + 1})` : ''}`;
  }
  function fmtDuration(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  function timeToMinutes(hhmm) {
    const [h, m] = String(hhmm || '06:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  // Pull coordinates out of pasted text: "17.97, 79.59" or a Google Maps link with @lat,lng / q=lat,lng
  function parseCoords(text) {
    const m = String(text || '').match(/(-?\d{1,2}\.\d{2,})\s*,\s*(-?\d{2,3}\.\d{2,})/);
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (lat < 5 || lat > 38 || lng < 67 || lng > 99) return null;
    return { lat, lng };
  }

  const COLORS = ['#1d4ed8', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2', '#be123c', '#4d7c0f'];

  window.RouteEngine = { ROAD_FACTOR, COLORS, roadKm, solveOrder, splitByDirection, plan, schedule, mapsLinks, fmtClock, fmtDuration, timeToMinutes, parseCoords };
})();
