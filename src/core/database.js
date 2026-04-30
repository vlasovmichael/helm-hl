import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from './logger.js';

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

  // Migration: entry_equity — equity аккаунта в момент OPEN.
  // Используется в integrity.js для корректной оценки PnL при external close
  // (старая формула equity − size_usd была математически неверной).
  if (!posColumns.find(c => c.name === 'entry_equity')) {
    db.exec('ALTER TABLE positions ADD COLUMN entry_equity REAL');
    logger.info('[DB] Migration: added entry_equity to positions');
  }

  logger.info(`[DB] Initialized at ${DB_PATH}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

/**
 * Сохраняет новую открытую позицию и возвращает её id.
 * @param {{ coin, size_usd, entry_price, entry_apy, entry_time, mode, strategy_id?, sl_price?, tp_price? }} data
 */
export function savePosition(data) {
  const row = {
    strategy_id:  'carry',
    sl_price:     null,
    tp_price:     null,
    entry_equity: null,
    ...data,
  };
  const stmt = getDb().prepare(`
    INSERT INTO positions (coin, size_usd, entry_price, entry_apy, entry_time, mode, strategy_id, sl_price, tp_price, entry_equity)
    VALUES (@coin, @size_usd, @entry_price, @entry_apy, @entry_time, @mode, @strategy_id, @sl_price, @tp_price, @entry_equity)
  `);
  const result = stmt.run(row);
  return result.lastInsertRowid;
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
    INSERT INTO history (coin, entry_price, close_price, realized_pnl, fee_paid, mode, closed_at, reason, strategy_id)
    VALUES (@coin, @entry_price, @close_price, @realized_pnl, @fee_paid, @mode, @closed_at, @reason, @strategy_id)
  `);

  const updatePosition = getDb().prepare(
    'UPDATE positions SET status = ? WHERE id = ?',
  );

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
    });
    updatePosition.run('CLOSED', id);
  });

  tx();
}

/**
 * Возвращает активную (OPEN) позицию или undefined.
 */
export function getActivePosition() {
  return getDb()
    .prepare('SELECT * FROM positions WHERE status = ? ORDER BY id DESC LIMIT 1')
    .get('OPEN');
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
