// Minimal stand-in for the `vscode` module, so the compiled extension code (labels,
// ranking, view state, diagnostics HTML) can run in plain Node to build screenshots.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..', '..');
const bundles = {
  en: {},
  'pt-br': JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'bundle.l10n.pt-br.json'), 'utf8')),
};
let lang = 'en';

// Like VS Code: placeholders without a value are kept (webview strings are formatted later).
const fmt = (s, args) => String(s).replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] === undefined ? m : String(args[Number(i)])));

const Uri = {
  file: (p) => ({ fsPath: p }),
  joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }),
};

let captured = '';
const stub = {
  l10n: { t: (s, ...args) => fmt(bundles[lang][s] ?? s, args) },
  env: { get language() { return lang; } },
  Uri,
  ViewColumn: { Active: -1 },
  ThemeIcon: class {},
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  extensions: { getExtension: () => undefined, all: [] },
  window: {
    createWebviewPanel: () => {
      const webview = {
        cspSource: '',
        set html(v) { captured = v; },
        get html() { return captured; },
        asWebviewUri: (u) => pathToFileURL(u.fsPath).href,
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async () => true,
      };
      return { webview, onDidDispose: () => ({ dispose() {} }), reveal() {} };
    },
  },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? stub : load.call(this, request, ...rest);
};

module.exports = {
  root,
  setLanguage: (l) => (lang = l),
  getCapturedHtml: () => captured,
};
