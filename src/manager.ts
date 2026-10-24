import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import {
  LoginSnapshot,
  applyLogin,
  credentialsPath,
  globalConfigPath,
  identityOf,
  planLabel,
  readCurrentLogin,
  usesKeychain,
} from './claudeFiles';
import { ApiError, fetchUsage, refreshTokens } from './api';
import { UsageSnapshot } from './usage';
import { UsageHistory } from './history';
import { LimitNotifier } from './notifier';
import { Candidate, rankAccounts } from './suggest';

export interface Profile {
  id: string;
  identity: string;
  label: string;
  color: string;
  email: string;
  name?: string;
  orgName?: string;
  plan?: string;
  createdAt: number;
  updatedAt: number;
  /** The saved login was rejected; the account must be added again. */
  needsLogin?: boolean;
}

export interface UsageInfo {
  /** ok = fresh; stale = last known values (token resting or not checked yet). */
  status: 'ok' | 'stale' | 'loading' | 'error';
  snapshot?: UsageSnapshot;
  error?: string;
}

export const COLORS = ['#E07A5F', '#8B5CF6', '#3B82F6', '#14B8A6', '#22C55E', '#F59E0B', '#EC4899', '#64748B'];

const PROFILES_KEY = 'claudeHub.profiles';
const USAGE_KEY = 'claudeHub.usage';
const SECRET_PREFIX = 'claudeHub.login.';
const UNDO_KEY = 'claudeHub.undo';
/** Refresh a resting token this long before it expires. */
const EXPIRY_MARGIN_MS = 2 * 60_000;

