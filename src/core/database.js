import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { logger } from './logger.js';
import { config } from './config.js';

mkdirSync('data', { recursive: true });

const DB_PATH = 'data/trades.db';

let db;

export function initDB() {
  db = new Database(DB_PATH);

  // WAL-mode: читатели не блокируют писателей
  db.pragma('journal_mode = WAL');
  // synchronous=FULL: fsync на каждый commit. После corruption 2026-05-25
  // (equity_snapshots побилась после рестарта контейнера) — NORMAL оставлял
  // окно где SIGTERM мог попасть между write и fsync. FULL это окно закрывает.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      coin        TEXT    NOT NULL,
      size_usd    REAL    NOT NULL,
      entry_price REAL    NOT NULL,
      entry_apy   REAL    NOT NULL,
      entry_time  INTEGER NOT NULL,
      mode        TEXT    NOT NULL CHECK (mode IN ('PAPER', 'PRODUCTION')),
      status      TEXT    NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'))
    );

    CREATE TABLE IF NOT EXISTS history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      coin          TEXT    NOT NULL,
      entry_price   REAL    NOT NULL,
      close_price   REAL    NOT NULL,
      realized_pnl  REAL    NOT NULL,
      fee_paid      REAL    NOT NULL,
      mode          TEXT    NOT NULL CHECK (mode IN ('PAPER', 'PRODUCTION')),
      closed_at     INTEGER NOT NULL,
      reason        TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      ts     INTEGER PRIMARY KEY,
      equity REAL    NOT NULL
    );
  `);

  // Migration: strategy_id column for multi-strategy support
  const posColumns = db.pragma('table_info(positions)');
  if (!posColumns.find(c => c.name === 'strategy_id')) {
    db.exec("ALTER TABLE positions ADD COLUMN strategy_id TEXT NOT NULL DEFAULT 'carry'");
    logger.info('[DB] Migration: added strategy_id to positions');
  }
  const histColumns = db.pragma('table_info(history)');
  if (!histColumns.find(c => c.name === 'strategy_id')) {
    db.exec("ALTER TABLE history ADD COLUMN strategy_id TEXT NOT NULL DEFAULT 'carry'");
    logger.info('[DB] Migration: added strategy_id to history');
  }

  // Migration: sl_price / tp_price для hunter-позиций (nullable — carry/fade их не имеют)
  if (!posColumns.find(c => c.name === 'sl_price')) {
    db.exec('ALTER TABLE positions ADD COLUMN sl_price REAL');
    logger.info('[DB] Migration: added sl_price to positions');
  }
  if (!posColumns.find(c => c.name === 'tp_price')) {
    db.exec('ALTER TABLE positions ADD COLUMN tp_price REAL');
    logger.info('[DB] Migration: added tp_price to positions');
  }

  // Migration (Iter C): hunter_sl_oid / hunter_tp_oid — id'шники trigger-ордеров на бирже.
  // Заполняются только для hunter PROD-позиций. Используются reconciler'ом для определения,
  // какой именно триггер сработал (или для cancel'ов при soft-exit).
  if (!posColumns.find(c => c.name === 'hunter_sl_oid')) {
    db.exec('ALTER TABLE positions ADD COLUMN hunter_sl_oid INTEGER');
    logger.info('[DB] Migration: added hunter_sl_oid to positions');
  }
  if (!posColumns.find(c => c.name === 'hunter_tp_oid')) {
    db.exec('ALTER TABLE positions ADD COLUMN hunter_tp_oid INTEGER');
    logger.info('[DB] Migration: added hunter_tp_oid to positions');
  }

  // Migration: entry_equity — equity аккаунта в момент OPEN.
  // Используется в integrity.js для корректной оценки PnL при external close
  // (старая формула equity − size_usd была математически неверной).
  if (!posColumns.find(c => c.name === 'entry_equity')) {
    db.exec('ALTER TABLE positions ADD COLUMN entry_equity REAL');
    logger.info('[DB] Migration: added entry_equity to positions');
  }

  // Migration: side — направление позиции ('short' | 'long').
  // Carry исторически шортил всегда (положительный funding); default 'short'
  // сохраняет совместимость со всеми существующими записями.
  // Long-сторона активируется через CARRY_LONG_ENABLED (см. config.js).
  if (!posColumns.find(c => c.name === 'side')) {
    db.exec("ALTER TABLE positions ADD COLUMN side TEXT NOT NULL DEFAULT 'short' CHECK (side IN ('short', 'long'))");
    logger.info('[DB] Migration: added side to positions');
  }
  if (!histColumns.find(c => c.name === 'side')) {
    db.exec("ALTER TABLE history ADD COLUMN side TEXT NOT NULL DEFAULT 'short' CHECK (side IN ('short', 'long'))");
    logger.info('[DB] Migration: added side to history');
  }

  // Migration: Hunter entry features — фичи рынка в момент OPEN, для будущего
  // dynamic position sizing / leverage scoring. Все nullable; заполняются только
  // hunter-стратегией. Зеркалятся в обе таблицы, чтобы переживать close.
  const hunterEntryCols = [
    ['entry_spike_pct',      'REAL'],  // спайк %/2мин (триггер сигнала)
    ['entry_trend_15m_pct',  'REAL'],  // anti-trend rise за hunterTrendLookbackMin
    ['entry_trend_1h_pct',   'REAL'],  // широкий тренд за 60мин
    ['entry_funding_rate',   'REAL'],  // funding на момент входа
    ['entry_volume_24h_usd', 'REAL'],  // dayNtlVlm
    ['entry_oi_usd',         'REAL'],  // openInterest * markPx
    ['entry_oi_delta_2m',    'REAL'],  // ΔOI% за окно спайка (Трек B forced-ness)
    ['entry_oi_delta_5m',    'REAL'],  // ΔOI% за 5 мин (медленная форсированность)
    ['entry_oi_delta_15m',   'REAL'],  // ΔOI% за 15 мин (Vapor-дивергенция; freebie для Hunter)
    ['entry_hour_utc',       'INTEGER'], // 0–23
  ];
  for (const [col, type] of hunterEntryCols) {
    if (!posColumns.find(c => c.name === col)) {
      db.exec(`ALTER TABLE positions ADD COLUMN ${col} ${type}`);
      logger.info(`[DB] Migration: added ${col} to positions`);
    }
    if (!histColumns.find(c => c.name === col)) {
      db.exec(`ALTER TABLE history ADD COLUMN ${col} ${type}`);
      logger.info(`[DB] Migration: added ${col} to history`);
    }
  }

  // Migration: Hunter exit features — пишутся только при close в history.
  const hunterExitCols = [
    ['mfe_usd',       'REAL'],
    ['mae_usd',       'REAL'],
    ['mfe_pct',       'REAL'],
    ['mae_pct',       'REAL'],
    ['hold_seconds',  'INTEGER'],
  ];
  for (const [col, type] of hunterExitCols) {
    if (!histColumns.find(c => c.name === col)) {
      db.exec(`ALTER TABLE history ADD COLUMN ${col} ${type}`);
      logger.info(`[DB] Migration: added ${col} to history`);
    }
  }

  // Migration 2026-05-13: history.entry_time для slot utilization dashboard.
  // Backfill: для hunter-сделок берём closed_at - hold_seconds*1000; для carry/fade
  // (где hold_seconds NULL) оставляем NULL — UI отрисует "—".
  if (!histColumns.find(c => c.name === 'entry_time')) {
    db.exec('ALTER TABLE history ADD COLUMN entry_time INTEGER');
    db.exec(`
      UPDATE history
      SET entry_time = closed_at - hold_seconds * 1000
      WHERE entry_time IS NULL AND hold_seconds IS NOT NULL
    `);
    logger.info('[DB] Migration: added entry_time to history (+ backfilled from hold_seconds)');
  }

  // Migration 2026-05-13: funding_collected — best-effort split funding vs price PnL.
  // Заполняется при close из HL userFunding API (см. closePosition). Старые записи: NULL.
  if (!histColumns.find(c => c.name === 'funding_collected')) {
    db.exec('ALTER TABLE history ADD COLUMN funding_collected REAL');
    logger.info('[DB] Migration: added funding_collected to history');
  }

  // tax_outbox — outbox для tax-manager (см. INTEGRATION.md).
  // Бизнес-код пишет сюда, pusher cron драйнит в HTTPS+HMAC.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tax_outbox (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      TEXT    NOT NULL UNIQUE,
      occurred_at   TEXT    NOT NULL,
      kind          TEXT    NOT NULL,
      amount        REAL    NOT NULL,
      currency      TEXT    NOT NULL,
      counterparty  TEXT,
      doc_no        TEXT,
      raw           TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      pushed_at     INTEGER,
      push_attempts INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT
    );
    CREATE INDEX IF NOT EXISTS tax_outbox_unpushed_idx
      ON tax_outbox (created_at) WHERE pushed_at IS NULL;
  `);

  // Setup Scanner snapshots — manual-helper, копит funding/OI/premium/vol по liquidSet.
  // Пишется scout.js раз в SETUP_SNAPSHOT_INTERVAL_MIN (default 60); НЕ влияет на торговую логику.
  // Retention 90 дней (см. recordSetupSnapshots).
  db.exec(`
    CREATE TABLE IF NOT EXISTS setup_snapshots (
      coin         TEXT    NOT NULL,
      ts           INTEGER NOT NULL,
      funding_rate REAL,
      funding_apy  REAL,
      oi_usd       REAL,
      mark         REAL,
      premium      REAL,
      vol_24h_usd  REAL,
      PRIMARY KEY (coin, ts)
    );
    CREATE INDEX IF NOT EXISTS setup_snapshots_ts_idx ON setup_snapshots (ts);
  `);

  // Bot order id log — для точной фильтрации bot vs manual fills в dashboard'е.
  // Раньше использовали time-based bot window, но bot.entry_time ≠ фактический
  // fill.time (skew 100-1000ms), из-за чего pre-entry fills бота проскакивали
  // в manual reconstruction (PURR incident 2026-05-22). Теперь сохраняем каждый
  // фактический oid, который бот разместил/получил из ответа placeOrder.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_oid_log (
      oid       INTEGER PRIMARY KEY,
      coin      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      kind      TEXT NOT NULL,
      position_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS bot_oid_log_ts_idx ON bot_oid_log (ts);
    CREATE INDEX IF NOT EXISTS bot_oid_log_coin_ts_idx ON bot_oid_log (coin, ts);
  `);

  // Candy Girl signal log — каждый записанный радар-сигнал + авто-резолв
  // (дошёл до TP раньше SL = win, наоборот = loss, ни то ни другое за timeout =
  // timeout). Нужно чтобы реально измерить точность радара, а не гадать.
  db.exec(`
    CREATE TABLE IF NOT EXISTS candy_signals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      coin          TEXT    NOT NULL,
      direction     TEXT    NOT NULL,
      ts            INTEGER NOT NULL,
      price         REAL,
      entry         REAL,
      sl            REAL,
      tp            REAL,
      rr            REAL,
      trend4h       TEXT,
      status        TEXT    NOT NULL DEFAULT 'open',
      outcome       TEXT,
      resolved_at   INTEGER,
      resolved_price REAL
    );
    CREATE INDEX IF NOT EXISTS candy_signals_status_idx ON candy_signals (status);
    CREATE INDEX IF NOT EXISTS candy_signals_ts_idx ON candy_signals (ts);
  `);

  // Shadow exits (2026-06-14) — measurement-only сравнение реального выхода
  // Hunter'а с альтернативными (time-decay TP, chandelier ATR-trail). Одна строка
  // на закрытую позицию. НЕ влияет на торговлю; питает сравнение в /strategies.
  // position_id = PK → INSERT OR REPLACE идемпотентен при повторном finalize.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shadow_exits (
      position_id  INTEGER PRIMARY KEY,
      strategy_id  TEXT    NOT NULL,
      side         TEXT    NOT NULL,
      coin         TEXT    NOT NULL,
      closed_at    INTEGER NOT NULL,
      notional_usd REAL,
      actual_pnl   REAL    NOT NULL,
      actual_pct   REAL,
      td_pnl       REAL,
      td_pct       REAL,
      td_fired     INTEGER NOT NULL DEFAULT 0,
      td_min       REAL,
      ch_pnl       REAL,
      ch_pct       REAL,
      ch_fired     INTEGER NOT NULL DEFAULT 0,
      ch_min       REAL
    );
    CREATE INDEX IF NOT EXISTS shadow_exits_strat_idx ON shadow_exits (strategy_id, side);
    CREATE INDEX IF NOT EXISTS shadow_exits_closed_idx ON shadow_exits (closed_at);
  `);

  logger.info(`[DB] Initialized at ${DB_PATH}`);
  return db;
}

