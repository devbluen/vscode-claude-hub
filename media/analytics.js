// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const morph = /** @type {any} */ (window).morph;

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
  const PRODUCT_COLORS = ['#E07A5F', '#3B82F6', '#14B8A6', '#94A3B8', '#8B5CF6', '#F59E0B'];

  /** @type {any} */
  let state = null;
  /** @type {any} */
  let S = {};
  const saved = vscode.getState() || {};
  let range = saved.range || '7d';
  let kind = saved.kind || 'session';
  /** @type {Set<string>} */
  const hidden = new Set(saved.hidden || []);
  let hoverT = /** @type {number | null} */ (null);
  let tipAt = { x: 0, y: 0 };

  const persist = () => vscode.setState({ range, kind, hidden: [...hidden] });
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (s, ...a) => String(s).replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)] ?? ''));
  const initials = (label) => {
    const parts = String(label).trim().split(/[\s._-]+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(label).slice(0, 2)).toUpperCase();
  };
  const duration = (ms) => {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return min % 60 ? `${h}h ${min % 60}min` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  };
  const dt = (opts) => new Intl.DateTimeFormat(state?.locale || undefined, opts);
  const when = (t) => dt({ weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  const levelClass = (p) => (p >= 100 ? 'bad' : p >= 70 ? 'warn' : '');
  const visible = () => state.accounts.filter((a) => !hidden.has(a.id));

  // ---------- data ----------

  /** Readings of one limit within the range (plus the one right before, for continuity). */
  function series(acc, k, from) {
    const pts = acc.history.filter((p) => typeof p.w[k] === 'number').map((p) => ({ t: p.t, v: p.w[k] }));
    const i = pts.findIndex((p) => p.t >= from);
    if (i < 0) return pts.length ? [pts[pts.length - 1]] : [];
    return pts.slice(Math.max(0, i - 1));
  }

  const maxGap = () => (range === '24h' ? 2 * HOUR : 6 * HOUR);

  function stats(acc, k, from) {
    const pts = series(acc, k, from).filter((p, i, a) => p.t >= from || i === 0);
    let used = 0, peak = 0, hits = 0, blocked = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.t >= from) peak = Math.max(peak, p.v);
      if (i === 0) continue;
      const prev = pts[i - 1];
      // a drop means the window reset: the new value was used from zero
      used += p.v >= prev.v ? p.v - prev.v : p.v;
      if (prev.v < 100 && p.v >= 100) hits++;
      if (prev.v >= 100) blocked += Math.min(p.t - prev.t, maxGap());
    }
    return { used, peak, hits, blocked, points: pts.length };
  }

  // ---------- pieces ----------

  function accountCard(a) {
    const blockedW = a.windows.filter((w) => w.percent >= 100);
    const until = blockedW.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : 0)).filter(Boolean).sort((x, y) => y - x)[0];
    const chip = a.needsLogin
      ? `<span class="chip bad">${esc(S.loginExpired)}</span>`
      : !a.windows.length
        ? `<span class="chip">${esc(S.noData)}</span>`
        : blockedW.length
          ? `<span class="chip bad">${esc(until ? fmt(S.blockedUntil, when(until)) : S.blocked)}</span>`
          : `<span class="chip ok">${esc(S.availableNow)}</span>`;
    const rows = a.windows
      .map(
        (w) => `<div class="mini-row" data-key="${esc(w.kind)}"><span class="lbl">${esc(w.label)}</span><span class="val">${Math.round(w.percent)}%</span>
        <div class="track"><div class="fill ${levelClass(w.percent)}" style="width:${Math.min(100, w.percent)}%"></div></div></div>`,
      )
      .join('');
    return `<div class="card acc ${a.active ? 'active' : ''}" data-key="${a.id}" style="--c:${a.color}">
      <div class="acc-head">
        <div class="avatar">${esc(initials(a.label))}</div>
        <div class="acc-who"><div class="acc-name">${esc(a.label)}</div><div class="acc-sub">${esc(a.email)}${a.plan ? ' · ' + esc(a.plan) : ''}</div></div>
        ${a.active ? `<span class="chip c">${esc(S.active)}</span>` : ''}
      </div>
      <div class="mini">${rows || `<span class="muted">${esc(S.notChecked)}</span>`}</div>
      <div class="acc-foot">${chip}
        ${a.best ? `<span class="chip star" title="${esc(a.best)}">★ ${esc(S.best)}</span>` : ''}
        ${!a.active && !a.needsLogin ? `<button class="btn ghost sm" data-switch="${a.id}">${esc(S.switchTo)}</button>` : ''}
      </div>
    </div>`;
  }

  function chart(width) {
    const from = Date.now() - RANGES[range];
    const to = Date.now();
    const accs = state.accounts.map((a) => ({ a, pts: series(a, kind, from) })).filter((x) => x.pts.length);
    if (!accs.length) return `<div class="empty-chart">${esc(S.noHistory)}</div>`;

    const H = 260, L = 38, R = 12, T = 12, B = 26;
    const W = Math.max(320, width);
    const x = (t) => L + ((Math.max(from, t) - from) / (to - from)) * (W - L - R);
    const y = (v) => T + (1 - Math.min(100, v) / 100) * (H - T - B);

    let g = '';
    for (const v of [0, 25, 50, 75, 100]) {
      g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end">${v}%</text>`;
    }
    g += `<line class="limit-line" x1="${L}" x2="${W - R}" y1="${y(100)}" y2="${y(100)}"/>`;

    // time ticks
    const step = range === '24h' ? 4 * HOUR : range === '7d' ? DAY : 5 * DAY;
    const tickFmt = range === '24h' ? dt({ hour: '2-digit', minute: '2-digit' }) : dt({ day: '2-digit', month: 'short' });
    const first = new Date(from);
    if (range === '24h') first.setMinutes(0, 0, 0), first.setHours(Math.ceil(first.getHours() / 4) * 4);
    else first.setHours(24, 0, 0, 0);
    for (let t = first.getTime(); t <= to; t += step) {
      g += `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(tickFmt.format(new Date(t)))}</text>`;
    }

    const gap = maxGap();
    for (const { a, pts } of accs) {
      if (hidden.has(a.id)) continue;
      // step line: usage stays at a value until the next reading
      let d = '';
      pts.forEach((p, i) => {
        const prev = pts[i - 1];
        if (!prev || p.t - prev.t > gap) d += `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
        else d += `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}`;
      });
      const last = pts[pts.length - 1];
      if (to - last.t < gap) d += `H${x(to).toFixed(1)}`;
      g += `<path class="series" d="${d}" stroke="${a.color}"/>`;
      g += `<circle cx="${x(Math.min(to, to - last.t < gap ? to : last.t))}" cy="${y(last.v)}" r="3.5" fill="${a.color}"/>`;
    }

    if (hoverT !== null) {
      g += `<line class="cursor" x1="${x(hoverT)}" x2="${x(hoverT)}" y1="${T}" y2="${H - B}"/>`;
      for (const { a, pts } of accs) {
        if (hidden.has(a.id)) continue;
        const v = valueAt(pts, hoverT);
        if (v !== null) g += `<circle cx="${x(hoverT)}" cy="${y(v)}" r="4" fill="${a.color}" stroke="var(--bg)" stroke-width="2"/>`;
      }
    }

    return `<svg viewBox="0 0 ${W} ${H}" height="${H}" data-l="${L}" data-r="${R}" data-w="${W}">${g}
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
  }

  function valueAt(pts, t) {
    let v = null;
    for (const p of pts) {
      if (p.t > t) break;
      v = t - p.t <= maxGap() ? p.v : null;
    }
    return v;
  }

  function legend() {
    return state.accounts
      .map((a) => `<button class="${hidden.has(a.id) ? 'off' : ''}" data-toggle="${a.id}" style="--c:${a.color}"><i></i>${esc(a.label)}</button>`)
      .join('');
  }

  function statsTable() {
    const from = Date.now() - RANGES[range];
    const rows = state.accounts
      .map((a) => {
        const s = stats(a, kind, from);
        if (!s.points) return '';
        return `<tr data-key="${a.id}" style="--c:${a.color}"><td class="who"><i></i>${esc(a.label)}</td>
          <td class="num">${Math.round(s.used)}%</td><td class="num">${Math.round(s.peak)}%</td>
          <td class="num">${s.hits}</td><td class="num">${s.blocked ? duration(s.blocked) : '—'}</td></tr>`;
      })
      .join('');
    if (!rows) return `<div class="muted">${esc(S.noHistory)}</div>`;
    return `<table><thead><tr><th>${esc(S.account)}</th><th class="num" title="${esc(S.capacityHint)}">${esc(S.capacityUsed)} ⓘ</th>
      <th class="num">${esc(S.peak)}</th><th class="num">${esc(S.limitHits)}</th><th class="num">${esc(S.timeBlocked)}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function timeline() {
    const now = Date.now();
    const end = now + 7 * DAY;
    const pos = (t) => (((Math.min(end, Math.max(now, t)) - now) / (end - now)) * 100).toFixed(2);
    const dayFmt = dt({ weekday: 'short', day: '2-digit' });
    let days = '';
    let dayLines = '';
    const d0 = new Date(now);
    d0.setHours(24, 0, 0, 0);
    for (let t = d0.getTime(); t < end; t += DAY) {
      days += `<span style="left:${pos(t)}%">${esc(dayFmt.format(new Date(t)))}</span>`;
      dayLines += `<div class="tl-day-line" style="left:${pos(t)}%"></div>`;
    }
    const rows = state.accounts
      .map((a) => {
        let inner = dayLines;
        for (const w of a.windows) {
          const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
          if (!Number.isFinite(reset) || reset <= now) continue;
          if (w.percent >= 100) {
            inner += `<div class="tl-block" style="left:0;width:${pos(reset)}%" title="${esc(w.label)} · ${esc(fmt(S.blockedUntil, when(reset)))}"></div>`;
          }
          if (reset < end) {
            inner += `<div class="tl-mark ${w.kind === 'session' ? '' : 'weekly'}" style="left:${pos(reset)}%" title="${esc(fmt(S.resetOf, w.label))} · ${esc(when(reset))}"></div>`;
          }
        }
        return `<div class="tl-row" data-key="${a.id}" style="--c:${a.color}"><div class="tl-name" title="${esc(a.label)}"><i></i>${esc(a.label)}</div>
          <div class="tl-bar ${a.windows.length ? '' : 'unknown'}">${inner}</div></div>`;
      })
      .join('');
    return `<div class="timeline"><div class="tl-days">${days}</div>${rows}
      <div class="tl-legend"><span><i class="sw" style="background:color-mix(in srgb,var(--ok) 30%,transparent)"></i>${esc(S.available)}</span>
      <span><i class="sw" style="background:color-mix(in srgb,var(--bad) 45%,transparent)"></i>${esc(S.blocked)}</span>
      <span>● ${esc(fmt(S.resetOf, '5h'))}</span><span>◆ ${esc(fmt(S.resetOf, '7d'))}</span></div></div>`;
  }

  function breakdown() {
    const rows = state.accounts
      .filter((a) => a.breakdown?.some((r) => r.percent > 0))
      .map((a) => {
        const parts = a.breakdown.filter((r) => r.percent > 0);
        return `<div class="bd-row" data-key="${a.id}" style="--c:${a.color}"><div class="bd-head"><i></i>${esc(a.label)}</div>
          <div class="stack">${parts.map((r, i) => `<div style="width:${r.percent}%;background:${PRODUCT_COLORS[i % PRODUCT_COLORS.length]}" title="${esc(r.label)} ${r.percent}%"></div>`).join('')}</div>
          <div class="bd-legend">${parts.map((r, i) => `<span><i style="background:${PRODUCT_COLORS[i % PRODUCT_COLORS.length]}"></i>${esc(r.label)} ${Math.round(r.percent)}%</span>`).join('')}</div></div>`;
      })
      .join('');
    return rows || `<div class="muted">${esc(S.noData)}</div>`;
  }

  // ---------- render ----------

  function render() {
    if (!state) return;
    if (!state.kinds.some((k) => k.kind === kind)) kind = state.kinds[0]?.kind ?? 'session';
    const chartEl = document.getElementById('chart');
    const width = chartEl ? chartEl.clientWidth : app.clientWidth - 40;
    const kindLabel = state.kinds.find((k) => k.kind === kind)?.label ?? '';

    const html = `<div class="toolbar" data-key="toolbar">
        <header><h1>${esc(S.analyticsTitle)}</h1><p>${esc(S.analyticsSub)}</p></header>
        <div class="controls">
          <div class="seg">${Object.keys(RANGES)
            .map((r) => `<button class="${r === range ? 'on' : ''}" data-range="${r}">${esc(S['range' + r])}</button>`)
            .join('')}</div>
          <select id="kind" aria-label="${esc(S.limit)}">${state.kinds
            .map((k) => `<option value="${esc(k.kind)}" ${k.kind === kind ? 'selected' : ''}>${esc(k.label)}</option>`)
            .join('')}</select>
          <button class="btn ghost" data-refresh>↻</button>
        </div>
      </div>
      <div class="grid accounts" data-key="accounts">${state.accounts.map(accountCard).join('')}</div>
      <div class="card" data-key="chart-card"><h2>${esc(S.overTime)} <span class="hint">· ${esc(kindLabel)}</span></h2>
        <div class="chart-wrap"><div class="chart" id="chart">${chart(width)}</div><div class="tooltip" id="tip"></div></div>
        <div class="legend">${legend()}</div></div>
      <div class="grid two" data-key="two">
        <div class="card"><h2>${esc(S.statsTitle)} <span class="hint">· ${esc(kindLabel)}</span></h2>${statsTable()}</div>
        <div class="card"><h2>${esc(S.availability)}</h2>${timeline()}</div>
      </div>
      <div class="card" data-key="bd" style="margin-top:14px"><h2>${esc(S.breakdown)}</h2>${breakdown()}</div>`;
    morph(app, html);
    updateTooltip();
  }

  function updateTooltip() {
    const tip = document.getElementById('tip');
    if (!tip) return;
    if (hoverT === null) {
      tip.classList.remove('on');
      return;
    }
    const rows = state.accounts
      .filter((a) => !hidden.has(a.id))
      .map((a) => ({ a, v: valueAt(series(a, kind, Date.now() - RANGES[range]), hoverT) }))
      .filter((r) => r.v !== null)
      .map((r) => `<div class="tt-row" style="--c:${r.a.color}"><i></i>${esc(r.a.label)}<b>${Math.round(r.v)}%</b></div>`)
      .join('');
    tip.innerHTML = `<div class="tt-time">${esc(when(hoverT))}</div>${rows || `<span class="muted">${esc(S.noData)}</span>`}`;
    tip.classList.add('on');
    const wrap = tip.parentElement;
    if (wrap) {
      const wr = wrap.getBoundingClientRect();
      let left = tipAt.x - wr.left + 14;
      if (left + tip.offsetWidth > wr.width) left = tipAt.x - wr.left - tip.offsetWidth - 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, tipAt.y - wr.top - 20)}px`;
    }
  }

  // ---------- events ----------

  app.addEventListener('click', (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const rangeBtn = t?.closest('[data-range]');
    const toggle = t?.closest('[data-toggle]');
    const sw = t?.closest('[data-switch]');
    if (rangeBtn) {
      range = /** @type {HTMLElement} */ (rangeBtn).dataset.range || '7d';
    } else if (toggle) {
      const id = /** @type {HTMLElement} */ (toggle).dataset.toggle || '';
      hidden.has(id) ? hidden.delete(id) : hidden.add(id);
    } else if (sw) {
      vscode.postMessage({ type: 'switch', id: /** @type {HTMLElement} */ (sw).dataset.switch });
      return;
    } else if (t?.closest('[data-refresh]')) {
      vscode.postMessage({ type: 'refresh' });
      return;
    } else {
      return;
    }
    persist();
    render();
  });

  app.addEventListener('change', (ev) => {
    if (ev.target instanceof HTMLSelectElement && ev.target.id === 'kind') {
      kind = ev.target.value;
      persist();
      render();
    }
  });

  app.addEventListener('mousemove', (ev) => {
    const svgEl = ev.target instanceof Element ? ev.target.closest('#chart svg') : null;
    if (!svgEl) {
      if (hoverT !== null) {
        hoverT = null;
        render();
      }
      return;
    }
    const rect = svgEl.getBoundingClientRect();
    const W = Number(svgEl.getAttribute('data-w'));
    const L = Number(svgEl.getAttribute('data-l'));
    const R = Number(svgEl.getAttribute('data-r'));
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    if (px < L || px > W - R) return;
    const from = Date.now() - RANGES[range];
    hoverT = from + ((px - L) / (W - L - R)) * (Date.now() - from);
    tipAt = { x: ev.clientX, y: ev.clientY };
    render();
  });
  app.addEventListener('mouseleave', () => {
    hoverT = null;
    render();
  });

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = /** @type {any} */ (setTimeout(render, 80));
  }).observe(app);

  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'state') {
      state = ev.data.state;
      S = state.strings;
      render();
    }
  });

  setInterval(render, 60_000);
  vscode.postMessage({ type: 'ready' });
})();
