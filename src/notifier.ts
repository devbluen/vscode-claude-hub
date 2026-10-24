import * as vscode from 'vscode';
import { EXHAUSTED, UsageSnapshot, limitLabel } from './usage';

export interface NotifierHost {
  labelOf(id: string): string;
  isActive(id: string): boolean;
  /** Best other account to use, if any. */
  bestAlternative(excludeId: string): { id: string; label: string } | undefined;
  switchTo(id: string): Promise<void>;
  recheck(id: string): void;
}

const RECHECK_DELAY_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Two kinds of notifications:
 * - a used-up limit is available again (any account);
 * - the active account crossed the warning threshold, with a suggestion to switch.
 * Used-up limits also get a re-check scheduled right after their reset time.
 */
export class LimitNotifier implements vscode.Disposable {
  private readonly warned = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly host: NotifierHost) {}

  private get config() {
    return vscode.workspace.getConfiguration('claudeSwitch');
  }

  onSnapshot(id: string, prev: UsageSnapshot | undefined, next: UsageSnapshot) {
    if (prev && this.config.get<boolean>('notifyWhenAvailable', true)) {
      for (const w of next.windows) {
        const before = prev.windows.find((p) => p.kind === w.kind);
        if (before && before.percent >= EXHAUSTED && w.percent < EXHAUSTED) {
          void this.available(id, limitLabel(w.kind, w.scope));
        }
      }
    }

    const threshold = this.config.get<number>('warnAtPercent', 90);
    if (this.host.isActive(id) && threshold > 0) {
      for (const w of next.windows) {
        const key = `${id}:${w.kind}:${w.resetsAt ?? ''}`;
        if (w.percent >= threshold && !this.warned.has(key)) {
          this.warned.add(key);
          void this.runningLow(id, limitLabel(w.kind, w.scope), w.percent);
        }
      }
    }

    this.schedule(id, next);
  }

  private async available(id: string, limit: string) {
    const switchLabel = vscode.l10n.t('Switch');
    const actions = this.host.isActive(id) ? [] : [switchLabel];
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('"{0}": {1} is available again.', this.host.labelOf(id), limit),
      ...actions,
    );
    if (choice === switchLabel) {
      await this.host.switchTo(id);
    }
  }

  private async runningLow(id: string, limit: string, percent: number) {
    const alt = this.host.bestAlternative(id);
    const message = vscode.l10n.t('"{0}" has used {1}% of {2}.', this.host.labelOf(id), percent, limit);
    if (!alt) {
      void vscode.window.showWarningMessage(message);
      return;
    }
    const action = vscode.l10n.t('Switch to "{0}"', alt.label);
    const choice = await vscode.window.showWarningMessage(message, action);
    if (choice === action) {
      await this.host.switchTo(alt.id);
    }
  }

  private schedule(id: string, snap: UsageSnapshot) {
    for (const w of snap.windows) {
      const key = `${id}:${w.kind}`;
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      if (w.percent < EXHAUSTED || !Number.isFinite(reset)) {
        continue;
      }
      const delay = reset + RECHECK_DELAY_MS - Date.now();
      if (delay > 0 && delay < MAX_TIMER_MS) {
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key);
            this.host.recheck(id);
          }, delay),
        );
      }
    }
  }

  dispose() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }
}
