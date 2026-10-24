import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readCurrentLogin } from './claudeFiles';
import { fetchProfile } from './api';
import { AccountManager } from './manager';
import { findCli, needsShell } from './cli';

const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Signs a new account in inside a temporary folder (CLAUDE_CONFIG_DIR), without touching
 * the current login. When the login finishes, the account is imported.
 */
export async function addAccountIsolated(manager: AccountManager, context: vscode.ExtensionContext): Promise<void> {
  if (process.platform === 'darwin') {
    await addAccountManual(manager);
    return;
  }
  const cli = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Looking for the Claude CLI…') },
    () => findCli(),
  );
  if (!cli) {
    const doctor = vscode.l10n.t('Run diagnostics');
    const manual = vscode.l10n.t('Do it manually');
    const choice = await vscode.window.showErrorMessage(
      vscode.l10n.t('The "claude" executable was not found. Diagnostics can install it or locate it for you.'),
      doctor,
      manual,
    );
    if (choice === doctor) {
      await vscode.commands.executeCommand('claudeHub.doctor');
    } else if (choice === manual) {
      await addAccountManual(manager);
    }
    return;
  }

  const dir = path.join(context.globalStorageUri.fsPath, `login-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  const args = ['auth', 'login', '--claudeai'];
  const terminal = vscode.window.createTerminal({
    name: vscode.l10n.t('Claude · new account'),
    shellPath: needsShell(cli.path) ? 'cmd.exe' : cli.path,
    shellArgs: needsShell(cli.path) ? ['/d', '/c', cli.path, ...args] : args,
    env: { CLAUDE_CONFIG_DIR: dir },
    iconPath: new vscode.ThemeIcon('person-add'),
    isTransient: true,
  });
  terminal.show();

  try {
    const snap = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Waiting for the new account to sign in…'),
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({
          message: vscode.l10n.t('Finish signing in in the browser. Tip: if the browser is signed in to another account, switch there before authorizing.'),
        });
        let terminalClosed = false;
        const sub = vscode.window.onDidCloseTerminal((t) => {
          if (t === terminal) {
            terminalClosed = true;
          }
        });
        try {
          const started = Date.now();
          let closedAt = 0;
          while (!token.isCancellationRequested && Date.now() - started < LOGIN_TIMEOUT_MS) {
            const login = await readCurrentLogin(dir);
            if (login) {
              // Give the CLI a moment to write the account data.
              for (let i = 0; i < 6 && !login.oauthAccount?.accountUuid; i++) {
                await new Promise((r) => setTimeout(r, 500));
                login.oauthAccount = (await readCurrentLogin(dir))?.oauthAccount;
              }
              return login;
            }
            if (terminalClosed) {
              closedAt ||= Date.now();
              if (Date.now() - closedAt > 3000) {
                return undefined;
              }
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          return undefined;
        } finally {
          sub.dispose();
        }
      },
    );

    if (!snap) {
      vscode.window.showWarningMessage(vscode.l10n.t('Sign-in cancelled or not finished. No account was added.'));
      return;
    }
    if (!snap.oauthAccount?.accountUuid) {
      snap.oauthAccount = await fetchProfile(snap.claudeAiOauth.accessToken);
    }
    snap.organizationUuid ??= snap.oauthAccount.organizationUuid;

    const { profile, isNew } = await manager.saveLogin(snap);
    void manager.refreshUsage(profile.id);
    const useNow = vscode.l10n.t('Use now');
    const choice = await vscode.window.showInformationMessage(
      isNew
        ? vscode.l10n.t('Account "{0}" ({1}) added.', profile.label, profile.email)
        : vscode.l10n.t('Account "{0}" already existed — login updated.', profile.label),
      useNow,
    );
    if (choice === useNow) {
      await manager.switchTo(profile.id);
    }
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Could not add the account: {0}', (err as Error).message));
  } finally {
    terminal.dispose();
    fs.rm(dir, { recursive: true, force: true }, () => undefined);
  }
}

/** Fallback without the CLI: save the current account and guide the user through /login. */
async function addAccountManual(manager: AccountManager): Promise<void> {
  const current = await readCurrentLogin();
  if (current) {
    await manager.saveLogin(current);
  }
  await vscode.window.showInformationMessage(
    vscode.l10n.t('Current account saved. Now, in Claude Code, run /login (do NOT use /logout) and sign in with the other account. It will show up here to be saved.'),
    { modal: true },
  );
}
