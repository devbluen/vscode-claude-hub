import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { AccountManager, COLORS } from './manager';
import { effectivePercent, limitLabel } from './usage';
import { webviewStrings } from './i18n';

/** Serializable view of the accounts, shared by the sidebar and the analytics panel. */
export function accountsState(m: AccountManager) {
  const now = Date.now();
  const active = m.activeProfile;
  const activeMax = active
    ? Math.max(0, ...(m.usage.get(active.id)?.snapshot?.windows ?? []).map((w) => effectivePercent(w, now)))
    : 100;
  const best = activeMax >= 70 ? m.suggest()[0] : undefined;
  return m.profiles.map((p) => {
    const info = m.usage.get(p.id);
    return {
      id: p.id,
      label: p.label,
      color: p.color,
      email: p.email,
      orgName: p.orgName,
      plan: p.plan,
      needsLogin: !!p.needsLogin,
      active: p.id === m.activeId,
      best: best?.id === p.id ? best.reason : undefined,
      status: info?.status,
      error: info?.error,
      fetchedAt: info?.snapshot?.fetchedAt,
      breakdown: info?.snapshot?.breakdown,
      windows: (info?.snapshot?.windows ?? []).map((w) => ({
        kind: w.kind,
        label: limitLabel(w.kind, w.scope),
        percent: effectivePercent(w, now),
        resetsAt: w.resetsAt,
      })),
    };
  });
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, css: string[], scripts: string[], bodyClass: string): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
  return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${css.map((c) => `<link rel="stylesheet" href="${media(c)}">`).join('\n')}
</head>
<body class="${bodyClass} intro">
<div id="app"></div>
${scripts.map((s) => `<script nonce="${nonce}" src="${media(s)}"></script>`).join('\n')}
</body>
</html>`;
}

export class AccountsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: AccountManager,
  ) {
    manager.onDidChange(() => void this.post());
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = webviewHtml(view.webview, this.extensionUri, ['view.css'], ['morph.js', 'view.js'], 'sidebar');

    view.webview.onDidReceiveMessage(async (msg) => {
      const m = this.manager;
      switch (msg.type) {
        case 'ready':
          await this.post();
          void m.refreshUsage();
          break;
        case 'switch':
          try {
            await m.switchTo(msg.id);
          } catch (err) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not switch accounts: {0}', (err as Error).message));
          } finally {
            await view.webview.postMessage({ type: 'switchDone' });
          }
          break;
        case 'rename':
          await m.rename(msg.id);
          break;
        case 'color':
          await m.setColor(msg.id, msg.color);
          break;
        case 'move':
          await m.move(msg.id, msg.delta);
          break;
        case 'remove':
          await m.remove(msg.id);
          break;
        case 'usage':
          await m.refreshUsage(msg.id);
          break;
        case 'command':
          if (typeof msg.command === 'string' && msg.command.startsWith('claudeSwitch.')) {
            await vscode.commands.executeCommand(msg.command);
          }
          break;
      }
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.post();
      }
    });
  }

  private async post() {
    if (!this.view) {
      return;
    }
    const m = this.manager;
    const unsaved = m.unsaved?.oauthAccount;
    await this.view.webview.postMessage({
      type: 'state',
      state: {
        profiles: accountsState(m),
        unsaved: unsaved ? { email: unsaved.emailAddress, name: unsaved.displayName } : null,
        canUndo: await m.canUndo(),
        needsReload: m.needsReload,
        colors: COLORS,
        showUsage: vscode.workspace.getConfiguration('claudeSwitch').get<boolean>('showUsage', true),
        locale: vscode.env.language,
        strings: webviewStrings(),
      },
    });
  }
}
