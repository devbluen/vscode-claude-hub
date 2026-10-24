import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { credentialsPath, globalConfigPath, readCurrentLogin, usesKeychain } from './claudeFiles';
import { fetchUsage } from './api';
import { AccountManager } from './manager';
import { CliSource, POWERSHELL, addDirToUserPath, cliVersion, findAllCli, installCommand, isDirOnPath } from './cli';

type Status = 'ok' | 'warn' | 'error' | 'info';

interface Action {
  label: string;
  run: string;
  arg?: string;
}

interface Check {
  status: Status;
  title: string;
  detail: string;
  actions: Action[];
}

const t = vscode.l10n.t;
const isWin = process.platform === 'win32';
const KNOWN_CONFLICTS = ['account-manager-for-claude', 'claude-account', 'claude-switcher'];

function sourceLabel(source: CliSource): string {
  switch (source) {
    case 'setting':
      return t('from settings');
    case 'path':
      return t('on PATH');
    case 'installer':
      return t('native installer');
    case 'npm':
      return t('npm global');
    case 'extension':
      return t('bundled with the Claude Code extension');
  }
}

async function cliChecks(): Promise<Check[]> {
  const all = await findAllCli();
  const working: Array<{ path: string; source: CliSource; version: string }> = [];
  for (const c of all) {
    const version = await cliVersion(c.path);
    if (version) working.push({ ...c, version });
  }
  const guide: Action = { label: t('Step-by-step guide'), run: 'guide' };

  if (!working.length) {
    return [
      {
        status: 'error',
        title: t('Claude Code CLI not found'),
        detail: t('It is only needed to add accounts. Install it with one click, or point to the executable if it is already installed somewhere else.'),
        actions: [
          { label: t('Install the CLI'), run: 'installCli' },
          { label: t('Locate executable…'), run: 'pickCli' },
          guide,
        ],
      },
    ];
  }

  const best = working[0];
  const checks: Check[] = [
    {
      status: 'ok',
      title: t('Claude CLI found'),
      detail: `${best.path}\n${best.version} · ${sourceLabel(best.source)}`,
      actions: working.length > 1 ? [{ label: t('Choose another…'), run: 'chooseCli' }] : [],
    },
  ];

  const onPath = working.some((w) => w.source === 'path');
  if (!onPath) {
    const stable = working.find((w) => w.source === 'installer' || w.source === 'npm');
    if (stable && isWin) {
      checks.push({
        status: 'warn',
        title: t('The "claude" command is not on your PATH'),
        detail: t('This extension finds it anyway. To type "claude" in any terminal, its folder must be on the PATH: {0}', path.dirname(stable.path)),
        actions: [{ label: t('Add to PATH'), run: 'addPath', arg: path.dirname(stable.path) }, guide],
      });
    } else if (stable) {
      checks.push({
        status: 'warn',
        title: t('The "claude" command is not on your PATH'),
        detail: t('This extension finds it anyway. To type "claude" in a terminal, add {0} to the PATH in your shell profile.', path.dirname(stable.path)),
        actions: [guide],
      });
    } else {
      checks.push({
        status: 'warn',
        title: t('Only the copy inside the Claude Code extension was found'),
        detail: t('It works for adding accounts, but its folder changes on every extension update and the "claude" command is not available in terminals. Installing the CLI fixes both.'),
        actions: [{ label: t('Install the CLI'), run: 'installCli' }, guide],
      });
    }
  } else if (isWin && !(process.env.PATH ?? '').toLowerCase().includes(path.dirname(best.path).toLowerCase())) {
    checks.push({
      status: 'info',
      title: t('VS Code is running with an old PATH'),
      detail: t('"claude" is on your PATH, but VS Code was opened before that. Fully close and reopen VS Code so its terminals see it.'),
      actions: [],
    });
  }
  return checks;
}