export class AccountManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  activeId: string | undefined;
  /** Current login that is not saved as an account yet. */
  unsaved: LoginSnapshot | undefined;
  needsReload = false;
  readonly usage = new Map<string, UsageInfo>();
  readonly history: UsageHistory;

  private readonly notifier: LimitNotifier;
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private busy = false;
  private usageRun: Promise<void> | undefined;
  /** Serializes token work per account (refresh vs. switch). */
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.history = new UsageHistory(context.globalStorageUri.fsPath);
    const saved = context.globalState.get<Record<string, UsageSnapshot>>(USAGE_KEY, {});
    for (const [id, snapshot] of Object.entries(saved)) {
      this.usage.set(id, { status: 'stale', snapshot });
    }
    this.notifier = new LimitNotifier({
      labelOf: (id) => this.profiles.find((p) => p.id === id)?.label ?? '?',
      isActive: (id) => id === this.activeId,
      bestAlternative: (id) => this.suggest().find((c) => c.id !== id),
      switchTo: (id) => this.switchTo(id),
      recheck: (id) => void this.refreshUsage(id),
    });
    this.watch();
  }

  get profiles(): Profile[] {
    return this.context.globalState.get<Profile[]>(PROFILES_KEY, []);
  }

  private async setProfiles(list: Profile[]) {
    await this.context.globalState.update(PROFILES_KEY, list);
  }

  private async patchProfile(id: string, patch: Partial<Profile>) {
    const list = this.profiles;
    const p = list.find((x) => x.id === id);
    if (p) {
      Object.assign(p, patch);
      await this.setProfiles(list);
    }
  }

  get activeProfile(): Profile | undefined {
    return this.profiles.find((p) => p.id === this.activeId);
  }

  async canUndo(): Promise<boolean> {
    return !!(await this.context.secrets.get(UNDO_KEY));
  }

  private async getLogin(id: string): Promise<LoginSnapshot | undefined> {
    const raw = await this.context.secrets.get(SECRET_PREFIX + id);
    return raw ? JSON.parse(raw) : undefined;
  }

  private async storeLogin(id: string, snap: LoginSnapshot) {
    await this.context.secrets.store(SECRET_PREFIX + id, JSON.stringify(snap));
  }

  private withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(task, task);
    this.locks.set(id, run.catch(() => undefined));
    return run;
  }

  /** Watches Claude Code's files to follow token refreshes and logins made elsewhere. */
  private watch() {
    const onChange = () => {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => void this.refreshActive(), 1500);
    };
    const files = usesKeychain() ? [globalConfigPath()] : [credentialsPath(), globalConfigPath()];
    for (const file of files) {
      fs.watchFile(file, { interval: 2000 }, onChange);
      this.disposables.push({ dispose: () => fs.unwatchFile(file, onChange) });
    }
    if (usesKeychain()) {
      const timer = setInterval(onChange, 15_000);
      this.disposables.push({ dispose: () => clearInterval(timer) });
    }
  }

  /** Finds out which account is active and keeps its latest tokens. */
  async refreshActive(): Promise<void> {
    if (this.busy) {
      return;
    }
    const current = await readCurrentLogin();
    const identity = current && identityOf(current);
    const match = identity ? this.profiles.find((p) => p.identity === identity) : undefined;

    if (current && match) {
      const saved = await this.getLogin(match.id);
      if (
        saved?.claudeAiOauth.refreshToken !== current.claudeAiOauth.refreshToken ||
        saved?.claudeAiOauth.accessToken !== current.claudeAiOauth.accessToken
      ) {
        await this.storeLogin(match.id, current);
        if (match.needsLogin) {
          await this.patchProfile(match.id, { needsLogin: false });
        }
      }
    }

    const prevActive = this.activeId;
    const prevUnsaved = this.unsaved && identityOf(this.unsaved);
    this.activeId = match?.id;
    this.unsaved = current && !match && identity ? current : undefined;
    if (prevActive !== this.activeId || prevUnsaved !== (this.unsaved && identityOf(this.unsaved))) {
      this.changed.fire();
    }
  }

  /** Saves (or updates) a login as an account. */
  async saveLogin(snap: LoginSnapshot, label?: string): Promise<{ profile: Profile; isNew: boolean }> {
    const identity = identityOf(snap);
    if (!identity || !snap.oauthAccount) {
      throw new Error(vscode.l10n.t('Could not identify the account (account data missing).'));
    }
    const account = snap.oauthAccount;
    const list = this.profiles;
    let profile = list.find((p) => p.identity === identity);
    const isNew = !profile;
    const now = Date.now();
    const info = {
      email: account.emailAddress,
      name: account.displayName || account.fullName || undefined,
      orgName: account.organizationName || undefined,
      plan: planLabel(snap.claudeAiOauth),
      updatedAt: now,
      needsLogin: false,
    };
    if (profile) {
      Object.assign(profile, info);
    } else {
      const used = new Set(list.map((p) => p.color));
      profile = {
        id: randomUUID(),
        identity,
        label: label || account.displayName || account.emailAddress.split('@')[0],
        color: COLORS.find((c) => !used.has(c)) ?? COLORS[list.length % COLORS.length],
        createdAt: now,
        ...info,
      };
      list.push(profile);
    }
    await this.withLock(profile.id, () => this.storeLogin(profile!.id, snap));
    await this.setProfiles(list);
    await this.refreshActive();
    this.changed.fire();
    return { profile, isNew };
  }

  async saveCurrent(): Promise<Profile | undefined> {
    const current = await readCurrentLogin();
    if (!current) {
      vscode.window.showWarningMessage(vscode.l10n.t('No Claude Code login found. Sign in to Claude Code first.'));
      return undefined;
    }
    const { profile, isNew } = await this.saveLogin(current);
    vscode.window.showInformationMessage(
      isNew ? vscode.l10n.t('Account "{0}" saved.', profile.label) : vscode.l10n.t('Account "{0}" updated.', profile.label),
    );
    void this.refreshUsage(profile.id);
    return profile;
  }

  async switchTo(id: string): Promise<void> {
    const target = this.profiles.find((p) => p.id === id);
    if (!target) {
      vscode.window.showErrorMessage(vscode.l10n.t('Account not found.'));
      return;
    }
    if (id === this.activeId) {
      return;
    }
    if (target.needsLogin) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('The saved login of "{0}" has expired. Add the account again to sign in.', target.label),
      );
      return;
    }

    await this.refreshActive();
    const current = await readCurrentLogin();
    if (current) {
      // Keep the outgoing account, so a refreshed token is not lost.
      if (identityOf(current) && !this.profiles.some((p) => p.identity === identityOf(current))) {
        await this.saveLogin(current);
      }
      await this.context.secrets.store(UNDO_KEY, JSON.stringify(current));
    }

    // Waits for a token refresh of this account that may be in flight.
    await this.withLock(id, async () => {
      const snap = await this.getLogin(id);
      if (!snap) {
        throw new Error(vscode.l10n.t('Account not found.'));
      }
      this.busy = true;
      try {
        await applyLogin(snap);
      } finally {
        this.busy = false;
      }
    });
    await this.refreshActive();
    this.needsReload = true;
    this.changed.fire();
    await this.afterSwitch(vscode.l10n.t('Now using "{0}".', target.label));
  }

  async undo(): Promise<void> {
    const raw = await this.context.secrets.get(UNDO_KEY);
    if (!raw) {
      vscode.window.showInformationMessage(vscode.l10n.t('There is no switch to undo.'));
      return;
    }
    const previous: LoginSnapshot = JSON.parse(raw);
    const current = await readCurrentLogin();
    this.busy = true;
    try {
      await applyLogin(previous);
    } finally {
      this.busy = false;
    }
    if (current) {
      await this.context.secrets.store(UNDO_KEY, JSON.stringify(current));
    } else {
      await this.context.secrets.delete(UNDO_KEY);
    }
    await this.refreshActive();
    this.needsReload = true;
    this.changed.fire();
    await this.afterSwitch(
      vscode.l10n.t('Switch undone: back to {0}.', previous.oauthAccount?.emailAddress ?? vscode.l10n.t('the previous account')),
    );
  }

  private async afterSwitch(message: string) {
    const mode = vscode.workspace.getConfiguration('claudeHub').get<string>('afterSwitch', 'ask');
    if (mode === 'reload') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    if (mode === 'ask') {
      const reload = vscode.l10n.t('Reload now');
      const choice = await vscode.window.showInformationMessage(
        `${message} ${vscode.l10n.t('Reload the window so Claude Code uses the new account.')}`,
        reload,
      );
      if (choice === reload) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }
  }

  async rename(id: string): Promise<void> {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) {
      return;
    }
    const label = await vscode.window.showInputBox({
      title: vscode.l10n.t('Rename account'),
      value: profile.label,
      prompt: profile.email,
      validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('The name cannot be empty')),
    });
    if (label?.trim()) {
      await this.patchProfile(id, { label: label.trim() });
      this.changed.fire();
    }
  }

  async setColor(id: string, color: string): Promise<void> {
    if (COLORS.includes(color)) {
      await this.patchProfile(id, { color });
      this.changed.fire();
    }
  }

  async move(id: string, delta: number): Promise<void> {
    const list = this.profiles;
    const from = list.findIndex((p) => p.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) {
      return;
    }
    list.splice(to, 0, ...list.splice(from, 1));
    await this.setProfiles(list);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) {
      return;
    }
    const detail =
      id === this.activeId
        ? vscode.l10n.t('This is the active account. It stays signed in to Claude Code, it just stops showing here.')
        : vscode.l10n.t('The saved login will be deleted from VS Code. You can add the account again later.');
    const removeLabel = vscode.l10n.t('Remove');
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t('Remove "{0}"?', profile.label),
      { modal: true, detail },
      removeLabel,
    );
    if (ok !== removeLabel) {
      return;
    }
    await this.context.secrets.delete(SECRET_PREFIX + id);
    await this.setProfiles(this.profiles.filter((p) => p.id !== id));
    this.usage.delete(id);
    this.history.remove(id);
    await this.persistUsage();
    await this.refreshActive();
    this.changed.fire();
  }

  /** Accounts to switch to, best first. */
  suggest(focusKind?: string): Candidate[] {
    return rankAccounts(
      this.profiles.map((p) => ({
        id: p.id,
        label: p.label,
        active: p.id === this.activeId,
        needsLogin: !!p.needsLogin,
        snapshot: this.usage.get(p.id)?.snapshot,
      })),
      focusKind,
    );
  }

  private async persistUsage() {
    const out: Record<string, UsageSnapshot> = {};
    for (const [id, info] of this.usage) {
      if (info.snapshot) out[id] = info.snapshot;
    }
    await this.context.globalState.update(USAGE_KEY, out);
  }

  /** Updates usage of one account (or all). Runs are not stacked. */
  refreshUsage(onlyId?: string): Promise<void> {
    if (!vscode.workspace.getConfiguration('claudeHub').get<boolean>('showUsage', true)) {
      return Promise.resolve();
    }
    if (!onlyId && this.usageRun) {
      return this.usageRun;
    }
    const run = (async () => {
      const current = await readCurrentLogin();
      for (const p of this.profiles.filter((x) => !onlyId || x.id === onlyId)) {
        await this.updateUsageOf(p, current);
      }
      await this.persistUsage();
      this.changed.fire();
    })().finally(() => {
      if (!onlyId) this.usageRun = undefined;
    });
    if (!onlyId) this.usageRun = run;
    return run;
  }

  private async updateUsageOf(p: Profile, current: LoginSnapshot | undefined) {
    const prev = this.usage.get(p.id);
    const setInfo = (info: UsageInfo) => {
      this.usage.set(p.id, info);
      this.changed.fire();
    };
    const isActive = p.id === this.activeId && !!current;
    const refreshInactive = vscode.workspace.getConfiguration('claudeHub').get<boolean>('refreshInactiveTokens', true);

    let token: string | undefined;
    try {
      if (isActive) {
        // Claude Code owns the active login: read its token, never refresh it here.
        token = current!.claudeAiOauth.expiresAt > Date.now() ? current!.claudeAiOauth.accessToken : undefined;
      } else if (!p.needsLogin) {
        token = await this.restingToken(p, refreshInactive);
      }
    } catch (err) {
      setInfo({ ...prev, status: 'error', error: this.describe(err) });
      return;
    }
    if (!token) {
      setInfo({ ...prev, status: 'stale' });
      return;
    }

    if (!prev?.snapshot) {
      setInfo({ status: 'loading' });
    }
    try {
      const snapshot = await fetchUsage(token);
      this.usage.set(p.id, { status: 'ok', snapshot });
      this.history.add(p.id, snapshot);
      this.notifier.onSnapshot(p.id, prev?.snapshot, snapshot);
    } catch (err) {
      setInfo({ ...prev, status: 'error', error: this.describe(err) });
    }
  }

  /** Access token of an account that is not active, refreshed if needed (and allowed). */
  private restingToken(p: Profile, mayRefresh: boolean): Promise<string | undefined> {
    return this.withLock(p.id, async () => {
      const snap = await this.getLogin(p.id);
      const tokens = snap?.claudeAiOauth;
      if (!snap || !tokens) {
        return undefined;
      }
      if (tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
        return tokens.accessToken;
      }
      if (!mayRefresh || p.id === this.activeId) {
        return undefined;
      }
      try {
        snap.claudeAiOauth = await refreshTokens(tokens);
      } catch (err) {
        if (err instanceof ApiError && err.invalidGrant) {
          await this.patchProfile(p.id, { needsLogin: true });
          this.changed.fire();
        }
        throw err;
      }
      await this.storeLogin(p.id, snap);
      return snap.claudeAiOauth.accessToken;
    });
  }

  private describe(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.invalidGrant) return vscode.l10n.t('Login expired');
      if (err.status === 429) return vscode.l10n.t('Too many requests, trying again later');
      if (err.status === 401) return vscode.l10n.t('Token rejected');
      return err.message;
    }
    return (err as Error).message ?? String(err);
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    this.history.flush();
    this.notifier.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.changed.dispose();
  }
}
