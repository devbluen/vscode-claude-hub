// Builds the README screenshots from the real webview code (media/*) fed with made-up
// data (fake-data.js), rendered by headless Chrome/Edge.
//   npm run compile && node scripts/screenshots/generate.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const stub = require('./vscode-stub');
const { accounts } = require('./fake-data');

const root = stub.root;
const out = path.join(root, 'docs', 'screenshots');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-switch-shots-'));
const media = (f) => pathToFileURL(path.join(root, 'media', f)).href;

const { accountsState } = require(path.join(root, 'out', 'view'));
const { webviewStrings } = require(path.join(root, 'out', 'i18n'));
const { rankAccounts } = require(path.join(root, 'out', 'suggest'));
const { limitLabel } = require(path.join(root, 'out', 'usage'));
const cli = require(path.join(root, 'out', 'cli'));
const claudeFiles = require(path.join(root, 'out', 'claudeFiles'));
const api = require(path.join(root, 'out', 'api'));
const { DoctorPanel } = require(path.join(root, 'out', 'doctor'));
const COLORS = ['#E07A5F', '#8B5CF6', '#3B82F6', '#14B8A6', '#22C55E', '#F59E0B', '#EC4899', '#64748B'];

// VS Code "Dark Modern" / "Light Modern" theme variables used by the webviews.
const THEMES = {
  dark: {
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif',
    'font-size': '13px',
    'editor-font-family': 'Consolas, "Cascadia Mono", monospace',
    foreground: '#cccccc', descriptionForeground: '#9d9d9d',
    'sideBar-background': '#181818', 'editor-background': '#1f1f1f',
    'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
    'textLink-foreground': '#4daafc', focusBorder: '#0078d4',
    'menu-background': '#1f1f1f', 'menu-foreground': '#cccccc', 'menu-border': '#454545',
    'menu-selectionBackground': '#0078d4', 'menu-selectionForeground': '#ffffff',
    'dropdown-background': '#313131', 'dropdown-foreground': '#cccccc', 'dropdown-border': '#3c3c3c',
    'editorHoverWidget-background': '#202020', 'editorHoverWidget-border': '#454545',
    'editorWidget-background': '#202020', 'widget-border': '#313131',
    'textCodeBlock-background': '#2b2b2b', 'progressBar-background': '#0078d4',
    // frame only
    chrome: '#181818', border: '#2b2b2b', tabActive: '#1f1f1f', statusBar: '#181818', statusText: '#cccccc', activityIcon: '#868686',
  },
  light: {
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif',
    'font-size': '13px',
    'editor-font-family': 'Consolas, "Cascadia Mono", monospace',
    foreground: '#3b3b3b', descriptionForeground: '#717171',
    'sideBar-background': '#f8f8f8', 'editor-background': '#ffffff',
    'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8',
    'textLink-foreground': '#005fb8', focusBorder: '#005fb8',
    'menu-background': '#ffffff', 'menu-foreground': '#3b3b3b', 'menu-border': '#cecece',
    'menu-selectionBackground': '#005fb8', 'menu-selectionForeground': '#ffffff',
    'dropdown-background': '#ffffff', 'dropdown-foreground': '#3b3b3b', 'dropdown-border': '#cecece',
    'editorHoverWidget-background': '#f8f8f8', 'editorHoverWidget-border': '#c8c8c8',
    'editorWidget-background': '#f8f8f8', 'widget-border': '#e5e5e5',
    'textCodeBlock-background': '#f0f0f0', 'progressBar-background': '#005fb8',
    chrome: '#f8f8f8', border: '#e5e5e5', tabActive: '#ffffff', statusBar: '#f8f8f8', statusText: '#3b3b3b', activityIcon: '#616161',
  },
};

const themeCss = (theme) =>
  `:root{${Object.entries(THEMES[theme]).map(([k, v]) => `--vscode-${k}:${v};`).join('')}}`;

// ---------- state builders (same shape the extension posts) ----------