/**
 * Записать oid бот-ордера для последующей фильтрации в manual reconstruction.
 * @param {number} oid — order id из ответа exchange.placeOrder/fill
 * @param {string} coin
 * @param {string} kind — 'open' | 'close' | 'sl_trigger' | 'tp_trigger'
 * @param {number} [positionId] — связь с позицией (опционально)
 */
export function recordBotOid(oid, coin, kind, positionId = null) {
  if (oid == null || !Number.isFinite(Number(oid))) return;
  if (!coin) return;
  try {
    getDb()
      .prepare('INSERT OR IGNORE INTO bot_oid_log (oid, coin, ts, kind, position_id) VALUES (?, ?, ?, ?, ?)')
      .run(Number(oid), String(coin).toUpperCase(), Date.now(), kind || 'unknown', positionId);
  } catch (err) {
    logger.warn(`[DB] recordBotOid(${oid}, ${coin}, ${kind}) failed: ${err.message}`);
  }
}

/**
 * Все oid'ы бота с указанного timestamp. Set для быстрого lookup в reconstruct.
 * @param {number} sinceMs
 * @returns {Set<number>}
 */
export function getBotOidsSince(sinceMs = 0) {
  try {
    const rows = getDb()
      .prepare('SELECT oid FROM bot_oid_log WHERE ts >= ?')
      .all(sinceMs);
    return new Set(rows.map((r) => Number(r.oid)));
  } catch {
    return new Set();
  }
}

