import * as vscode from 'vscode';

/** One rate-limit window: the 5-hour session, the weekly limit, or a model-scoped weekly limit. */
export interface LimitWindow {
  /** 'session', 'weekly_all', 'weekly_fable', ... */
  kind: string;
  /** Display name of the model/surface for scoped limits (e.g. "Fable"). */
  scope?: string;
  /** 0–100 */
  percent: number;
  resetsAt?: string;
}

export interface BreakdownRow {
  key: string;
  label: string;
  percent: number;
}

export interface UsageSnapshot {
  fetchedAt: number;
  windows: LimitWindow[];
  /** Share of the weekly usage per product (Claude Code, chats, ...). */
  breakdown?: BreakdownRow[];
}

/** A limit is used up from 100%. */
export const EXHAUSTED = 100;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

function scopeName(scope: any): string | undefined {
  const part = scope?.model ?? scope?.surface;
  return part?.display_name || part?.id || undefined;
}

function kindRank(kind: string): number {
  if (kind === 'session') return 0;
  if (kind === 'weekly_all') return 1;
  return kind.startsWith('session') ? 2 : 3;
}

/**
 * Normalizes the /api/oauth/usage response. The `limits` array is preferred: it carries
 * scoped limits (a model such as Fable) as `weekly_scoped` + `scope`, which become
 * `weekly_<model>`. The older `five_hour` / `seven_day*` fields fill any gaps.
 */
export function parseUsage(raw: any): UsageSnapshot {
  const windows: LimitWindow[] = [];
  const add = (w: LimitWindow) => {
    if (!windows.some((x) => x.kind === w.kind)) {
      windows.push(w);
    }
  };

  if (Array.isArray(raw?.limits)) {
    for (const l of raw.limits) {
      if (typeof l?.percent !== 'number') {
        continue;
      }
      const name = scopeName(l.scope);
      let kind = String(l.kind ?? l.group ?? 'limit');
      if (name && kind.endsWith('_scoped')) {
        kind = kind.replace(/_scoped$/, '_' + (slug(name) || 'scoped'));
      }
      add({ kind, scope: name, percent: clamp(l.percent), resetsAt: l.resets_at ?? undefined });
    }
  }

  if (typeof raw?.five_hour?.utilization === 'number') {
    add({ kind: 'session', percent: clamp(raw.five_hour.utilization), resetsAt: raw.five_hour.resets_at ?? undefined });
  }
  if (typeof raw?.seven_day?.utilization === 'number') {
    add({ kind: 'weekly_all', percent: clamp(raw.seven_day.utilization), resetsAt: raw.seven_day.resets_at ?? undefined });
  }
  for (const [key, value] of Object.entries<any>(raw ?? {})) {
    const model = /^seven_day_(.+)$/.exec(key)?.[1];
    if (!model || typeof value?.utilization !== 'number') {
      continue;
    }
    add({ kind: `weekly_${model}`, scope: titleCase(model), percent: clamp(value.utilization), resetsAt: value.resets_at ?? undefined });
  }

  windows.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind));

  const rows = raw?.seven_day_breakdown?.rows;
  const breakdown = Array.isArray(rows)
    ? rows
        .filter((r: any) => typeof r?.percent === 'number')
        .map((r: any) => ({ key: String(r.key), label: String(r.display_name ?? r.key), percent: r.percent }))
    : undefined;

  return { fetchedAt: Date.now(), windows, breakdown };
}

/** Utilization right now: a window whose reset time has passed is back to 0. */
export function effectivePercent(w: LimitWindow, now = Date.now()): number {
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  return Number.isFinite(reset) && reset <= now ? 0 : w.percent;
}

export function limitLabel(kind: string, scope?: string): string {
  if (kind === 'session') return vscode.l10n.t('5-hour session');
  if (kind === 'weekly_all') return vscode.l10n.t('Weekly');
  const name = scope ?? titleCase(kind.replace(/^(weekly|session)_/, ''));
  return kind.startsWith('session') ? vscode.l10n.t('Session · {0}', name) : vscode.l10n.t('Weekly · {0}', name);
}

/** Compact label for the status bar. */
export function shortLabel(kind: string, scope?: string): string {
  if (kind === 'session') return '5h';
  if (kind === 'weekly_all') return vscode.l10n.t('wk');
  return scope ?? titleCase(kind.replace(/^(weekly|session)_/, ''));
}