function buildStates(lang) {
  stub.setLanguage(lang);
  const now = Date.now();
  const data = accounts(now, lang);
  const usage = new Map(data.map((d) => [d.profile.id, { status: 'ok', snapshot: d.snapshot }]));
  const profiles = data.map((d) => d.profile);
  const manager = {
    profiles,
    activeId: 'a1',
    get activeProfile() { return profiles[0]; },
    usage,
    suggest: (focus) =>
      rankAccounts(profiles.map((p) => ({ id: p.id, label: p.label, active: p.id === 'a1', needsLogin: false, snapshot: usage.get(p.id).snapshot })), focus, now),
  };
  const strings = webviewStrings();
  const sidebar = {
    profiles: accountsState(manager),
    unsaved: null,
    canUndo: true,
    needsReload: false,
    colors: COLORS,
    showUsage: true,
    locale: lang,
    strings,
  };
  const kinds = [
    { kind: 'session', label: limitLabel('session') },
    { kind: 'weekly_all', label: limitLabel('weekly_all') },
    { kind: 'weekly_fable', label: limitLabel('weekly_fable', 'Fable') },
  ];
  const analytics = {
    accounts: accountsState(manager).map((a) => ({ ...a, history: data.find((d) => d.profile.id === a.id).history })),
    kinds,
    locale: lang,
    strings,
  };
  return { sidebar, analytics, manager };
}

// ---------- pages ----------

const vscodeApiStub = (saved) =>
  `<script>window.acquireVsCodeApi=()=>({postMessage(){},getState(){return ${JSON.stringify(saved ?? null)}},setState(){}});</script>`;

function sidebarPage(state, theme, { openMenuFor } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeCss(theme)}html,body{background:var(--vscode-sideBar-background)}</style>
<link rel="stylesheet" href="${media('view.css')}"></head><body class="sidebar intro"><div id="app"></div>
${vscodeApiStub()}<script src="${media('morph.js')}"></script><script src="${media('view.js')}"></script>
<script>
window.postMessage({type:'state',state:${JSON.stringify(state)}},'*');
${openMenuFor ? `setTimeout(()=>document.querySelector('[data-action="menu"][data-id="${openMenuFor}"]').click(),1200);` : ''}
</script></body></html>`;
}

function analyticsPage(state, theme, { hoverAt, range = '7d', kind = 'weekly_all' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeCss(theme)}html{background:var(--vscode-editor-background)}</style>
<link rel="stylesheet" href="${media('panel.css')}"></head><body class="analytics intro"><div id="app"></div>
${vscodeApiStub({ range, kind, hidden: [] })}<script src="${media('morph.js')}"></script><script src="${media('analytics.js')}"></script>
<script>
window.postMessage({type:'state',state:${JSON.stringify(state)}},'*');
${hoverAt ? `setTimeout(()=>{const s=document.querySelector('#chart svg');const r=s.getBoundingClientRect();
const x=r.left+r.width*${hoverAt},y=r.top+r.height*0.45;
s.querySelector('.hit').dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}));},1500);` : ''}
</script></body></html>`;
}

async function doctorPage(manager, lang, theme) {
  stub.setLanguage(lang);
  // Fake environment: CLI installed but not on PATH, signed in, usage API reachable.
  const exe = 'C:\\Users\\alex\\.local\\bin\\claude.exe';
  cli.findAllCli = async () => [{ path: exe, source: 'installer' }];
  cli.cliVersion = async () => '2.1.310 (Claude Code)';
  claudeFiles.readCurrentLogin = async () => ({
    claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + HOUR_MS },
    oauthAccount: { accountUuid: 'u', emailAddress: 'alex@example.com' },
  });
  claudeFiles.credentialsPath = () => 'C:\\Users\\alex\\.claude\\.credentials.json';
  claudeFiles.globalConfigPath = () => 'C:\\Users\\alex\\.claude.json';
  claudeFiles.usesKeychain = () => false;
  api.fetchUsage = async () => ({ fetchedAt: Date.now(), windows: [] });

  DoctorPanel.show({ extensionUri: { fsPath: root }, extension: { id: 'devbluen.claude-hub-accounts' } }, { profiles: manager.profiles, unsaved: undefined });
  for (let i = 0; i < 100 && /class="loading"/.test(stub.getCapturedHtml()); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  // close the panel so the next language builds a new one
  require(path.join(root, 'out', 'doctor')).DoctorPanel.current = undefined;
  DoctorPanel['current'] = undefined;
  const html = stub
    .getCapturedHtml()
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<head>', `<head><style>${themeCss(theme)}html{background:var(--vscode-editor-background)}</style>`);
  return html;
}
const HOUR_MS = 3_600_000;

// ---------- VS Code window frame for the hero shot ----------