async function loginChecks(manager: AccountManager): Promise<Check[]> {
  const checks: Check[] = [];
  const current = await readCurrentLogin();
  const where = usesKeychain() ? t('macOS Keychain') : credentialsPath();

  if (!current) {
    checks.push({
      status: 'error',
      title: t('Not signed in to Claude Code'),
      detail: t('No login found in {0}. Open Claude Code, sign in, and run the diagnostics again.', where),
      actions: [{ label: t('Run again'), run: 'rerun' }],
    });
  } else {
    const email = current.oauthAccount?.emailAddress ?? '?';
    checks.push({
      status: current.oauthAccount ? 'ok' : 'warn',
      title: t('Signed in to Claude Code as {0}', email),
      detail: current.oauthAccount
        ? `${where}\n${globalConfigPath()}`
        : t('The account data in {0} is missing. Open Claude Code once so it fills it in.', globalConfigPath()),
      actions: [],
    });

    if (current.claudeAiOauth.expiresAt > Date.now()) {
      try {
        await fetchUsage(current.claudeAiOauth.accessToken);
        checks.push({ status: 'ok', title: t('Usage API reachable'), detail: 'api.anthropic.com', actions: [] });
      } catch (err) {
        checks.push({
          status: 'warn',
          title: t('Usage API not reachable'),
          detail: t('{0}. Switching still works; only the usage bars are affected.', (err as Error).message),
          actions: [],
        });
      }
    } else {
      checks.push({
        status: 'info',
        title: t('Access token is resting'),
        detail: t('Claude Code renews it the next time you use it.'),
        actions: [],
      });
    }
  }

  const profiles = manager.profiles;
  if (manager.unsaved) {
    checks.push({
      status: 'warn',
      title: t('The current account is not saved'),
      detail: manager.unsaved.oauthAccount?.emailAddress ?? '',
      actions: [{ label: t('Save current account'), run: 'saveCurrent' }],
    });
  }
  checks.push({
    status: profiles.length > 1 ? 'ok' : 'info',
    title: t('{0} saved account(s)', profiles.length),
    detail: profiles.length > 1 ? profiles.map((p) => p.label).join(', ') : t('Add at least two accounts to switch between them.'),
    actions: profiles.length > 1 ? [] : [{ label: t('Add account'), run: 'addAccount' }],
  });
  const expired = profiles.filter((p) => p.needsLogin);
  if (expired.length) {
    checks.push({
      status: 'warn',
      title: t('Expired logins'),
      detail: t('{0}: add these accounts again to sign them back in.', expired.map((p) => p.label).join(', ')),
      actions: [{ label: t('Add account'), run: 'addAccount' }],
    });
  }
  return checks;
}

function environmentChecks(): Check[] {
  const checks: Check[] = [];
  const conflicts = vscode.extensions.all.filter(
    (e) => e.id !== 'devbluen.claude-switch' && KNOWN_CONFLICTS.some((k) => e.id.toLowerCase().includes(k)),
  );
  for (const ext of conflicts) {
    checks.push({
      status: 'warn',
      title: t('Another account switcher is installed: {0}', ext.packageJSON?.displayName ?? ext.id),
      detail: t('Both write the same Claude Code files. Keep only one of them enabled.'),
      actions: [{ label: t('Show extension'), run: 'showExtension', arg: ext.id }],
    });
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    checks.push({
      status: 'info',
      title: t('CLAUDE_CONFIG_DIR is set'),
      detail: t('Using the Claude Code config in {0}.', process.env.CLAUDE_CONFIG_DIR),
      actions: [],
    });
  }
  return checks;
}

