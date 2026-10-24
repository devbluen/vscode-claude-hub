import * as vscode from 'vscode';
import { EXHAUSTED, UsageSnapshot, effectivePercent, limitLabel } from './usage';

export interface SuggestAccount {
  id: string;
  label: string;
  active: boolean;
  needsLogin: boolean;
  snapshot?: UsageSnapshot;
}

export interface Candidate {
  id: string;
  label: string;
  /** Percent still available on the tightest relevant limit. */
  available: number;
  score: number;
  reason: string;
}

const DAY_MS = 24 * 3_600_000;

/**
 * Ranks the accounts the user could switch to. Only accounts that can be used right now
 * count (signed in, no general limit used up). The tightest of the 5-hour, weekly and the
 * focused limit decides; a weekly limit that resets within a day gets a bonus, because
 * whatever is left of it is lost at the reset.
 */
export function rankAccounts(accounts: SuggestAccount[], focusKind?: string, now = Date.now()): Candidate[] {
  const out: Candidate[] = [];
  for (const acc of accounts) {
    if (acc.active || acc.needsLogin || !acc.snapshot?.windows.length) {
      continue;
    }
    const relevant = acc.snapshot.windows.filter(
      (w) => w.kind === 'session' || w.kind === 'weekly_all' || w.kind === focusKind,
    );
    if (focusKind && !relevant.some((w) => w.kind === focusKind)) {
      continue;
    }
    if (!relevant.length || relevant.some((w) => effectivePercent(w, now) >= EXHAUSTED)) {
      continue;
    }
    let tightest = relevant[0];
    for (const w of relevant) {
      if (effectivePercent(w, now) > effectivePercent(tightest, now)) {
        tightest = w;
      }
    }
    const available = 100 - effectivePercent(tightest, now);
    let score = available;
    const weekly = acc.snapshot.windows.find((w) => w.kind === (focusKind ?? 'weekly_all'));
    const weeklyReset = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : NaN;
    let reason = vscode.l10n.t('{0}% left on {1}', available, limitLabel(tightest.kind, tightest.scope));
    if (weekly && weeklyReset - now < DAY_MS && weeklyReset > now) {
      score += Math.min(15, (100 - effectivePercent(weekly, now)) * 0.3);
      reason += ' · ' + vscode.l10n.t('weekly resets soon — use it or lose it');
    }
    out.push({ id: acc.id, label: acc.label, available, score, reason });
  }
  return out.sort((a, b) => b.score - a.score);
}