const ACTIVITY = {
  files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  git: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-10 6"/>',
  run: '<path d="M8 5v14l11-7z"/>',
  ext: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><path d="m14 4 6 6-6 6" opacity="0"/><rect x="14" y="3" width="6" height="6" transform="rotate(15 17 6)"/>',
  claude: '<path d="M20 12a8 8 0 0 1-13.66 5.66"/><path d="M4 12a8 8 0 0 1 13.66-5.66"/><path d="M6.3 21.2v-3.9h3.9"/><path d="M17.7 2.8v3.9h-3.9"/><path d="M12 8.8v6.4M9.2 10.4l5.6 3.2M9.2 13.6l5.6-3.2"/>',
};
const icon = (d, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

function heroPage(theme, lang, sidebarFile, analyticsFile, activeLabel) {
  const pt = lang === 'pt-br';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeCss(theme)}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--vscode-chrome);font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);overflow:hidden}
.win{display:flex;flex-direction:column;height:100%}
.title{height:35px;display:flex;align-items:center;gap:14px;padding:0 12px;border-bottom:1px solid var(--vscode-border);font-size:12.5px}
.title .menu span{margin-right:12px;opacity:.85}.title .center{flex:1;text-align:center;opacity:.8}
.dots{display:flex;gap:8px}.dots i{width:12px;height:12px;border-radius:50%;display:block}
.main{flex:1;display:flex;min-height:0}
.act{width:48px;border-right:1px solid var(--vscode-border);display:flex;flex-direction:column;align-items:center;padding-top:6px;gap:4px;color:var(--vscode-activityIcon)}
.act div{width:48px;height:48px;display:grid;place-items:center;position:relative}
.act .on{color:var(--vscode-foreground)}.act .on::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--vscode-focusBorder)}
.side{width:340px;border-right:1px solid var(--vscode-border);display:flex;flex-direction:column;background:var(--vscode-sideBar-background)}
.side .h{height:35px;display:flex;align-items:center;padding:0 20px;font-size:11px;letter-spacing:.4px;opacity:.85}
.side .vh{height:22px;display:flex;align-items:center;padding:0 8px 0 4px;font-size:11px;font-weight:700;letter-spacing:.2px}
.side .vh .ic{margin-left:auto;display:flex;gap:6px;opacity:.8}
iframe{border:0;flex:1;width:100%;display:block}
.ed{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--vscode-editor-background)}
.tabs{height:35px;display:flex;background:var(--vscode-chrome);border-bottom:1px solid var(--vscode-border)}
.tab{display:flex;align-items:center;gap:8px;padding:0 14px;background:var(--vscode-tabActive);border-right:1px solid var(--vscode-border);border-top:1px solid var(--vscode-focusBorder);font-size:12.5px}
.tab img{width:16px;height:16px}
.status{height:22px;display:flex;align-items:center;gap:16px;padding:0 10px;font-size:12px;background:var(--vscode-statusBar);color:var(--vscode-statusText);border-top:1px solid var(--vscode-border)}
.status .r{margin-left:auto;display:flex;gap:16px;align-items:center}
.status .acc{display:flex;align-items:center;gap:4px;padding:0 6px;border-radius:3px;background:color-mix(in srgb,var(--vscode-foreground) 10%,transparent)}
</style></head><body><div class="win">
<div class="title"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
<div class="menu">${(pt ? ['Arquivo', 'Editar', 'Seleção', 'Exibir', 'Terminal', 'Ajuda'] : ['File', 'Edit', 'Selection', 'View', 'Terminal', 'Help']).map((m) => `<span>${m}</span>`).join('')}</div>
<div class="center">my-project — Visual Studio Code</div><div style="width:200px"></div></div>
<div class="main">
<div class="act">${['files', 'search', 'git', 'run', 'ext'].map((k) => `<div>${icon(ACTIVITY[k])}</div>`).join('')}<div class="on">${icon(ACTIVITY.claude)}</div></div>
<div class="side"><div class="h">CLAUDE HUB</div>
<div class="vh">${icon('<path d="m8 10 4 4 4-4"/>', 16)}${pt ? 'CONTAS' : 'ACCOUNTS'}<span class="ic">${icon('<circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 13-3.5M19 14v6M16 17h6"/>', 16)}${icon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', 16)}${icon('<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M4 4v4h4M20 20v-4h-4"/>', 16)}</span></div>
<iframe src="${pathToFileURL(sidebarFile).href}"></iframe></div>
<div class="ed"><div class="tabs"><div class="tab"><img src="${media('icon.png')}">Claude Hub · ${pt ? 'Métricas' : 'Analytics'}<span style="opacity:.6;margin-left:6px">×</span></div></div>
<iframe src="${pathToFileURL(analyticsFile).href}"></iframe></div>
</div>
<div class="status">${icon('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-10 6"/>', 14)} main
<div class="r"><span>Ln 12, Col 4</span><span>UTF-8</span><span class="acc">${icon('<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>', 14)}${activeLabel} · 76%</span></div></div>
</div></body></html>`;
}

// ---------- sidebar showcase: the panel at its real width, framed on a backdrop ----------

function showcasePage(theme, lang, sidebarFile, height) {
  const pt = lang === 'pt-br';
  const dark = theme === 'dark';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeCss(theme)}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;font-family:var(--vscode-font-family);color:var(--vscode-foreground)}
body{display:grid;place-items:center;background:
 radial-gradient(circle at 15% 10%, ${dark ? 'rgba(224,122,95,.28)' : 'rgba(224,122,95,.22)'}, transparent 45%),
 radial-gradient(circle at 90% 95%, ${dark ? 'rgba(139,92,246,.30)' : 'rgba(139,92,246,.20)'}, transparent 50%),
 ${dark ? '#0d0d10' : '#eef0f5'}}
.panel{width:340px;height:${height}px;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;
 background:var(--vscode-sideBar-background);border:1px solid var(--vscode-border);
 box-shadow:0 30px 60px rgba(0,0,0,${dark ? '.55' : '.18'}),0 0 0 1px rgba(0,0,0,.05)}
.h{height:35px;display:flex;align-items:center;padding:0 20px;font-size:11px;letter-spacing:.4px;opacity:.85}
.vh{height:22px;display:flex;align-items:center;padding:0 8px 0 4px;font-size:11px;font-weight:700}
.vh .ic{margin-left:auto;display:flex;gap:6px;opacity:.8}
iframe{border:0;flex:1;width:100%;display:block}
</style></head><body><div class="panel"><div class="h">CLAUDE HUB</div>
<div class="vh">${icon('<path d="m8 10 4 4 4-4"/>', 16)}${pt ? 'CONTAS' : 'ACCOUNTS'}<span class="ic">${icon('<circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 13-3.5M19 14v6M16 17h6"/>', 16)}${icon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', 16)}${icon('<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M4 4v4h4M20 20v-4h-4"/>', 16)}</span></div>
<iframe src="${pathToFileURL(sidebarFile).href}"></iframe></div></body></html>`;
}