function guideHtml(): string {
  const install = installCommand();
  const steps = isWin
    ? [
        [t('Check'), t('Open a NEW terminal (PowerShell) and run the command below. If it prints a version, everything is fine. If it says "not recognized", continue.'), 'claude --version'],
        [t('Install'), t('Install the CLI with the official installer (PowerShell):'), install],
        [t('Find the folder'), t('The installer puts claude.exe here. Check that the file exists:'), 'Test-Path "$env:USERPROFILE\\.local\\bin\\claude.exe"'],
        [t('Add to PATH (automatic)'), t('Click "Add to PATH" above, or run this in PowerShell:'), "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';' + \"$env:USERPROFILE\\.local\\bin\", 'User')"],
        [t('Add to PATH (manual)'), t('Press Win+R, run "sysdm.cpl" → Advanced → Environment Variables → under "User variables" select Path → Edit → New → paste the folder below → OK on every window.'), '%USERPROFILE%\\.local\\bin'],
        [t('Restart'), t('Close ALL VS Code windows and open it again. Programs only read the PATH when they start.'), ''],
        [t('Verify'), t('In a new terminal:'), 'where.exe claude'],
      ]
    : [
        [t('Check'), t('Open a new terminal and run:'), 'claude --version'],
        [t('Install'), t('Install the CLI with the official installer:'), install],
        [t('Add to PATH'), t('If "claude" is still not found, add the folder to your shell profile (zsh shown; use ~/.bashrc for bash):'), 'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zshrc'],
        [t('Restart'), t('Close and reopen VS Code and your terminals.'), ''],
        [t('Verify'), t('In a new terminal:'), 'which claude'],
      ];
  const esc = escapeHtml;
  return steps
    .map(
      ([title, text, cmd], i) => `<li><div class="step-n">${i + 1}</div><div class="step-body"><b>${esc(title)}</b><p>${esc(text)}</p>${
        cmd ? `<div class="cmd"><code>${esc(cmd)}</code><button class="btn ghost sm" data-run="copy" data-arg="${esc(cmd)}">${esc(t('Copy'))}</button></div>` : ''
      }</div></li>`,
    )
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const ICONS: Record<Status, string> = {
  ok: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  warn: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};

export class DoctorPanel {
  private static current: DoctorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext, manager: AccountManager, openGuide = false) {
    if (DoctorPanel.current) {
      DoctorPanel.current.panel.reveal();
      void DoctorPanel.current.render(openGuide);
      return;
    }
    DoctorPanel.current = new DoctorPanel(context, manager, openGuide);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: AccountManager,
    openGuide: boolean,
  ) {
    this.panel = vscode.window.createWebviewPanel('claudeSwitch.doctor', t('Claude Switch · Diagnostics'), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    this.panel.onDidDispose(() => (DoctorPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((m) => void this.handle(m.run, m.arg));
    void this.render(openGuide);
  }

  private async handle(run: string, arg?: string) {
    switch (run) {
      case 'rerun':
        return this.render();
      case 'guide':
        return this.panel.webview.postMessage({ type: 'openGuide' });
      case 'copy':
        await vscode.env.clipboard.writeText(arg ?? '');
        vscode.window.setStatusBarMessage(t('Copied to clipboard'), 2000);
        return;
      case 'saveCurrent':
        await this.manager.saveCurrent();
        return this.render();
      case 'addAccount':
        return vscode.commands.executeCommand('claudeSwitch.addAccount');
      case 'showExtension':
        return vscode.commands.executeCommand('workbench.extensions.search', `@id:${arg}`);
      case 'pickCli':
        return this.pickCli();
      case 'chooseCli':
        return this.chooseCli();
      case 'installCli':
        return this.installCli();
      case 'addPath':
        return this.addPath(arg!);
    }
  }

  private async pickCli() {
    const picked = await vscode.window.showOpenDialog({
      title: t('Select the claude executable'),
      canSelectMany: false,
      filters: isWin ? { [t('Executable')]: ['exe', 'cmd'] } : undefined,
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    if (!(await cliVersion(file))) {
      vscode.window.showErrorMessage(t('This file did not answer to "--version". Is it the Claude Code CLI?'));
      return;
    }
    await vscode.workspace.getConfiguration('claudeSwitch').update('cliPath', file, vscode.ConfigurationTarget.Global);
    await this.render();
  }

  private async chooseCli() {
    const items = (await findAllCli()).map((c) => ({ label: c.path, description: sourceLabel(c.source) }));
    const pick = await vscode.window.showQuickPick(items, { title: t('Which claude executable should be used?') });
    if (pick) {
      await vscode.workspace.getConfiguration('claudeSwitch').update('cliPath', pick.label, vscode.ConfigurationTarget.Global);
      await this.render();
    }
  }

  private async installCli() {
    const cmd = installCommand();
    const run = t('Install');
    const ok = await vscode.window.showInformationMessage(
      t('Install the Claude Code CLI?'),
      { modal: true, detail: t('A terminal will run the official installer:\n{0}', cmd) },
      run,
    );
    if (ok !== run) return;
    const terminal = vscode.window.createTerminal({
      name: t('Install Claude CLI'),
      shellPath: isWin ? POWERSHELL : undefined,
      iconPath: new vscode.ThemeIcon('cloud-download'),
    });
    terminal.show();
    terminal.sendText(cmd);
    const again = t('Run again');
    const choice = await vscode.window.showInformationMessage(t('When the installation finishes, run the diagnostics again.'), again);
    if (choice === again) await this.render();
  }

  private async addPath(dir: string) {
    const add = t('Add to PATH');
    const ok = await vscode.window.showInformationMessage(
      t('Add this folder to your user PATH?'),
      { modal: true, detail: dir },
      add,
    );
    if (ok !== add) return;
    try {
      await addDirToUserPath(dir);
      const ok2 = await isDirOnPath(dir);
      vscode.window.showInformationMessage(
        ok2
          ? t('Done. Fully close and reopen VS Code (and any terminal) to use the "claude" command.')
          : t('The PATH was updated, but the folder could not be confirmed. Check it with the guide.'),
      );
    } catch (err) {
      vscode.window.showErrorMessage(t('Could not update the PATH: {0}', (err as Error).message));
    }
    await this.render();
  }

  private async render(openGuide = false) {
    const webview = this.panel.webview;
    webview.html = this.shell(webview, `<div class="loading"><span class="spinner"></span>${escapeHtml(t('Checking…'))}</div>`, false);
    const checks = [
      ...(await cliChecks()),
      ...(await loginChecks(this.manager)),
      ...environmentChecks(),
    ];
    const problems = checks.filter((c) => c.status === 'error' || c.status === 'warn').length;
    const summary = problems
      ? `<div class="summary warn">${svg(ICONS.warn)}<div><b>${escapeHtml(t('{0} item(s) need attention', problems))}</b><span>${escapeHtml(t('Use the buttons next to each item to fix it.'))}</span></div></div>`
      : `<div class="summary ok">${svg(ICONS.ok)}<div><b>${escapeHtml(t('Everything looks good'))}</b><span>${escapeHtml(t('Claude Switch is ready to use.'))}</span></div></div>`;
    const list = checks
      .map(
        (c) => `<div class="check ${c.status}">
          <div class="check-icon">${svg(ICONS[c.status])}</div>
          <div class="check-body"><b>${escapeHtml(c.title)}</b><p>${escapeHtml(c.detail).replace(/\n/g, '<br>')}</p>
          ${c.actions.length ? `<div class="check-actions">${c.actions.map((a, i) => `<button class="btn ${i === 0 ? 'primary' : 'ghost'} sm" data-run="${a.run}" data-arg="${escapeHtml(a.arg ?? '')}">${escapeHtml(a.label)}</button>`).join('')}</div>` : ''}
          </div></div>`,
      )
      .join('');
    const body = `${summary}<div class="checks">${list}</div>
      <details id="guide" ${openGuide ? 'open' : ''}><summary>${escapeHtml(t('Step-by-step: making the "claude" command work'))}</summary><ol class="steps">${guideHtml()}</ol></details>
      <div class="foot"><button class="btn ghost" data-run="rerun">${escapeHtml(t('Run again'))}</button></div>`;
    webview.html = this.shell(webview, body, true);
  }

  private shell(webview: vscode.Webview, body: string, withScript: boolean): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css'));
    const script = withScript
      ? `<script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          document.addEventListener('click', (e) => {
            const b = e.target.closest('[data-run]');
            if (b) vscode.postMessage({ run: b.dataset.run, arg: b.dataset.arg });
          });
          window.addEventListener('message', (e) => {
            if (e.data.type === 'openGuide') { const g = document.getElementById('guide'); g.open = true; g.scrollIntoView({ behavior: 'smooth' }); }
          });
        </script>`
      : '';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="stylesheet" href="${css}"></head>
      <body class="doctor"><header><h1>${escapeHtml(t('Diagnostics'))}</h1><p>${escapeHtml(t('Checks everything Claude Switch needs and fixes what it can.'))}</p></header>${body}${script}</body></html>`;
  }
}

function svg(d: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}
