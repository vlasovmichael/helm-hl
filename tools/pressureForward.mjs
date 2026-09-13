// ─────────────────────────────────────────────────────────────────────────────
//  Форвард: иссякло ли ценовое давление после резкого движения.
//
//  Предзаявка живёт в data/hypotheses/registry.json. Коллектор пишет только
//  бумажные наблюдения и не выставляет ордера. Основной вопрос — отличается ли
//  следующий час после ИССЯКШЕГО агрессивного потока от часа после
//  ПРОДОЛЖАЮЩЕГОСЯ потока. До стоп-правила результат не читается.
// ─────────────────────────────────────────────────────────────────────────────

export const BAR_MS = 5 * 60_000;

export const PRESSURE_FORWARD = Object.freeze({
  id: 'flow-pressure-exhaustion-2026-09',
  startsAt: Date.parse('2026-09-14T00:00:00Z'),
  shockBars: 6,
  confirmBars: 2,
  outcomeBars: 12,
  cooldownBars: 12,
  minShockPct: 1.5,
  minShockImbalance: 0.35,
  maxExhaustedImbalance: 0,
  minPersistentImbalance: 0.35,
  minShockUsd: 250_000,
  economicBp: 20,
});

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const imbalance = (rows) => {
  const buy = rows.reduce((sum, row) => sum + row.tbuy, 0);
  const sell = rows.reduce((sum, row) => sum + row.tsell, 0);
  return buy + sell > 0 ? (buy - sell) / (buy + sell) : null;
};

/** Классифицирует восемь уже закрытых последовательных баров без заглядывания вперёд. */
export function buildPressureSignal(rows, params = PRESSURE_FORWARD) {
  const need = params.shockBars + params.confirmBars;
  if (rows.length !== need) return null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].bar !== rows[i - 1].bar + 1) return null;
  }

  const shock = rows.slice(0, params.shockBars);
  const confirm = rows.slice(params.shockBars);
  const first = shock[0];
  const last = shock[shock.length - 1];
  if (!(first.o > 0) || !(last.c > 0)) return null;

  const shockPct = ((last.c - first.o) / first.o) * 100;
  const direction = sign(shockPct);
  if (!direction || Math.abs(shockPct) < params.minShockPct) return null;

  const shockUsd = shock.reduce((sum, row) => sum + row.volume, 0);
  if (shockUsd < params.minShockUsd) return null;
  const rawShockImbalance = imbalance(shock);
  const rawConfirmImbalance = imbalance(confirm);
  if (rawShockImbalance == null || rawConfirmImbalance == null) return null;

  const shockPressure = direction * rawShockImbalance;
  const confirmPressure = direction * rawConfirmImbalance;
  if (shockPressure < params.minShockImbalance) return null;

  const cohort = confirmPressure <= params.maxExhaustedImbalance
    ? 'exhausted'
    : confirmPressure >= params.minPersistentImbalance
      ? 'persistent'
      : null;
  if (!cohort) return null;

  return {
    signalBar: rows[rows.length - 1].bar,
    side: direction > 0 ? 'SHORT' : 'LONG',
    cohort,
    shockPct,
    shockImbalance: rawShockImbalance,
    confirmImbalance: rawConfirmImbalance,
    shockUsd,
  };
}

export function fadeReturnBp(side, entry, exit) {
  if (!(entry > 0) || !(exit > 0)) return null;
  return (side === 'LONG' ? exit / entry - 1 : 1 - exit / entry) * 10_000;
}