// ---------- render ----------

function browser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome/Edge not found. Set CHROME_PATH.');
  return found;
}

function shoot(html, file, width, height) {
  const page = path.join(work, path.basename(file, '.png') + '-' + Math.random().toString(36).slice(2) + '.html');
  fs.writeFileSync(page, html);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(browser(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${path.join(work, 'profile')}`, '--allow-file-access-from-files',
    '--force-device-scale-factor=2', `--window-size=${width},${height}`, '--virtual-time-budget=6000',
    `--screenshot=${file}`, pathToFileURL(page).href,
  ], { stdio: 'ignore' });
  console.log('  ', path.relative(root, file));
  return page;
}

function writePage(name, html) {
  const file = path.join(work, name);
  fs.writeFileSync(file, html);
  return file;
}

(async () => {
  for (const [lang, dir] of [['en', 'en'], ['pt-br', 'pt-BR']]) {
    console.log(lang);
    const { sidebar, analytics, manager } = buildStates(lang);
    const o = (f) => path.join(out, dir, f);

    // hero: VS Code window with the sidebar + analytics
    const sb = writePage(`sb-${lang}.html`, sidebarPage(sidebar, 'dark'));
    const an = writePage(`an-${lang}.html`, analyticsPage(analytics, 'dark'));
    shoot(heroPage('dark', lang, sb, an, sidebar.profiles[0].label), o('hero.png'), 1440, 880);

    const sbLight = writePage(`sbl-${lang}.html`, sidebarPage(sidebar, 'light'));
    const sbMenu = writePage(`sbm-${lang}.html`, sidebarPage(sidebar, 'dark', { openMenuFor: 'a2' }));
    shoot(showcasePage('dark', lang, sb, 800), o('accounts.png'), 520, 900);
    shoot(showcasePage('light', lang, sbLight, 800), o('accounts-light.png'), 520, 900);
    shoot(showcasePage('dark', lang, sbMenu, 560), o('menu.png'), 520, 660);
    shoot(analyticsPage(analytics, 'dark', { hoverAt: 0.72, range: '30d' }), o('analytics.png'), 1200, 1290);
    shoot(await doctorPage(manager, lang, 'dark'), o('diagnostics.png'), 1000, 780);
  }
  fs.rmSync(work, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
