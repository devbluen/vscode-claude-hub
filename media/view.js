// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const morph = /** @type {any} */ (window).morph;

  /** @type {any} */
  let state = null;
  /** @type {any} */
  let S = {};
  /** @type {string | null} */
  let busyId = null;
  /** @type {{ id: string, anchor: HTMLElement } | null} */
  let menu = null;

  const layer = document.createElement('div');
  layer.className = 'menu-layer';
  document.body.appendChild(layer);

  const svg = (d, cls = 'i') =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  const icons = {
    swap: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>'),
    edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
    refresh: svg('<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M4 4v4h4M20 20v-4h-4"/>'),
    up: svg('<path d="m6 15 6-6 6 6"/>'),
    down: svg('<path d="m6 9 6 6 6-6"/>'),
    userPlus: svg('<circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 13-3.5M19 14v6M16 17h6"/>'),
    save: svg('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
    reload: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.6"/><path d="M20 3v5.6h-5.6"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    alert: svg('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    stethoscope: svg('<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="12" r="2"/>'),
    star: svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>'),
    palette: svg('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-.9-.6-1.3-.6-2.1 0-.9.7-1.4 1.6-1.4H17a4 4 0 0 0 4-4c0-5-4-9-9-9Z"/><circle cx="7.5" cy="11" r="1" fill="currentColor"/><circle cx="10" cy="7" r="1" fill="currentColor"/><circle cx="14.5" cy="7" r="1" fill="currentColor"/>'),
    spinner: svg('<path d="M12 3a9 9 0 1 0 9 9"/>', 'i spin'),
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (s, ...args) => String(s).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));

  const initials = (label) => {
    const parts = String(label).trim().split(/[\s._-]+/).filter(Boolean);
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : String(label).slice(0, 2);
    return s.toUpperCase();
  };

  const duration = (ms) => {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return min % 60 ? `${h}h ${min % 60}min` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  };

  const resetText = (iso) => {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    return ms > 0 ? fmt(S.resetsIn, duration(ms)) : S.resetting;
  };

  const ago = (t) => {
    const ms = Date.now() - t;
    return ms < 60000 ? S.justNow : fmt(S.updatedAgo, duration(ms));
  };

  function usageHtml(p) {
    if (!state.showUsage) return '';
    if (p.needsLogin) {
      return `<div class="note warn">${icons.alert}<span>${esc(S.loginExpired)}</span>
        <button class="link" data-action="command" data-command="claudeHub.addAccount">${esc(S.addAgain)}</button></div>`;
    }
    if (!p.windows.length) {
      if (p.status === 'loading') {
        return `<div class="usage"><div class="skeleton"></div><div class="skeleton short"></div></div>`;
      }
      return p.status === 'error'
        ? `<div class="note">${icons.alert}<span>${esc(fmt(S.usageUnavailable, p.error))}</span></div>`
        : `<div class="note">${icons.clock}<span>${esc(S.notChecked)}</span></div>`;
    }
    const meters = p.windows
      .map((w) => {
        const pct = Math.max(0, Math.min(100, Math.round(w.percent)));
        const cls = pct >= 100 ? 'bad' : pct >= 70 ? 'warn' : '';
        return `<div class="meter" data-key="${esc(w.kind)}">
          <div class="meter-top"><span class="lbl">${esc(w.label)}</span><span class="val">${pct}%<small>${esc(resetText(w.resetsAt))}</small></span></div>
          <div class="track"><div class="fill ${cls}" style="width:${pct}%"></div></div>
        </div>`;
      })
      .join('');
    let foot = '';
    if (p.status === 'error') {
      foot = `<div class="note">${icons.alert}<span>${esc(fmt(S.usageUnavailable, p.error))}</span></div>`;
    } else if (p.status === 'stale' && p.fetchedAt && Date.now() - p.fetchedAt > 10 * 60000) {
      foot = `<div class="note">${icons.clock}<span>${esc(ago(p.fetchedAt))}</span></div>`;
    }
    return `<div class="usage">${meters}</div>${foot}`;
  }

  function cardHtml(p) {
    const meta = p.orgName && !/personal|pessoal/i.test(p.orgName) ? `${p.email} · ${p.orgName}` : p.email;
    const action = p.active
      ? `<span class="pill-active">${icons.check}${esc(S.active)}</span>`
      : `<button class="btn switch" data-action="switch" data-id="${p.id}" ${p.needsLogin ? 'disabled' : ''}>${busyId === p.id ? icons.spinner : icons.swap}${esc(S.use)}</button>`;
    return `<div class="card ${p.active ? 'active' : ''} ${busyId === p.id ? 'busy' : ''}" data-key="${p.id}" style="--c:${p.color}">
      <div class="head">
        <div class="avatar">${esc(initials(p.label))}${p.active ? '<span class="dot"></span>' : ''}</div>
        <div class="who">
          <div class="name-row"><span class="name" title="${esc(p.label)}">${esc(p.label)}</span>${p.plan ? `<span class="badge">${esc(p.plan)}</span>` : ''}</div>
          <div class="email" title="${esc(meta)}">${esc(meta)}</div>
        </div>
        <div class="actions">
          ${action}
          <button class="btn icon ${menu?.id === p.id ? 'open' : ''}" data-action="menu" data-id="${p.id}" title="${esc(S.moreOptions)}" aria-haspopup="menu">${icons.more}</button>
        </div>
      </div>
      ${p.best ? `<div class="best">${icons.star}<span><b>${esc(S.best)}</b> · ${esc(p.best)}</span></div>` : ''}
      ${usageHtml(p)}
    </div>`;
  }

  const emptyArt = `<svg class="art" viewBox="0 0 96 96" fill="none">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E07A5F"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs>
    <rect x="6" y="6" width="84" height="84" rx="24" fill="url(#g)" opacity=".14"/>
    <circle cx="36" cy="40" r="11" fill="url(#g)"/><path d="M18 70a18 18 0 0 1 36 0" fill="url(#g)"/>
    <circle cx="62" cy="36" r="9" fill="url(#g)" opacity=".55"/><path d="M48 64a15 15 0 0 1 30 0" fill="url(#g)" opacity=".55"/>
  </svg>`;

  function render() {
    if (!state) return;
    const total = state.profiles.length;
    let html = '';

    if (state.needsReload) {
      html += `<div class="banner reload" data-key="reload">${icons.reload}<div class="txt"><b>${esc(S.reloadTitle)}</b><span>${esc(S.reloadText)}</span></div>
        <button class="btn primary" data-action="command" data-command="claudeHub.reloadWindow">${esc(S.reload)}</button></div>`;
    }
    if (state.unsaved) {
      html += `<div class="banner unsaved" data-key="unsaved">${icons.info}<div class="txt"><b>${esc(S.unsavedTitle)}</b><span>${esc(state.unsaved.email)}</span></div>
        <button class="btn primary" data-action="command" data-command="claudeHub.saveCurrent">${esc(S.save)}</button></div>`;
    }

    if (!total) {
      html += `<div class="empty" data-key="empty">${emptyArt}
        <h2>${esc(S.emptyTitle)}</h2>
        <p>${esc(S.emptyText)}</p>
        <div class="btns">
          ${state.unsaved ? `<button class="btn primary" data-action="command" data-command="claudeHub.saveCurrent">${icons.save}${esc(S.saveCurrent)}</button>` : ''}
          <button class="btn ${state.unsaved ? 'ghost' : 'primary'}" data-action="command" data-command="claudeHub.addAccount">${icons.userPlus}${esc(S.addAccount)}</button>
          <button class="btn ghost" data-action="command" data-command="claudeHub.doctor">${icons.stethoscope}${esc(S.diagnostics)}</button>
        </div>
      </div>`;
    } else {
      html += `<div class="list" data-key="list">${state.profiles.map(cardHtml).join('')}</div>`;
      html += `<div class="footer" data-key="footer">
        <a data-action="command" data-command="claudeHub.openAnalytics">${icons.chart}${esc(S.analytics)}</a>
        <a data-action="command" data-command="claudeHub.doctor">${icons.stethoscope}${esc(S.diagnostics)}</a>
        ${state.canUndo ? `<a data-action="command" data-command="claudeHub.undo">${icons.reload}${esc(S.undo)}</a>` : ''}
      </div>
      <div class="vault" data-key="vault">${icons.lock}<span>${esc(S.vault)}</span></div>`;
    }
    morph(app, html);
    renderMenu();
  }

  // ---------- floating menu (lives outside the cards, above everything) ----------

  function renderMenu() {
    const p = menu && state?.profiles.find((x) => x.id === menu?.id);
    if (!menu || !p || !document.body.contains(menu.anchor)) {
      layer.innerHTML = '';
      layer.classList.remove('on');
      return;
    }
    const index = state.profiles.indexOf(p);
    const swatches = state.colors
      .map((c) => `<button class="swatch ${c === p.color ? 'on' : ''}" style="--s:${c}" data-action="color" data-id="${p.id}" data-color="${c}" aria-label="${c}">${c === p.color ? icons.check : ''}</button>`)
      .join('');
    morph(layer, `<div class="menu" role="menu" data-key="${p.id}" style="--c:${p.color}">
      <div class="menu-title">${esc(p.label)}</div>
      <button class="item" role="menuitem" data-action="rename" data-id="${p.id}">${icons.edit}<span>${esc(S.rename)}</span></button>
      <button class="item" role="menuitem" data-action="usage" data-id="${p.id}">${icons.refresh}<span>${esc(S.refreshUsage)}</span></button>
      ${index > 0 ? `<button class="item" role="menuitem" data-action="move" data-delta="-1" data-id="${p.id}">${icons.up}<span>${esc(S.moveUp)}</span></button>` : ''}
      ${index < state.profiles.length - 1 ? `<button class="item" role="menuitem" data-action="move" data-delta="1" data-id="${p.id}">${icons.down}<span>${esc(S.moveDown)}</span></button>` : ''}
      <div class="sep"></div>
      <div class="menu-label">${icons.palette}<span>${esc(S.color)}</span></div>
      <div class="swatches">${swatches}</div>
      <div class="sep"></div>
      <button class="item danger" role="menuitem" data-action="remove" data-id="${p.id}">${icons.trash}<span>${esc(S.remove)}</span></button>
    </div>`);
    layer.classList.add('on');
    place();
  }

  function place() {
    const el = /** @type {HTMLElement | null} */ (layer.firstElementChild);
    if (!el || !menu) return;
    const r = menu.anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let top = r.bottom + 4;
    if (top + h > vh - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
    top = Math.max(8, Math.min(top, vh - h - 8));
    const left = Math.max(8, Math.min(r.right - w, vw - w - 8));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  function closeMenu() {
    if (!menu) return;
    menu = null;
    render();
  }

  document.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const el = /** @type {HTMLElement | null} */ (target?.closest('[data-action]') ?? null);
    if (!el) {
      if (menu && !target?.closest('.menu')) closeMenu();
      return;
    }
    const { action, id } = el.dataset;
    if (action === 'menu') {
      menu = menu?.id === id ? null : { id: String(id), anchor: el };
      render();
      return;
    }
    if (action === 'color') {
      // keeps the menu open so the choice is visible
      vscode.postMessage({ type: 'color', id, color: el.dataset.color });
      return;
    }
    menu = null;
    switch (action) {
      case 'switch':
        busyId = id ?? null;
        vscode.postMessage({ type: 'switch', id });
        break;
      case 'move':
        vscode.postMessage({ type: 'move', id, delta: Number(el.dataset.delta) });
        break;
      case 'command':
        vscode.postMessage({ type: 'command', command: el.dataset.command });
        break;
      default:
        vscode.postMessage({ type: action, id });
    }
    render();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('blur', closeMenu);

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg?.type === 'state') {
      state = msg.state;
      S = state.strings;
      if (busyId && state.profiles.some((p) => p.id === busyId && p.active)) busyId = null;
      if (menu) {
        // the anchor element may have been patched; find it again
        const anchor = /** @type {HTMLElement | null} */ (app.querySelector(`[data-action="menu"][data-id="${menu.id}"]`));
        if (anchor) menu.anchor = anchor;
      }
      render();
    } else if (msg?.type === 'switchDone') {
      busyId = null;
      render();
    }
  });

  // Keeps the "resets in …" texts current.
  setInterval(render, 60_000);

  vscode.postMessage({ type: 'ready' });
})();
