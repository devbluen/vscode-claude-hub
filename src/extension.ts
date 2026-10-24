import * as vscode from 'vscode';
import { AccountManager } from './manager';
import { AccountsViewProvider } from './view';
import { AnalyticsPanel } from './analytics';
import { DoctorPanel } from './doctor';
import { addAccountIsolated } from './addAccount';
import { effectivePercent, limitLabel, shortLabel } from './usage';

const t = vscode.l10n.t;

export function activate(context: vscode.ExtensionContext) {
  const manager = new AccountManager(context);
  const statusBar = vscode.window.createStatusBarItem('claudeHub.status', vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'Claude Hub';
  statusBar.command = 'claudeHub.switch';

  const updateStatusBar = () => {
    if (!vscode.workspace.getConfiguration('claudeHub').get<boolean>('statusBar', true)) {
      statusBar.hide();
      return;
    }
    const active = manager.activeProfile;
    const windows = (active && manager.usage.get(active.id)?.snapshot?.windows) || [];
    const session = windows.find((w) => w.kind === 'session');
    const max = Math.max(0, ...windows.map((w) => effectivePercent(w)));

    statusBar.text = active
      ? `$(account) ${active.label}${session ? ` · ${effectivePercent(session)}%` : ''}`
      : manager.unsaved
        ? `$(account) ${t('Account not saved')}`
        : '$(account) Claude';
    statusBar.backgroundColor =
      max >= 100
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : max >= vscode.workspace.getConfiguration('claudeHub').get<number>('warnAtPercent', 90)
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    const tip = new vscode.MarkdownString('', true);
    if (active) {
      tip.appendMarkdown(`**${active.label}**  \n${active.email}${active.plan ? ` · ${active.plan}` : ''}\n\n`);
      for (const w of windows) {
        tip.appendMarkdown(`${limitLabel(w.kind, w.scope)}: **${effectivePercent(w)}%**  \n`);
      }
      tip.appendMarkdown('\n');
    }
    tip.appendMarkdown(t('Click to switch accounts'));
    statusBar.tooltip = tip;
    statusBar.show();
  };

  const provider = new AccountsViewProvider(context.extensionUri, manager);

  const usageTimer = () => {
    const minutes = Math.max(1, vscode.workspace.getConfiguration('claudeHub').get<number>('usageRefreshMinutes', 5));
    return setInterval(() => void manager.refreshUsage(), minutes * 60_000);
  };
  let timer = usageTimer();

  context.subscriptions.push(
    manager,
    statusBar,
    manager.onDidChange(updateStatusBar),
    vscode.window.registerWebviewViewProvider('claudeHub.accounts', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('claudeHub.switch', () => quickSwitch(manager)),
    vscode.commands.registerCommand('claudeHub.addAccount', () => addAccountIsolated(manager, context)),
    vscode.commands.registerCommand('claudeHub.saveCurrent', () => manager.saveCurrent()),
    vscode.commands.registerCommand('claudeHub.undo', () => manager.undo()),
    vscode.commands.registerCommand('claudeHub.refreshUsage', () => manager.refreshUsage()),
    vscode.commands.registerCommand('claudeHub.suggest', () => suggest(manager)),
    vscode.commands.registerCommand('claudeHub.openAnalytics', () => AnalyticsPanel.show(context, manager)),
    vscode.commands.registerCommand('claudeHub.doctor', () => DoctorPanel.show(context, manager)),
    vscode.commands.registerCommand('claudeHub.reloadWindow', () =>
      vscode.commands.executeCommand('workbench.action.reloadWindow'),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeHub')) {
        clearInterval(timer);
        timer = usageTimer();
        updateStatusBar();
      }
    }),
    { dispose: () => clearInterval(timer) },
  );

  void manager.refreshActive().then(() => {
    updateStatusBar();
    void manager.refreshUsage();
  });
}

async function quickSwitch(manager: AccountManager) {
  type Item = vscode.QuickPickItem & { id?: string; command?: string };
  const items: Item[] = manager.profiles.map((p) => {
    const windows = manager.usage.get(p.id)?.snapshot?.windows ?? [];
    const active = p.id === manager.activeId;
    const usage = windows.map((w) => `${shortLabel(w.kind, w.scope)} ${effectivePercent(w)}%`).join(' · ');
    return {
      id: p.id,
      label: `${active ? '$(pass-filled)' : p.needsLogin ? '$(warning)' : '$(account)'} ${p.label}`,
      description: [p.plan, usage, active && t('active')].filter(Boolean).join(' · '),
      detail: p.email,
    };
  });
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(sparkle) ${t('Suggest the best account')}`, command: 'claudeHub.suggest' },
    { label: `$(person-add) ${t('Add account…')}`, command: 'claudeHub.addAccount' },
  );
  if (manager.unsaved) {
    items.push({
      label: `$(save) ${t('Save current account')}`,
      description: manager.unsaved.oauthAccount?.emailAddress,
      command: 'claudeHub.saveCurrent',
    });
  }
  const pick = await vscode.window.showQuickPick(items, { title: t('Switch Claude account'), placeHolder: t('Choose an account') });
  if (pick?.command) {
    await vscode.commands.executeCommand(pick.command);
  } else if (pick?.id) {
    await manager.switchTo(pick.id);
  }
}

/** Proposes accounts to switch to, optionally for a model-specific limit (e.g. Fable). */
async function suggest(manager: AccountManager) {
  await manager.refreshUsage();
  const scoped = new Map<string, string>();
  for (const p of manager.profiles) {
    for (const w of manager.usage.get(p.id)?.snapshot?.windows ?? []) {
      if (w.kind !== 'session' && w.kind !== 'weekly_all') scoped.set(w.kind, limitLabel(w.kind, w.scope));
    }
  }
  let focus: string | undefined;
  if (scoped.size) {
    const pick = await vscode.window.showQuickPick(
      [{ label: t('General use'), limit: undefined as string | undefined }, ...[...scoped].map(([limit, label]) => ({ label, limit }))],
      { title: t('Suggest an account for…') },
    );
    if (!pick) return;
    focus = pick.limit;
  }
  const candidates = manager.suggest(focus).slice(0, 3);
  if (!candidates.length) {
    vscode.window.showInformationMessage(t('No other account has capacity available right now.'));
    return;
  }
  const pick = await vscode.window.showQuickPick(
    candidates.map((c, i) => ({ id: c.id, label: `${i === 0 ? '$(star-full)' : '$(account)'} ${c.label}`, detail: c.reason })),
    { title: t('Best accounts to switch to') },
  );
  if (pick) {
    await manager.switchTo(pick.id);
  }
}

export function deactivate() {}
