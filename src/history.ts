import * as fs from 'fs';
import * as path from 'path';
import { UsageSnapshot } from './usage';

/** One reading: time + percent per limit kind. */
export interface HistoryPoint {
  t: number;
  w: Record<string, number>;
}

const KEEP_MS = 35 * 24 * 3_600_000;
/** Unchanged readings are still stored every so often, to keep the series continuous. */
const HEARTBEAT_MS = 30 * 60_000;

/** Usage history per account, kept in a JSON file in the extension's storage folder. */
export class UsageHistory {
  private data: Record<string, HistoryPoint[]> = {};
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(storageDir: string) {
    this.file = path.join(storageDir, 'usage-history.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  add(profileId: string, snap: UsageSnapshot) {
    const w = Object.fromEntries(snap.windows.map((x) => [x.kind, x.percent]));
    const list = (this.data[profileId] ??= []);
    const last = list[list.length - 1];
    const same = last && JSON.stringify(last.w) === JSON.stringify(w);
    if (same && snap.fetchedAt - last.t < HEARTBEAT_MS) {
      return;
    }
    list.push({ t: snap.fetchedAt, w });
    const cutoff = Date.now() - KEEP_MS;
    while (list.length && list[0].t < cutoff) {
      list.shift();
    }
    this.scheduleSave();
  }

  get(profileId: string): HistoryPoint[] {
    return this.data[profileId] ?? [];
  }

  remove(profileId: string) {
    delete this.data[profileId];
    this.scheduleSave();
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  flush() {
    clearTimeout(this.saveTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      // history is best effort
    }
  }
}