export function installPressureForward(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_bars (
      bar INTEGER NOT NULL, coin INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
      volume REAL NOT NULL, tbuy REAL NOT NULL, tsell REAL NOT NULL,
      fills INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bar, coin)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS pressure_events (
      coin INTEGER NOT NULL, signal_bar INTEGER NOT NULL,
      side TEXT NOT NULL, cohort TEXT NOT NULL,
      shock_pct REAL NOT NULL, shock_imbalance REAL NOT NULL,
      confirm_imbalance REAL NOT NULL, shock_usd REAL NOT NULL,
      entry_bar INTEGER NOT NULL, entry_px REAL,
      exit_bar INTEGER NOT NULL, exit_px REAL, fade_bp REAL,
      btc_regime TEXT, status TEXT NOT NULL,
      PRIMARY KEY (coin, signal_bar)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_pressure_status ON pressure_events (status, exit_bar);
  `);
}

/** Продвигает состояние форварда после записи очередного закрытого market bar. */
export function advancePressureForward(db, currentBar, params = PRESSURE_FORWARD) {
  const nowMs = currentBar * BAR_MS;
  if (nowMs < params.startsAt) return { added: 0, resolved: 0, invalidated: 0 };

  const invalidEntry = db.prepare(`
    UPDATE pressure_events SET status = 'invalid'
     WHERE status = 'entry_pending' AND entry_bar < ?`).run(currentBar).changes;
  const invalidExit = db.prepare(`
    UPDATE pressure_events SET status = 'invalid'
     WHERE status = 'outcome_pending' AND exit_bar < ?`).run(currentBar).changes;

  const entryRows = db.prepare(`
    SELECT e.coin, e.signal_bar, m.o AS entry_px
      FROM pressure_events e JOIN market_bars m ON m.coin = e.coin AND m.bar = e.entry_bar
     WHERE e.status = 'entry_pending' AND e.entry_bar = ? AND m.closed = 1`).all(currentBar);
  const setEntry = db.prepare(`
    UPDATE pressure_events SET entry_px = ?, status = 'outcome_pending'
     WHERE coin = ? AND signal_bar = ?`);
  for (const row of entryRows) setEntry.run(row.entry_px, row.coin, row.signal_bar);

  const exitRows = db.prepare(`
    SELECT e.coin, e.signal_bar, e.side, e.entry_px, m.c AS exit_px
      FROM pressure_events e JOIN market_bars m ON m.coin = e.coin AND m.bar = e.exit_bar
     WHERE e.status = 'outcome_pending' AND e.exit_bar = ? AND m.closed = 1`).all(currentBar);
  const setExit = db.prepare(`
    UPDATE pressure_events SET exit_px = ?, fade_bp = ?, status = 'resolved'
     WHERE coin = ? AND signal_bar = ?`);
  for (const row of exitRows) {
    setExit.run(row.exit_px, fadeReturnBp(row.side, row.entry_px, row.exit_px), row.coin, row.signal_bar);
  }

  const btc = db.prepare("SELECT id FROM coins WHERE name = 'BTC'").get();
  let btcRegime = null;
  if (btc) {
    const prices = db.prepare(`SELECT bar, c FROM market_bars WHERE coin = ? AND closed = 1 AND bar IN (?, ?)`)
      .all(btc.id, currentBar, currentBar - 288);
    const byBar = new Map(prices.map((row) => [row.bar, row.c]));
    const current = byBar.get(currentBar);
    const prior = byBar.get(currentBar - 288);
    if (current > 0 && prior > 0) btcRegime = current >= prior ? 'btc_up' : 'btc_down';
  }

  const coins = db.prepare('SELECT coin FROM market_bars WHERE bar = ? AND closed = 1').all(currentBar);
  const recent = db.prepare(`
    SELECT bar, o, h, l, c, volume, tbuy, tsell, fills
      FROM market_bars WHERE coin = ? AND closed = 1 AND bar BETWEEN ? AND ? ORDER BY bar`);
  const lastEvent = db.prepare('SELECT MAX(signal_bar) AS bar FROM pressure_events WHERE coin = ?');
  const add = db.prepare(`
    INSERT OR IGNORE INTO pressure_events
      (coin, signal_bar, side, cohort, shock_pct, shock_imbalance,
       confirm_imbalance, shock_usd, entry_bar, exit_bar, btc_regime, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'entry_pending')`);

  let added = 0;
  const need = params.shockBars + params.confirmBars;
  if ((currentBar - need + 1) * BAR_MS < params.startsAt) {
    return { added, resolved: exitRows.length, invalidated: invalidEntry + invalidExit };
  }
  for (const { coin } of coins) {
    const previous = lastEvent.get(coin)?.bar;
    if (Number.isFinite(previous) && currentBar - previous <= params.cooldownBars) continue;
    const rows = recent.all(coin, currentBar - need + 1, currentBar);
    const signal = buildPressureSignal(rows, params);
    if (!signal) continue;
    added += add.run(
      coin, signal.signalBar, signal.side, signal.cohort,
      signal.shockPct, signal.shockImbalance, signal.confirmImbalance, signal.shockUsd,
      currentBar + 1, currentBar + 1 + params.outcomeBars, btcRegime,
    ).changes;
  }

  return {
    added,
    resolved: exitRows.length,
    invalidated: invalidEntry + invalidExit,
  };
}
