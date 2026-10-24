import * as vscode from 'vscode';
import { AccountManager } from './manager';
import { accountsState, webviewHtml } from './view';
import { webviewStrings } from './i18n';
import { limitLabel } from './usage';

export class AnalyticsPanel {
  private static current: AnalyticsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];
  private postTimer: NodeJS.Timeout | undefined;

  static show(context: vscode.ExtensionContext, manager: AccountManager) {
    if (AnalyticsPanel.current) {
      AnalyticsPanel.current.panel.reveal();
      return;
    }
    AnalyticsPanel.current = new AnalyticsPanel(context, manager);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: AccountManager,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'claudeSwitch.analytics',
      vscode.l10n.t('Claude Switch · Analytics'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = webviewHtml(this.panel.webview, context.extensionUri, ['panel.css'], ['morph.js', 'analytics.js'], 'analytics');

    this.subs.push(
      manager.onDidChange(() => this.schedulePost()),
      this.panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ready') {
          await this.post();
          void manager.refreshUsage();
        } else if (msg.type === 'switch') {
          await manager.switchTo(msg.id);
        } else if (msg.type === 'refresh') {
          await manager.refreshUsage();
        }
      }),
    );
    this.panel.onDidDispose(() => {
      AnalyticsPanel.current = undefined;
      clearTimeout(this.postTimer);
      this.subs.forEach((s) => s.dispose());
    });
  }

  private schedulePost() {
    clearTimeout(this.postTimer);
    this.postTimer = setTimeout(() => void this.post(), 300);
  }

  private async post() {
    const m = this.manager;
    const accounts = accountsState(m).map((a) => ({ ...a, history: m.history.get(a.id) }));

    // Every limit seen in the current data or the history, in display order.
    const kinds = new Map<string, string>();
    for (const p of m.profiles) {
      for (const w of m.usage.get(p.id)?.snapshot?.windows ?? []) kinds.set(w.kind, limitLabel(w.kind, w.scope));
    }
    for (const a of accounts) {
      for (const point of a.history) for (const k of Object.keys(point.w)) if (!kinds.has(k)) kinds.set(k, limitLabel(k));
    }
    const rank = (k: string) => (k === 'session' ? 0 : k === 'weekly_all' ? 1 : 2);

    await this.panel.webview.postMessage({
      type: 'state',
      state: {
        accounts,
        kinds: [...kinds].map(([kind, label]) => ({ kind, label })).sort((a, b) => rank(a.kind) - rank(b.kind)),
        locale: vscode.env.language,
        strings: webviewStrings(),
      },
    });
  }
}