export function getRawDb() {
  return getDb();
}

// ── Candy Girl signal log ───────────────────────────────────────────────────

/**
 * Записать радар-сигнал. Возвращает id строки (для последующего резолва) или null.
 * @param {{coin,direction,ts,price,entry,sl,tp,rr,trend4h}} s
 */
export function recordCandySignal(s) {
  try {
    const info = getDb()
      .prepare(`INSERT INTO candy_signals
        (coin, direction, ts, price, entry, sl, tp, rr, trend4h, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
      .run(
        String(s.coin).toUpperCase(), s.direction, s.ts,
        s.price ?? null, s.entry ?? null, s.sl ?? null, s.tp ?? null,
        s.rr ?? null, s.trend4h ?? null,
      );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.warn(`[DB] recordCandySignal(${s?.coin}) failed: ${err.message}`);
    return null;
  }
}

/** Все ещё не зарезолвленные сигналы (для трекера исходов). */
export function getOpenCandySignals() {
  try {
    return getDb().prepare(`SELECT * FROM candy_signals WHERE status = 'open'`).all();
  } catch {
    return [];
  }
}

/**
 * Зафиксировать исход сигнала.
 * @param {number} id
 * @param {'win'|'loss'|'timeout'} outcome
 * @param {number} resolvedPrice
 * @param {number} [resolvedAt=Date.now()]
 */
export function resolveCandySignal(id, outcome, resolvedPrice, resolvedAt = Date.now()) {
  try {
    getDb()
      .prepare(`UPDATE candy_signals
        SET status = 'resolved', outcome = ?, resolved_price = ?, resolved_at = ?
        WHERE id = ?`)
      .run(outcome, resolvedPrice ?? null, resolvedAt, id);
  } catch (err) {
    logger.warn(`[DB] resolveCandySignal(${id}) failed: ${err.message}`);
  }
}

/**
 * Агрегированная статистика сигналов за период (для dashboard).
 * @param {number} [sinceMs=0]
 * @returns {{total,resolved,open,win,loss,timeout,winRate}}
 */
export function getCandySignalStats(sinceMs = 0) {
  const empty = { total: 0, resolved: 0, open: 0, win: 0, loss: 0, timeout: 0, winRate: null };
  try {
    const r = getDb()
      .prepare(`SELECT
          COUNT(*) total,
          SUM(status = 'open')     open,
          SUM(outcome = 'win')     win,
          SUM(outcome = 'loss')    loss,
          SUM(outcome = 'timeout') timeout
        FROM candy_signals WHERE ts >= ?`)
      .get(sinceMs);
    const win = r.win || 0;
    const loss = r.loss || 0;
    const decided = win + loss;   // timeout не считаем в winRate
    return {
      total: r.total || 0,
      open: r.open || 0,
      win, loss,
      timeout: r.timeout || 0,
      resolved: win + loss + (r.timeout || 0),
      winRate: decided > 0 ? win / decided : null,
    };
  } catch {
    return empty;
  }
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

/**
 * Сохраняет новую открытую позицию и возвращает её id.
 * @param {{ coin, size_usd, entry_price, entry_apy, entry_time, mode, strategy_id?, sl_price?, tp_price?, hunter_sl_oid?, hunter_tp_oid? }} data
 */
export function savePosition(data) {
  const row = {
    strategy_id:   'carry',
    sl_price:      null,
    tp_price:      null,
    entry_equity:  null,
    side:          'short',
    hunter_sl_oid: null,
    hunter_tp_oid: null,
    entry_spike_pct:      null,
    entry_trend_15m_pct:  null,
    entry_trend_1h_pct:   null,
    entry_funding_rate:   null,
    entry_volume_24h_usd: null,
    entry_oi_usd:         null,
    entry_oi_delta_2m:    null,
    entry_oi_delta_5m:    null,
    entry_oi_delta_15m:   null,
    entry_hour_utc:       null,
    ...data,
  };
  const stmt = getDb().prepare(`
    INSERT INTO positions (
      coin, size_usd, entry_price, entry_apy, entry_time, mode,
      strategy_id, sl_price, tp_price, entry_equity, side,
      hunter_sl_oid, hunter_tp_oid,
      entry_spike_pct, entry_trend_15m_pct, entry_trend_1h_pct,
      entry_funding_rate, entry_volume_24h_usd, entry_oi_usd,
      entry_oi_delta_2m, entry_oi_delta_5m, entry_oi_delta_15m, entry_hour_utc
    )
    VALUES (
      @coin, @size_usd, @entry_price, @entry_apy, @entry_time, @mode,
      @strategy_id, @sl_price, @tp_price, @entry_equity, @side,
      @hunter_sl_oid, @hunter_tp_oid,
      @entry_spike_pct, @entry_trend_15m_pct, @entry_trend_1h_pct,
      @entry_funding_rate, @entry_volume_24h_usd, @entry_oi_usd,
      @entry_oi_delta_2m, @entry_oi_delta_5m, @entry_oi_delta_15m, @entry_hour_utc
    )
  `);
  const result = stmt.run(row);
  return result.lastInsertRowid;
}

/**
 * Обновляет id'шники Hunter trigger-ордеров для активной позиции.
 * Используется productionHunterOpen после placeOrder триггеров.
 */
export function updateHunterTriggerOids(id, { hunter_sl_oid, hunter_tp_oid }) {
  getDb()
    .prepare('UPDATE positions SET hunter_sl_oid = ?, hunter_tp_oid = ? WHERE id = ?')
    .run(hunter_sl_oid ?? null, hunter_tp_oid ?? null, id);
}

/**
 * Уточняет entry_time позиции (unix ms). Нужен adopt-няньке: свежую ручную позу
 * усыновляем СРАЗУ (стоп ставится мгновенно), ещё до того как HL проиндексирует
 * open-fill, c провизорным entry_time = first-seen. Когда fill долетает —
 * бэкфиллим реальное время входа, чтобы лента/леджер классифицировали позу как
 * 'adopted' по точному entry-матчу (см. adoptReconcile.reconcileProvisionalAdoptEntries).
 */
export function updatePositionEntryTime(id, entryTime) {
  getDb()
    .prepare('UPDATE positions SET entry_time = ? WHERE id = ?')
    .run(entryTime, id);
}

/**
 * Закрывает позицию и переносит запись в history.
 * @param {number} id - id записи в positions
 * @param {{ close_price, realized_pnl, fee_paid, reason }} data
 */
export function closePosition(id, data) {
  const position = getDb()
    .prepare('SELECT * FROM positions WHERE id = ? AND status = ?')
    .get(id, 'OPEN');

  if (!position) {
    throw new Error(`No open position with id=${id}`);
  }

  const insertHistory = getDb().prepare(`
    INSERT INTO history (
      coin, entry_price, close_price, realized_pnl, fee_paid, mode, closed_at, reason, strategy_id, side,
      entry_spike_pct, entry_trend_15m_pct, entry_trend_1h_pct,
      entry_funding_rate, entry_volume_24h_usd, entry_oi_usd,
      entry_oi_delta_2m, entry_oi_delta_5m, entry_oi_delta_15m, entry_hour_utc,
      mfe_usd, mae_usd, mfe_pct, mae_pct, hold_seconds,
      entry_time, funding_collected
    )
    VALUES (
      @coin, @entry_price, @close_price, @realized_pnl, @fee_paid, @mode, @closed_at, @reason, @strategy_id, @side,
      @entry_spike_pct, @entry_trend_15m_pct, @entry_trend_1h_pct,
      @entry_funding_rate, @entry_volume_24h_usd, @entry_oi_usd,
      @entry_oi_delta_2m, @entry_oi_delta_5m, @entry_oi_delta_15m, @entry_hour_utc,
      @mfe_usd, @mae_usd, @mfe_pct, @mae_pct, @hold_seconds,
      @entry_time, @funding_collected
    )
  `);

  const updatePosition = getDb().prepare(
    'UPDATE positions SET status = ? WHERE id = ?',
  );

  const exit = data.exitFeatures || {};

  // Атомарно: history INSERT + positions UPDATE в одной транзакции
  const tx = getDb().transaction(() => {
    insertHistory.run({
      coin:         position.coin,
      entry_price:  position.entry_price,
      close_price:  data.close_price,
      realized_pnl: data.realized_pnl,
      fee_paid:     data.fee_paid,
      mode:         position.mode,
      // Реальное время закрытия ноги (из fills) если передано — иначе момент
      // детекта. Важно для флипов: external-close ловит позу позже фактического
      // закрытия, и без этого сделка встаёт в activity не на своё время.
      closed_at:    Number.isFinite(data.closed_at) ? data.closed_at : Date.now(),
      reason:       data.reason,
      strategy_id:  position.strategy_id || 'carry',
      side:         position.side || 'short',
      // Hunter entry features (mirror from positions; null для carry/fade)
      entry_spike_pct:      position.entry_spike_pct      ?? null,
      entry_trend_15m_pct:  position.entry_trend_15m_pct  ?? null,
      entry_trend_1h_pct:   position.entry_trend_1h_pct   ?? null,
      entry_funding_rate:   position.entry_funding_rate   ?? null,
      entry_volume_24h_usd: position.entry_volume_24h_usd ?? null,
      entry_oi_usd:         position.entry_oi_usd         ?? null,
      entry_oi_delta_2m:    position.entry_oi_delta_2m    ?? null,
      entry_oi_delta_5m:    position.entry_oi_delta_5m    ?? null,
      entry_oi_delta_15m:   position.entry_oi_delta_15m   ?? null,
      entry_hour_utc:       position.entry_hour_utc       ?? null,
      // Hunter exit features (опциональны — передаются только для hunter)
      mfe_usd:      exit.mfe_usd      ?? null,
      mae_usd:      exit.mae_usd      ?? null,
      mfe_pct:      exit.mfe_pct      ?? null,
      mae_pct:      exit.mae_pct      ?? null,
      hold_seconds: exit.hold_seconds ?? null,
      // Dashboard P&L breakdown (2026-05-13): entry_time для slot utilization,
      // funding_collected — для funding-vs-price split (best-effort, может быть null).
      entry_time:        position.entry_time,
      funding_collected: data.funding_collected ?? null,
    });
    updatePosition.run('CLOSED', id);
  });

  tx();
}

/**
 * Возвращает активную (OPEN) позицию ОСНОВНОГО слота или undefined.
 *
 * Основной слот = позиция в режиме самого бота:
 *   • PROD-бот  → mode='PRODUCTION'
 *   • PAPER-бот → mode='PAPER'
 *
 * В PROD-боте shadow-позиции (mode='PAPER', напр. ChillBoy до PROD-активации)
 * сюда НЕ попадают — иначе integrityCheck принимает бумажную позу за реальную,
 * не находит её на бирже и шлёт ложное "ВНЕШНЕЕ ЗАКРЫТИЕ". Для shadow-слота
 * есть getActivePaperPosition().
 */
export function getActivePosition() {
  const mode = config.isProduction ? 'PRODUCTION' : 'PAPER';
  // Single-slot = ТОЛЬКО бот-стратегии (hunter/carry/...). Adopt-позы исключаем:
  // у них свой multi-slot аксессор getActiveAdoptPositions(). Иначе свежая adopt-поза
  // с бОльшим id перехватывала слот (ORDER BY id DESC) и осиротляла реальную позу
  // бота — она выпадала из ownedCoins и бот бросал её как «ничейную ручную»
  // (incident WLD+INJ 2026-06-15). strategy_id IS NULL = легаси carry, оставляем.
  return getDb()
    .prepare("SELECT * FROM positions WHERE status = ? AND mode = ? AND (strategy_id IS NULL OR strategy_id != 'adopt') ORDER BY id DESC LIMIT 1")
    .get('OPEN', mode);
}

/**
 * Все активные (OPEN) adopt-позиции (strategy_id='adopt', mode='PRODUCTION').
 * Adopt — multi-slot: оператор может держать несколько ручных входов одновременно,
 * бот вешает стоп+сопровождение на каждую (см. app/adoptSupervise.js). В отличие
 * от getActivePosition() (single-slot, LIMIT 1 для бот-стратегий), здесь массив.
 */
export function getActiveAdoptPositions() {
  return getDb()
    .prepare("SELECT * FROM positions WHERE status = 'OPEN' AND mode = 'PRODUCTION' AND strategy_id = 'adopt' ORDER BY id ASC")
    .all();
}

/**
 * Возвращает активную (OPEN) shadow-позицию (mode='PAPER') или undefined.
 * Отдельный slot для paper-стратегий в PROD-боте — не конкурирует с реальным
 * и не виден integrity/reconcile.
 */
export function getActivePaperPosition() {
  return getDb()
    .prepare("SELECT * FROM positions WHERE status = ? AND mode = 'PAPER' ORDER BY id DESC LIMIT 1")
    .get('OPEN');
}

/**
 * Возвращает активную PAPER позицию КОНКРЕТНОЙ стратегии (или undefined).
 * Нужен для независимых paper-слотов: несколько paper-стратегий торгуют
 * параллельно, каждая видит только свою позицию (а не "слот вообще занят").
 */
export function getActivePaperPositionByStrategy(strategyId) {
  return getDb()
    .prepare("SELECT * FROM positions WHERE status = ? AND mode = 'PAPER' AND strategy_id = ? ORDER BY id DESC LIMIT 1")
    .get('OPEN', strategyId);
}

/**
 * Все активные PAPER-коины (Set, uppercase). Используется scout.js чтобы пиннить
 * цены всех shadow-позиций — иначе exit-check не получит свежий price когда
 * монета выпадает из liquid/hunter scope.
 */
export function getActivePaperCoins() {
  const rows = getDb()
    .prepare("SELECT DISTINCT coin FROM positions WHERE status = ? AND mode = 'PAPER'")
    .all('OPEN');
  return new Set(rows.map((r) => (r.coin || '').toUpperCase()).filter(Boolean));
}

const EQUITY_SNAPSHOT_RETENTION_MS = 35 * 24 * 3_600_000; // 35 дней

/**
 * Записывает измеренный equity-снапшот. Дашборд строит Performance-график
 * по этим точкам напрямую — депозиты/выводы видны как ступеньки, потому что
 * рисуется ФАКТИЧЕСКИЙ equity, а не реконструкция из суммы PnL сделок.
 * @param {number} equity
 * @param {number} [ts] — Unix ms (default: now)
 */
export function saveEquitySnapshot(equity, ts = Date.now()) {
  if (!Number.isFinite(equity)) return;
  getDb()
    .prepare('INSERT OR REPLACE INTO equity_snapshots (ts, equity) VALUES (?, ?)')
    .run(ts, equity);
  getDb()
    .prepare('DELETE FROM equity_snapshots WHERE ts < ?')
    .run(ts - EQUITY_SNAPSHOT_RETENTION_MS);
}

/**
 * Снапшоты equity, начиная с указанного timestamp, по возрастанию ts.
 * @param {number} sinceMs
 * @returns {Array<{ ts: number, equity: number }>}
 */
export function getEquitySnapshotsSince(sinceMs) {
  return getDb()
    .prepare('SELECT ts, equity FROM equity_snapshots WHERE ts >= ? ORDER BY ts ASC')
    .all(sinceMs);
}

/**
 * Возвращает последние N записей из истории.
 * @param {number} limit
 */
export function getHistory(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM history ORDER BY closed_at DESC LIMIT ?')
    .all(limit);
}

/**
 * Возвращает сделки, закрытые после указанного timestamp.
 * Используется для Daily Recap — выбирает сделки за текущий день.
 *
 * @param {number} sinceMs — Unix timestamp в миллисекундах
 * @returns {Array<Object>}
 */
export function getHistorySince(sinceMs) {
  return getDb()
    .prepare('SELECT * FROM history WHERE closed_at >= ? ORDER BY closed_at DESC')
    .all(sinceMs);
}

/**
 * Сделки стратегии/режима из ОБОИХ источников: live-таблица history + архив
 * (data/history_archive.json). Auto-Cleanup при простое бота чистит live-таблицу
 * (см. archiveAndClearHistory), поэтому статистика стратегий обязана читать архив,
 * иначе трек-рекорд обнуляется при каждом простое (инцидент 2026-06-14). Дедуп по
 * id на случай гонки архивации. Отсортировано closed_at ASC (старые → новые).
 */
function getStrategyHistoryMerged(strategyId, mode, side = null) {
  const live = getDb()
    .prepare('SELECT * FROM history WHERE strategy_id = ? AND mode = ?')
    .all(strategyId, mode);
  const archived = getArchivedHistorySince(0).filter(
    (r) => r.strategy_id === strategyId && r.mode === mode,
  );
  const seen = new Set();
  const merged = [];
  for (const r of [...archived, ...live]) {
    if (side && r.side !== side) continue;
    if (r.id != null) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
    }
    merged.push(r);
  }
  merged.sort((a, b) => (a.closed_at || 0) - (b.closed_at || 0));
  return merged;
}

/**
 * Stats для конкретной стратегии/режима — для dashboard карточки.
 * Возвращает n, sumNet, avgNet, worstNet, bestNet, winRate, lastClosedAt,
 * а также wins/losses/avgWin/avgLoss (для payoff = avgWin/|avgLoss|).
 * Читает live + архив (archive-aware), чтобы Auto-Cleanup не обнулял трек-рекорд.
 */
export function getStrategyStats(strategyId, mode, side = null) {
  const rows = getStrategyHistoryMerged(strategyId, mode, side);
  const n = rows.length;
  if (n === 0) {
    return {
      n: 0, sumNet: 0, avgNet: 0, worstNet: 0, bestNet: 0,
      wins: 0, losses: 0, avgWin: 0, avgLoss: 0, winRate: 0, lastClosedAt: null,
    };
  }
  let sumNet = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let worstNet = Infinity, bestNet = -Infinity, lastClosedAt = 0;
  for (const r of rows) {
    const net = (r.realized_pnl || 0) - (r.fee_paid || 0);
    sumNet += net;
    if (net > 0) { wins++; sumWin += net; } else { losses++; sumLoss += net; }
    if (net < worstNet) worstNet = net;
    if (net > bestNet) bestNet = net;
    if ((r.closed_at || 0) > lastClosedAt) lastClosedAt = r.closed_at;
  }
  return {
    n,
    sumNet,
    avgNet:       sumNet / n,
    worstNet,
    bestNet,
    wins,
    losses,
    avgWin:       wins > 0 ? sumWin / wins : 0,
    avgLoss:      losses > 0 ? sumLoss / losses : 0,
    winRate:      wins / n,
    lastClosedAt: lastClosedAt || null,
  };
}

/**
 * Упорядоченная по времени серия net-P&L закрытых сделок стратегии/режима.
 * Для спарклайна equity и расчёта max drawdown в обзорной таблице стратегий.
 * Archive-aware (live + архив). @returns {number[]} net P&L каждой сделки, старые → новые
 */
export function getStrategyNetSeries(strategyId, mode, limit = 100, side = null) {
  const rows = getStrategyHistoryMerged(strategyId, mode, side); // ASC
  // последние `limit` по времени, в хронологическом порядке
  return rows.slice(-limit).map((r) => (r.realized_pnl || 0) - (r.fee_paid || 0));
}

/**
 * Net P&L и число сделок стратегии/режима, закрытых после sinceMs.
 * Для summary «за день / за неделю» под таблицей paper-слота. Archive-aware.
 *
 * @returns {{ n: number, net: number }}
 */
export function getStrategyPnlSince(strategyId, mode, sinceMs, side = null) {
  const rows = getStrategyHistoryMerged(strategyId, mode, side).filter(
    (r) => (r.closed_at || 0) >= sinceMs,
  );
  const net = rows.reduce((s, r) => s + (r.realized_pnl || 0) - (r.fee_paid || 0), 0);
  return { n: rows.length, net };
}

/**
 * Записывает строку shadow-сравнения выходов (Hunter time-decay / chandelier).
 * position_id — PK → INSERT OR REPLACE (идемпотентно при повторном finalize).
 */
export function recordShadowExit(row) {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO shadow_exits (
        position_id, strategy_id, side, coin, closed_at, notional_usd,
        actual_pnl, actual_pct, td_pnl, td_pct, td_fired, td_min,
        ch_pnl, ch_pct, ch_fired, ch_min
      ) VALUES (
        @position_id, @strategy_id, @side, @coin, @closed_at, @notional_usd,
        @actual_pnl, @actual_pct, @td_pnl, @td_pct, @td_fired, @td_min,
        @ch_pnl, @ch_pct, @ch_fired, @ch_min
      )
    `)
    .run({
      td_min: row.td_min ?? null,
      ch_min: row.ch_min ?? null,
      notional_usd: row.notional_usd ?? null,
      actual_pct: row.actual_pct ?? null,
      td_pct: row.td_pct ?? null,
      ch_pct: row.ch_pct ?? null,
      ...row,
    });
}

/**
 * Агрегат shadow-выходов по стратегии (опц. сторона). Сравнивает суммарный
 * realized actual vs would-be time-decay / chandelier. Для колонок в /strategies.
 * @returns {{ n, actual, td, chandelier, tdFired, chFired }|null}
 */
export function getShadowAggregate(strategyId, side = null) {
  const sideClause = side ? ' AND side = ?' : '';
  const args = side ? [strategyId, side] : [strategyId];
  const row = getDb()
    .prepare(`
      SELECT
        COUNT(*)                AS n,
        COALESCE(SUM(actual_pnl), 0) AS actual,
        COALESCE(SUM(td_pnl), 0)     AS td,
        COALESCE(SUM(ch_pnl), 0)     AS chandelier,
        COALESCE(SUM(td_fired), 0)   AS td_fired,
        COALESCE(SUM(ch_fired), 0)   AS ch_fired
      FROM shadow_exits
      WHERE strategy_id = ?${sideClause}
    `)
    .get(...args);
  if (!row || row.n === 0) return null;
  return {
    n:          row.n,
    actual:     row.actual,
    td:         row.td,
    chandelier: row.chandelier,
    tdFired:    row.td_fired,
    chFired:    row.ch_fired,
  };
}

/**
 * Последние N сделок стратегии/режима для карточки на dashboard.
 */
export function getRecentStrategyTrades(strategyId, mode, limit = 10) {
  return getDb()
    .prepare(`
      SELECT coin, entry_time, closed_at, realized_pnl, fee_paid, reason,
             entry_price, close_price, side,
             mfe_usd, mae_usd, mfe_pct, mae_pct, hold_seconds
      FROM history
      WHERE strategy_id = ? AND mode = ?
      ORDER BY closed_at DESC
      LIMIT ?
    `)
    .all(strategyId, mode, limit);
}

/**
 * Страница сделок стратегии/режима (для пагинации в detail таблицы Strategies).
 * @returns {{ total:number, trades:Array<Object> }}
 */
export function getStrategyTradesPage(strategyId, mode, limit = 10, offset = 0, side = null) {
  // Archive-aware: live history + архив (Auto-Cleanup чистит live-таблицу).
  const all = getStrategyHistoryMerged(strategyId, mode, side); // ASC
  const total = all.length;
  // Нужен DESC (новые первыми) для пагинации, как в прежнем SQL.
  const desc = all.slice().reverse();
  const trades = desc.slice(offset, offset + limit).map((r) => ({
    coin: r.coin,
    entry_time: r.entry_time,
    closed_at: r.closed_at,
    realized_pnl: r.realized_pnl,
    fee_paid: r.fee_paid,
    reason: r.reason,
    entry_price: r.entry_price,
    close_price: r.close_price,
    side: r.side,
    hold_seconds: r.hold_seconds,
  }));
  return { total, trades };
}

/**
 * Возвращает заархивированные сделки, закрытые после указанного timestamp.
 * Читает данные из data/history_archive.json.
 *
 * @param {number} sinceMs — Unix timestamp в миллисекундах
 * @returns {Array<Object>}
 */
export function getArchivedHistorySince(sinceMs) {
  const ARCHIVE_PATH = 'data/history_archive.json';
  try {
    const raw = readFileSync(ARCHIVE_PATH, 'utf-8');
    const archive = JSON.parse(raw);
    if (!Array.isArray(archive)) return [];

    return archive.filter((r) => r.closed_at >= sinceMs);
  } catch {
    // файл не существует или пуст
    return [];
  }
}

/**
 * Фильтрует сделки до реальных (mode='PRODUCTION'), когда бот работает в проде.
 * В PAPER-боте возвращает список без изменений. Используется во всех P&L-сводках
 * и лентах активности, чтобы shadow/paper-эксперименты (напр. выключенный Chill Boy)
 * не подмешивались в реальную статистику счёта.
 *
 * @param {Array<Object>} trades
 * @returns {Array<Object>}
 */
export function realTradesForDisplay(trades) {
  if (!config.isProduction) return trades;
  return trades.filter((t) => t.mode === 'PRODUCTION');
}

/**
 * Архивирует всю историю в data/history_archive.json и очищает таблицу history.
 *
 * Файл архива — JSON-массив. При повторных вызовах записи дописываются
 * (append) к существующему массиву, дедупликация по id.
 *
 * @returns {number} кол-во заархивированных записей
 */
const SETUP_SNAPSHOT_RETENTION_MS = 90 * 24 * 3_600_000;

/**
 * Bulk-insert snapshot batch (одна транзакция). Дубли по (coin, ts) игнорятся.
 * Используется scout'ом раз в SETUP_SNAPSHOT_INTERVAL_MIN.
 * @param {Array<{coin,ts,funding_rate,funding_apy,oi_usd,mark,premium,vol_24h_usd}>} rows
 */
export function recordSetupSnapshots(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO setup_snapshots
      (coin, ts, funding_rate, funding_apy, oi_usd, mark, premium, vol_24h_usd)
    VALUES (@coin, @ts, @funding_rate, @funding_apy, @oi_usd, @mark, @premium, @vol_24h_usd)
  `);
  const tx = getDb().transaction((batch) => {
    for (const r of batch) stmt.run(r);
  });
  tx(rows);
  getDb()
    .prepare('DELETE FROM setup_snapshots WHERE ts < ?')
    .run(Date.now() - SETUP_SNAPSHOT_RETENTION_MS);
  return rows.length;
}

/**
 * Возвращает агрегированные данные для Setup Scanner-карточки.
 * Для каждой монеты: current snapshot + history-derived поля (funding persist 48h,
 * OI/price delta 7d, vol regime 30d). Поля с недостаточной историей возвращают
 * { ageHours, eta_hours } — UI показывает "collecting · ETA …".
 *
 * Тяжёлой работы нет — берём окно 30d (≤36k rows для top-50) и агрегируем в JS.
 */
export function getSetupScannerRows() {
  const now = Date.now();
  const sinceMs = now - 30 * 86_400_000;
  const rows = getDb()
    .prepare(`
      SELECT coin, ts, funding_rate, funding_apy, oi_usd, mark, premium, vol_24h_usd
      FROM setup_snapshots
      WHERE ts >= ?
      ORDER BY coin, ts ASC
    `)
    .all(sinceMs);

  const byCoin = new Map();
  for (const r of rows) {
    if (!byCoin.has(r.coin)) byCoin.set(r.coin, []);
    byCoin.get(r.coin).push(r);
  }

  const H48 = now - 48 * 3_600_000;
  const D7  = now - 7  * 86_400_000;
  const H48_FULL = 48;
  const D7_FULL  = 7 * 24;
  const D30_FULL = 30 * 24;

  const out = [];
  for (const [coin, arr] of byCoin) {
    const last = arr[arr.length - 1];

    // 48h funding persist
    const f48 = arr.filter((r) => r.ts >= H48 && r.funding_apy != null);
    const f48Age = f48.length ? (now - f48[0].ts) / 3_600_000 : 0;
    const extreme = f48.filter((r) => Math.abs(r.funding_apy) > 30).length;
    const fundingPersist = f48Age >= H48_FULL - 1 && f48.length
      ? { ageHours: f48Age, fractionExtreme: extreme / f48.length, samples: f48.length }
      : { ageHours: f48Age, etaHours: Math.max(0, H48_FULL - f48Age) };

    // 7d OI/price delta
    const w7 = arr.filter((r) => r.ts >= D7);
    const w7Age = w7.length ? (now - w7[0].ts) / 3_600_000 : 0;
    const w7First = w7[0];
    const oi7d = w7Age >= D7_FULL - 1 && w7First?.oi_usd && last.oi_usd != null
      ? {
          ageHours: w7Age,
          deltaOi: (last.oi_usd - w7First.oi_usd) / w7First.oi_usd,
          deltaPx: w7First.mark ? (last.mark - w7First.mark) / w7First.mark : null,
        }
      : { ageHours: w7Age, etaHours: Math.max(0, D7_FULL - w7Age) };

    // 30d vol regime
    const v30 = arr.filter((r) => r.vol_24h_usd != null);
    const v30Age = v30.length ? (now - v30[0].ts) / 3_600_000 : 0;
    const avgVol30d = v30.length
      ? v30.reduce((s, r) => s + r.vol_24h_usd, 0) / v30.length
      : null;
    const volRegime = v30Age >= D30_FULL - 1 && avgVol30d && last.vol_24h_usd != null
      ? { ageHours: v30Age, ratio: last.vol_24h_usd / avgVol30d }
      : { ageHours: v30Age, etaHours: Math.max(0, D30_FULL - v30Age) };

    out.push({
      coin,
      ts: last.ts,
      fundingApy: last.funding_apy,
      fundingRate: last.funding_rate,
      mark: last.mark,
      premium: last.premium,
      oiUsd: last.oi_usd,
      vol24hUsd: last.vol_24h_usd,
      fundingPersist,
      oi7d,
      volRegime,
    });
  }
  return out;
}

export function archiveAndClearHistory() {
  const ARCHIVE_PATH = 'data/history_archive.json';

  const rows = getDb()
    .prepare('SELECT * FROM history ORDER BY closed_at ASC')
    .all();

  if (rows.length === 0) {
    logger.info('[DB] Archive skipped — history is empty');
    return 0;
  }

  // Читаем существующий архив (если есть)
  let existing = [];
  try {
    const raw = readFileSync(ARCHIVE_PATH, 'utf-8');
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [];
  } catch {
    // файл не существует или повреждён — начинаем с нуля
  }

  // Дедупликация по id + closed_at
  const existingKeys = new Set(
    existing.map((r) => `${r.id}_${r.closed_at}`),
  );
  const newRows = rows.filter(
    (r) => !existingKeys.has(`${r.id}_${r.closed_at}`),
  );

  const merged = [...existing, ...newRows];
  // Атомарная запись через tmp + rename — как saveBotState/balanceCache.
  // Прямой writeFileSync открывал бы существующий файл на запись и падал с
  // EACCES, если владелец файла (opc) ≠ UID процесса в контейнере (node).
  // rename требует прав только на директорию data/ (она 777).
  const tmpPath = `${ARCHIVE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  renameSync(tmpPath, ARCHIVE_PATH);

  // Очищаем таблицу history
  getDb().prepare('DELETE FROM history').run();

  logger.info(
    `[DB] ✅ Archived ${newRows.length} new records (${merged.length} total) → ${ARCHIVE_PATH} | history cleared`,
  );

  return newRows.length;
}
