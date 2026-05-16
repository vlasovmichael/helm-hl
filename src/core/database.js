import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from './logger.js';
import { config } from './config.js';

mkdirSync('data', { recursive: true });

const DB_PATH = 'data/trades.db';

let db;

export function initDB() {
  db = new Database(DB_PATH);

  // WAL-mode: читатели не блокируют писателей
  db.pragma('journal_mode = WAL');
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

  logger.info(`[DB] Initialized at ${DB_PATH}`);
  return db;
}

export function getRawDb() {
  return getDb();
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
    entry_hour_utc:       null,
    ...data,
  };
  const stmt = getDb().prepare(`
    INSERT INTO positions (
      coin, size_usd, entry_price, entry_apy, entry_time, mode,
      strategy_id, sl_price, tp_price, entry_equity, side,
      hunter_sl_oid, hunter_tp_oid,
      entry_spike_pct, entry_trend_15m_pct, entry_trend_1h_pct,
      entry_funding_rate, entry_volume_24h_usd, entry_oi_usd, entry_hour_utc
    )
    VALUES (
      @coin, @size_usd, @entry_price, @entry_apy, @entry_time, @mode,
      @strategy_id, @sl_price, @tp_price, @entry_equity, @side,
      @hunter_sl_oid, @hunter_tp_oid,
      @entry_spike_pct, @entry_trend_15m_pct, @entry_trend_1h_pct,
      @entry_funding_rate, @entry_volume_24h_usd, @entry_oi_usd, @entry_hour_utc
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
      entry_funding_rate, entry_volume_24h_usd, entry_oi_usd, entry_hour_utc,
      mfe_usd, mae_usd, mfe_pct, mae_pct, hold_seconds,
      entry_time, funding_collected
    )
    VALUES (
      @coin, @entry_price, @close_price, @realized_pnl, @fee_paid, @mode, @closed_at, @reason, @strategy_id, @side,
      @entry_spike_pct, @entry_trend_15m_pct, @entry_trend_1h_pct,
      @entry_funding_rate, @entry_volume_24h_usd, @entry_oi_usd, @entry_hour_utc,
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
      closed_at:    Date.now(),
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
  return getDb()
    .prepare('SELECT * FROM positions WHERE status = ? AND mode = ? ORDER BY id DESC LIMIT 1')
    .get('OPEN', mode);
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
 * Архивирует всю историю в data/history_archive.json и очищает таблицу history.
 *
 * Файл архива — JSON-массив. При повторных вызовах записи дописываются
 * (append) к существующему массиву, дедупликация по id.
 *
 * @returns {number} кол-во заархивированных записей
 */
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
  writeFileSync(ARCHIVE_PATH, JSON.stringify(merged, null, 2), 'utf-8');

  // Очищаем таблицу history
  getDb().prepare('DELETE FROM history').run();

  logger.info(
    `[DB] ✅ Archived ${newRows.length} new records (${merged.length} total) → ${ARCHIVE_PATH} | history cleared`,
  );

  return newRows.length;
}
