// Made-up accounts and usage history for the screenshots. No real data is read.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simulates 30 days of usage: work hours, 5-hour windows, weekly windows. */
function simulate(now, { seed, intensity, weeklyFactor, fable, weekend = 0.15, weeklyAnchor }) {
  const rand = prng(seed);
  const history = [];
  let sessionStart = -Infinity;
  let session = 0;
  let weekly = 0;
  let fableUse = 0;
  let weekStart = weeklyAnchor - 5 * 7 * DAY;
  let last;
  for (let t = now - 30 * DAY; t <= now - 15 * MIN; t += 15 * MIN) {
    while (t >= weekStart + 7 * DAY) {
      weekStart += 7 * DAY;
      weekly = 0;
      fableUse = 0;
    }
    if (t >= sessionStart + 5 * HOUR) session = 0;
    const d = new Date(t);
    const h = d.getHours();
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const working = h >= 9 && h < 19 && rand() < (isWeekend ? weekend : 0.75);
    if (working) {
      if (session === 0) sessionStart = t;
      const inc = rand() * intensity;
      session = Math.min(100, session + inc);
      weekly = Math.min(100, weekly + inc * weeklyFactor);
      if (fable) fableUse = Math.min(100, fableUse + inc * fable * (rand() < 0.4 ? 1 : 0));
    }
    // VS Code is open from 8:00 to 23:00
    if (h >= 8 && h < 23) {
      const w = { session: Math.round(session), weekly_all: Math.round(weekly) };
      if (fable) w.weekly_fable = Math.round(fableUse);
      const same = last && JSON.stringify(last.w) === JSON.stringify(w);
      if (!same || t - last.t >= 30 * MIN) {
        last = { t, w };
        history.push(last);
      }
    }
  }
  return { history, nextWeekly: weekStart + 7 * DAY };
}

function accounts(now, lang) {
  const pt = lang === 'pt-br';
  const iso = (t) => new Date(t).toISOString();
  const defs = [
    {
      id: 'a1', label: pt ? 'Pessoal' : 'Personal', email: 'alex@example.com', plan: 'Max 20x', color: '#E07A5F',
      sim: { seed: 7, intensity: 9, weeklyFactor: 0.09, fable: 0.6, weeklyAnchor: now + 2.3 * DAY },
      now: { session: 76, weekly_all: 41, weekly_fable: 22 }, sessionReset: now + 1.6 * HOUR,
    },
    {
      id: 'a2', label: pt ? 'Trabalho' : 'Work', email: 'alex@acme.dev', orgName: 'Acme Inc', plan: 'Team', color: '#3B82F6',
      sim: { seed: 21, intensity: 11, weeklyFactor: 0.12, weekend: 0.02, weeklyAnchor: now + 4.6 * DAY },
      now: { session: 58, weekly_all: 63 }, sessionReset: now + 3.2 * HOUR,
    },
    {
      id: 'a3', label: pt ? 'Projeto paralelo' : 'Side project', email: 'alex.dev@example.com', plan: 'Pro', color: '#14B8A6',
      sim: { seed: 5, intensity: 14, weeklyFactor: 0.105, weekend: 0.5, weeklyAnchor: now + 1.2 * DAY },
      now: { session: 100, weekly_all: 72 }, sessionReset: now + 72 * MIN,
    },
    {
      id: 'a4', label: pt ? 'Pesquisa' : 'Research', email: 'research@example.org', plan: 'Max 5x', color: '#8B5CF6',
      sim: { seed: 99, intensity: 6, weeklyFactor: 0.1, fable: 0.8, weekend: 0.05, weeklyAnchor: now + 5.4 * DAY },
      now: { session: 6, weekly_all: 18, weekly_fable: 9 }, sessionReset: now + 4.4 * HOUR,
    },
  ];

  return defs.map((d) => {
    const { history, nextWeekly } = simulate(now, d.sim);
    history.push({ t: now - 2 * MIN, w: { ...d.now } });
    const windows = [
      { kind: 'session', percent: d.now.session, resetsAt: iso(d.sessionReset) },
      { kind: 'weekly_all', percent: d.now.weekly_all, resetsAt: iso(nextWeekly) },
    ];
    if (d.now.weekly_fable !== undefined) {
      windows.push({ kind: 'weekly_fable', scope: 'Fable', percent: d.now.weekly_fable, resetsAt: iso(nextWeekly) });
    }
    const breakdown = [
      { key: 'claude_code', label: 'Claude Code', percent: d.id === 'a2' ? 92 : d.id === 'a3' ? 64 : 78 },
      { key: 'chat', label: pt ? 'Chats' : 'Chats', percent: d.id === 'a2' ? 6 : d.id === 'a3' ? 30 : 15 },
      { key: 'cowork', label: 'Cowork', percent: d.id === 'a4' ? 7 : 2 },
    ];
    const rest = 100 - breakdown.reduce((s, r) => s + r.percent, 0);
    if (rest > 0) breakdown.push({ key: 'other', label: pt ? 'Outros' : 'Other', percent: rest });
    return {
      profile: {
        id: d.id, identity: d.id, label: d.label, color: d.color, email: d.email, orgName: d.orgName, plan: d.plan,
        createdAt: now - 40 * DAY, updatedAt: now,
      },
      snapshot: { fetchedAt: now - 2 * MIN, windows, breakdown },
      history,
    };
  });
}

module.exports = { accounts };
