import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'fs';
import { logger } from './logger.js';
import { config } from './config.js';

mkdirSync('data', { recursive: true });

const DB_PATH = 'data/trades.db';

let db;

export function initDB() {
  db = new Database(DB_PATH);

  // WAL-mode: читатели не блокируют писателей
  db.pragma('journal_mode = WAL');
  // synchronous=FULL: fsync на каждый commit. 🚨 NORMAL оставляет окно, где
  // SIGTERM попадает между write и fsync — база бьётся при рестарте контейнера.
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

  // Migration: нотионал сделки в архив. Без него доходность в процентах от
  // собственного размера не посчитать, а сравнивать сделки в долларах нельзя —
  // размер у ручных входов плавает по слайдеру.
  if (!histColumns.find(c => c.name === 'size_usd')) {
    db.exec('ALTER TABLE history ADD COLUMN size_usd REAL');
    logger.info('[DB] Migration: added size_usd to history');
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

  // initial_sl_price — стоп НА МОМЕНТ ВХОДА, эталон шкалы R. 🚨 Считать R от
  // текущего sl_price нельзя: трейл двигает его за пиком, и шкала съезжает.
  if (!posColumns.find(c => c.name === 'initial_sl_price')) {
    db.exec('ALTER TABLE positions ADD COLUMN initial_sl_price REAL');
    logger.info('[DB] Migration: added initial_sl_price to positions');
  }

  // hunter_sl_oid / hunter_tp_oid — id'шники trigger-ордеров на бирже: по ним
  // reconciler понимает, какой триггер сработал, и отменяет при soft-exit.
  if (!posColumns.find(c => c.name === 'hunter_sl_oid')) {
    db.exec('ALTER TABLE positions ADD COLUMN hunter_sl_oid INTEGER');
    logger.info('[DB] Migration: added hunter_sl_oid to positions');
  }
  if (!posColumns.find(c => c.name === 'hunter_tp_oid')) {
    db.exec('ALTER TABLE positions ADD COLUMN hunter_tp_oid INTEGER');
    logger.info('[DB] Migration: added hunter_tp_oid to positions');
  }

  // entry_equity — equity аккаунта в момент OPEN. По нему integrity.js
  // оценивает PnL при external close.
  if (!posColumns.find(c => c.name === 'entry_equity')) {
    db.exec('ALTER TABLE positions ADD COLUMN entry_equity REAL');
    logger.info('[DB] Migration: added entry_equity to positions');
  }

  // leverage — плечо позиции: ROE% = price-move% × leverage. Nullable, боту
  // не нужно.
  if (!posColumns.find(c => c.name === 'leverage')) {
    db.exec('ALTER TABLE positions ADD COLUMN leverage REAL');
    logger.info('[DB] Migration: added leverage to positions');
  }

  // side — направление позиции ('short' | 'long'). Default 'short' — ради
  // старых записей, стратегии задают его явно.
  if (!posColumns.find(c => c.name === 'side')) {
    db.exec("ALTER TABLE positions ADD COLUMN side TEXT NOT NULL DEFAULT 'short' CHECK (side IN ('short', 'long'))");
    logger.info('[DB] Migration: added side to positions');
  }
  if (!histColumns.find(c => c.name === 'side')) {
    db.exec("ALTER TABLE history ADD COLUMN side TEXT NOT NULL DEFAULT 'short' CHECK (side IN ('short', 'long'))");
    logger.info('[DB] Migration: added side to history');
  }

  // Hunter entry features — фичи рынка в момент OPEN. Nullable, зеркалятся в
  // обе таблицы, чтобы пережить close.
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

  // history.entry_time для utilization в дашборде. Где hold_seconds NULL —
  // остаётся NULL, UI отрисует «—».
  if (!histColumns.find(c => c.name === 'entry_time')) {
    db.exec('ALTER TABLE history ADD COLUMN entry_time INTEGER');
    db.exec(`
      UPDATE history
      SET entry_time = closed_at - hold_seconds * 1000
      WHERE entry_time IS NULL AND hold_seconds IS NOT NULL
    `);
    logger.info('[DB] Migration: added entry_time to history (+ backfilled from hold_seconds)');
  }

  // funding_collected — best-effort разделение funding и ценового PnL,
  // берётся при close из userFunding API.
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

  // Bot order id log — отделяет ботовские fills от ручных в дашборде.
  // 🚨 По времени входа это не работает: bot.entry_time расходится с fill.time
  // на 100–1000мс, и ботовские fills утекают в ручную реконструкцию. Пишем
  // каждый фактический oid из ответа placeOrder.
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

  // Candy Girl signal log — сигнал + авто-резолв (TP раньше SL = win, наоборот
  // = loss, ни то ни другое за таймаут = timeout). Точность радара меряется тут.
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

  // Shadow exits — measurement-only сравнение реального выхода с альтернативными
  // (time-decay TP, chandelier ATR-trail). Строка на закрытую позицию, питает
  // /strategies. position_id = PK → INSERT OR REPLACE идемпотентен.
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

  // Day journal — заметка дня для разбора по клику в календаре Insights.
  // Строка на локальную дату YYYY-MM-DD, на торговлю не влияет.
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_journal (
      date       TEXT    PRIMARY KEY,
      note       TEXT    NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);

  // Coin of the day — АРХИВ закрытого замера. Писателей нет, таблица оставлена
  // ради самих данных: по ним принято решение снять карточку.
  // перепроверить вывод. Два последних пика остались в статусе open: резолвер
  // снят вместе с карточкой, дорезолвивать замороженный лог смысла нет.
  db.exec(`
    CREATE TABLE IF NOT EXISTS coin_of_day_picks (
      date        TEXT    NOT NULL,
      coin        TEXT    NOT NULL,
      side        TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      score       INTEGER NOT NULL,
      entry       REAL    NOT NULL,
      stop        REAL    NOT NULL,
      target      REAL    NOT NULL,
      rr          REAL,
      risk_pct    REAL,
      flags       TEXT,
      status      TEXT    NOT NULL DEFAULT 'open',
      resolved_at INTEGER,
      exit_price  REAL,
      exit_pct    REAL,
      outcome_r   REAL,
      mfe_pct     REAL,
      mae_pct     REAL,
      PRIMARY KEY (date, coin)
    );
    CREATE INDEX IF NOT EXISTS coin_of_day_status_idx ON coin_of_day_picks (status);
  `);

  // Форвард-лог «Монеты дня», версия 2. Старая таблица выше —
  // архив закрытого замера, её не трогаем.
  //
  // 🚨 Мерим ДРУГОЕ. Версия 1 писала исход по стопу/цели и упиралась в таймаут
  // 2ч: цель бралась 1 раз из 103, то есть замер отвечал на вопрос «успевает ли
  // сетап за два часа», а не «есть ли в нём что-то». Здесь исход — чистый ход
  // цены на 4/8/24ч, без стопа и без срока. Юзер прямо сказал, что смотрел
  // именно эти горизонты («подождать 4-6-8 часов»).
  //
  // 🚨 Рядом пишется ход BTC за ТО ЖЕ окно. Без этого столбца лог не отвечает
  // на главный вопрос («или так совпало с ценой битка») — падение альты на
  // общем сливе рынка неотличимо от отработки фейда. Решение принимается по
  // excess = chg − btc, а не по chg.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cod_forward (
      date        TEXT    NOT NULL,
      coin        TEXT    NOT NULL,
      side        TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      score       INTEGER NOT NULL,
      entry       REAL    NOT NULL,
      stop        REAL,
      risk_pct    REAL,
      chg24h_at   REAL,
      flags       TEXT,
      btc_at      REAL,
      chg_4h      REAL,
      chg_8h      REAL,
      chg_24h     REAL,
      btc_4h      REAL,
      btc_8h      REAL,
      btc_24h     REAL,
      resolved_at INTEGER,
      PRIMARY KEY (date, coin)
    );
    CREATE INDEX IF NOT EXISTS cod_forward_created_idx ON cod_forward (created_at);
  `);

  // Журнал сигналов TG-каналов. Строка на КАЖДЫЙ разобранный пост, включая
  // пропущенные: без отказов «канал молчал» неотличимо от «не смогли открыть».
  // UNIQUE(channel, post_id) — идемпотентность опроса.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_signals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT    NOT NULL,
      post_id     INTEGER NOT NULL,
      posted_at   INTEGER NOT NULL,
      seen_at     INTEGER NOT NULL,
      coin        TEXT    NOT NULL,
      side        TEXT    NOT NULL,
      excerpt     TEXT,
      status      TEXT    NOT NULL,
      skip_reason TEXT,
      position_id INTEGER,
      entry_price REAL,
      UNIQUE (channel, post_id)
    );
    CREATE INDEX IF NOT EXISTS tg_signals_posted_idx ON tg_signals (posted_at);
    CREATE INDEX IF NOT EXISTS tg_signals_status_idx ON tg_signals (status);
  `);

  // Витрина каналов: их собственные заявления о результате. Рядом с нашими
  // фактическими сделками это вторая половина сравнения — что канал рисует.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_claims (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      channel    TEXT    NOT NULL,
      post_id    INTEGER NOT NULL,
      posted_at  INTEGER NOT NULL,
      coin       TEXT    NOT NULL,
      pct        REAL    NOT NULL,
      win        INTEGER NOT NULL,
      leverage   REAL,
      pct_at_1x  REAL,
      excerpt    TEXT,
      UNIQUE (channel, post_id)
    );
    CREATE INDEX IF NOT EXISTS tg_claims_posted_idx ON tg_claims (posted_at);
  `);

  // Издержки исполнения — строка на КАЖДЫЙ свой филл. Питает форвард-гипотезы
  // про мейкера, проскальзывание стопов и стоимость часа. Всё, что тут лежит,
  // приходит из ленты филлов даром: ни одного лишнего запроса к бирже.
  // tid уникален у HL → повторная запись при реконнекте ничего не портит.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fill_costs (
      tid          INTEGER PRIMARY KEY,
      ts           INTEGER NOT NULL,
      coin         TEXT    NOT NULL,
      dex          TEXT,
      dir          TEXT    NOT NULL,
      is_open      INTEGER NOT NULL,
      side         TEXT,
      px           REAL    NOT NULL,
      sz           REAL    NOT NULL,
      notional     REAL    NOT NULL,
      fee          REAL    NOT NULL,
      fee_bp       REAL    NOT NULL,
      crossed      INTEGER NOT NULL,
      hour_utc     INTEGER NOT NULL,
      oid          INTEGER,
      -- Плановый стоп позиции на момент филла: разница с px и есть
      -- проскальзывание триггера. null, если позы в БД не было.
      planned_sl   REAL,
      slip_bp      REAL,
      -- Задержка от ближайшего пуша по этой же монете, мс. null, если пуша не было.
      alert_lag_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS fill_costs_ts_idx ON fill_costs (ts);
    CREATE INDEX IF NOT EXISTS fill_costs_coin_idx ON fill_costs (coin);
  `);

  // Площадки HIP-3: фандинг и спред по часам. Истории у этих DEX'ов почти нет,
  // поэтому бэктестить нечего — только копить вперёд.
  db.exec(`
    CREATE TABLE IF NOT EXISTS venue_snapshots (
      ts        INTEGER NOT NULL,
      dex       TEXT    NOT NULL,
      coin      TEXT    NOT NULL,
      mid       REAL,
      spread_bp REAL,
      funding   REAL,
      oi_usd    REAL,
      PRIMARY KEY (ts, dex, coin)
    );
    CREATE INDEX IF NOT EXISTS venue_snapshots_ts_idx ON venue_snapshots (ts);
    CREATE INDEX IF NOT EXISTS venue_snapshots_dex_idx ON venue_snapshots (dex);
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
/**
 * Роль oid'а в bot_oid_log ('sl_trigger' | 'tp_trigger' | …), либо null.
 *
 * Нужна классификации закрытий: в positions лежит ровно один hunter_tp_oid, а
 * целей у позиции может быть несколько (ступени TP-сетки, см. tpGrid.js). Без
 * этого справочника фил по ступени читался бы как ручное закрытие.
 */
export function getBotOidKind(oid) {
  if (oid == null || !Number.isFinite(Number(oid))) return null;
  try {
    const row = getDb()
      .prepare('SELECT kind FROM bot_oid_log WHERE oid = ?')
      .get(Number(oid));
    return row?.kind ?? null;
  } catch (err) {
    logger.warn(`[DB] getBotOidKind(${oid}) failed: ${err.message}`);
    return null;
  }
}

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
    leverage:      null,
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
  // 1R = дистанция вход→стоп НА ВХОДЕ. Трейл-пол двигает sl_price, поэтому
  // эталон обязан лежать отдельно; кто его не передал — берём текущий стоп.
  if (row.initial_sl_price == null) row.initial_sl_price = row.sl_price ?? null;
  const stmt = getDb().prepare(`
    INSERT INTO positions (
      coin, size_usd, entry_price, entry_apy, entry_time, mode,
      strategy_id, sl_price, initial_sl_price, tp_price, entry_equity, leverage, side,
      hunter_sl_oid, hunter_tp_oid,
      entry_spike_pct, entry_trend_15m_pct, entry_trend_1h_pct,
      entry_funding_rate, entry_volume_24h_usd, entry_oi_usd,
      entry_oi_delta_2m, entry_oi_delta_5m, entry_oi_delta_15m, entry_hour_utc
    )
    VALUES (
      @coin, @size_usd, @entry_price, @entry_apy, @entry_time, @mode,
      @strategy_id, @sl_price, @initial_sl_price, @tp_price, @entry_equity, @leverage, @side,
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
/**
 * Подвинуть записанный стоп позиции. Нужен трейлу-полу: уровень живёт биржевым
 * ордером, и БД обязана совпадать с ним, иначе R и «locked» на карточке будут
 * считаться от устаревшей цены.
 */
export function updatePositionStop(id, slPrice) {
  if (!(slPrice > 0)) return;
  getDb().prepare('UPDATE positions SET sl_price = ? WHERE id = ?').run(slPrice, id);
}

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
      size_usd,
      entry_spike_pct, entry_trend_15m_pct, entry_trend_1h_pct,
      entry_funding_rate, entry_volume_24h_usd, entry_oi_usd,
      entry_oi_delta_2m, entry_oi_delta_5m, entry_oi_delta_15m, entry_hour_utc,
      mfe_usd, mae_usd, mfe_pct, mae_pct, hold_seconds,
      entry_time, funding_collected
    )
    VALUES (
      @coin, @entry_price, @close_price, @realized_pnl, @fee_paid, @mode, @closed_at, @reason, @strategy_id, @side,
      @size_usd,
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
      size_usd:     position.size_usd,
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
      // Dashboard P&L breakdown: entry_time для slot utilization,
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
  //. strategy_id IS NULL = легаси carry, оставляем.
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
 * Все активные (OPEN) позиции личного paper-журнала (strategy_id='manual_paper',
 * mode='PAPER'). Multi-slot, как adopt: оператор открывает несколько ручных бумажных
 * входов руками (модалка на дашборде), бот их не торгует — только держит цену
 * свежей (getActivePaperCoins пиннит) и считает mark-to-market. Возвращает массив.
 */
export function getActiveManualPaperPositions() {
  return getDb()
    .prepare("SELECT * FROM positions WHERE status = 'OPEN' AND mode = 'PAPER' AND strategy_id = 'manual_paper' ORDER BY id ASC")
    .all();
}

/** Стратегии, чей выход ведёт бумажная нянька (app/manualPaperSupervise.js). */
export const PAPER_NANNY_STRATEGIES = ['manual_paper', 'tg_signal'];

/** Все активные бумажные позы под нянькой — и ручные, и сигнальные. */
export function getActivePaperNannyPositions(strategies = PAPER_NANNY_STRATEGIES) {
  const ids = strategies.filter((s) => PAPER_NANNY_STRATEGIES.includes(s));
  if (ids.length === 0) return [];
  return getDb()
    .prepare(
      `SELECT * FROM positions WHERE status = 'OPEN' AND mode = 'PAPER'
         AND strategy_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY id ASC`,
    )
    .all(...ids);
}

/** Активные (OPEN) позы, открытые по сигналам TG-каналов. */
export function getActiveTgSignalPositions() {
  return getDb()
    .prepare("SELECT * FROM positions WHERE status = 'OPEN' AND mode = 'PAPER' AND strategy_id = 'tg_signal' ORDER BY id ASC")
    .all();
}

/** Записать пост в журнал. INSERT OR IGNORE: повторный опрос отдаёт те же посты.
 *  @returns {number|null} id строки, null если уже была. */
export function recordTgSignal(sig) {
  const res = getDb()
    .prepare(`INSERT OR IGNORE INTO tg_signals
        (channel, post_id, posted_at, seen_at, coin, side, excerpt, status, skip_reason, position_id, entry_price)
      VALUES (@channel, @post_id, @posted_at, @seen_at, @coin, @side, @excerpt, @status, @skip_reason, @position_id, @entry_price)`)
    .run({
      channel: sig.channel,
      post_id: sig.postId,
      posted_at: sig.postedAt,
      seen_at: Date.now(),
      coin: sig.coin,
      side: sig.side,
      excerpt: sig.excerpt ?? null,
      status: sig.status,
      skip_reason: sig.skipReason ?? null,
      position_id: sig.positionId ?? null,
      entry_price: sig.entryPrice ?? null,
    });
  return res.changes ? Number(res.lastInsertRowid) : null;
}

/** Виден ли пост канала журналу (уже разобран на прошлом круге). */
export function isTgPostSeen(channel, postId) {
  return !!getDb()
    .prepare('SELECT 1 FROM tg_signals WHERE channel = ? AND post_id = ?')
    .get(channel, Number(postId));
}

/** Максимальный разобранный post_id канала (0, если журнал пуст). */
export function lastTgPostId(channel) {
  const row = getDb()
    .prepare('SELECT MAX(post_id) AS mx FROM tg_signals WHERE channel = ?')
    .get(channel);
  return Number(row?.mx) || 0;
}

/** Был ли такой сигнал за windowMs. Каналы дублируют пост — без окна один
 *  прогноз открыл бы две позы и удвоил вес канала. */
export function hasRecentTgSignal(coin, side, windowMs) {
  return !!getDb()
    .prepare("SELECT 1 FROM tg_signals WHERE coin = ? AND side = ? AND status = 'opened' AND posted_at >= ?")
    .get(String(coin).toUpperCase(), side, Date.now() - windowMs);
}

/** Записать заявленный каналом результат. Идемпотентно по (channel, post_id). */
export function recordTgClaim(c) {
  const res = getDb()
    .prepare(`INSERT OR IGNORE INTO tg_claims
        (channel, post_id, posted_at, coin, pct, win, leverage, pct_at_1x, excerpt)
      VALUES (@channel, @post_id, @posted_at, @coin, @pct, @win, @leverage, @pct_at_1x, @excerpt)`)
    .run({
      channel: c.channel,
      post_id: c.postId,
      posted_at: c.postedAt,
      coin: c.coin,
      pct: c.pct,
      win: c.win ? 1 : 0,
      leverage: c.leverage ?? null,
      pct_at_1x: c.pctAt1x ?? null,
      excerpt: c.excerpt ?? null,
    });
  return res.changes ? Number(res.lastInsertRowid) : null;
}

/** Заявленные каналами результаты, свежие сверху. */
export function getTgClaims(limit = 400) {
  return getDb()
    .prepare('SELECT * FROM tg_claims ORDER BY posted_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(2000, Number(limit) || 400)));
}

/** Записать издержки филла. Идемпотентно по tid. */
export function recordFillCost(row) {
  const res = getDb()
    .prepare(`INSERT OR IGNORE INTO fill_costs
        (tid, ts, coin, dex, dir, is_open, side, px, sz, notional, fee, fee_bp,
         crossed, hour_utc, oid, planned_sl, slip_bp, alert_lag_ms)
      VALUES (@tid, @ts, @coin, @dex, @dir, @is_open, @side, @px, @sz, @notional, @fee, @fee_bp,
              @crossed, @hour_utc, @oid, @planned_sl, @slip_bp, @alert_lag_ms)`)
    .run(row);
  return res.changes > 0;
}

/** Строки издержек за период (по умолчанию всё). */
export function getFillCosts(sinceMs = 0) {
  return getDb()
    .prepare('SELECT * FROM fill_costs WHERE ts >= ? ORDER BY ts ASC')
    .all(Number(sinceMs) || 0);
}

/** Открытая позиция по монете (любой стратегии) — нужна для планового стопа. */
export function getOpenPositionByCoin(coin) {
  return getDb()
    .prepare("SELECT * FROM positions WHERE status = 'OPEN' AND coin = ? ORDER BY id DESC LIMIT 1")
    .get(String(coin).toUpperCase());
}

/** Снимок площадки. Идемпотентно по (ts, dex, coin). */
export function recordVenueSnapshot(row) {
  return getDb()
    .prepare(`INSERT OR IGNORE INTO venue_snapshots (ts, dex, coin, mid, spread_bp, funding, oi_usd)
              VALUES (@ts, @dex, @coin, @mid, @spread_bp, @funding, @oi_usd)`)
    .run(row).changes > 0;
}

/** Снимки площадок за период. */
export function getVenueSnapshots(sinceMs = 0) {
  return getDb()
    .prepare('SELECT * FROM venue_snapshots WHERE ts >= ? ORDER BY ts ASC')
    .all(Number(sinceMs) || 0);
}

/** Журнал сигналов, свежие сверху. */
export function getTgSignals(limit = 100) {
  return getDb()
    .prepare('SELECT * FROM tg_signals ORDER BY posted_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(1000, Number(limit) || 100)));
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

// Держим 3 года: Performance-график «All» должен показывать ВСЮ жизнь счёта
// (депозиты-ступеньки, пики вроде $115). Строка снапшота ~16 байт, 288/день ×
// 3 года ≈ 315k строк ≈ пара МБ — пренебрежимо. Раньше было 35 дней и обрезало
// старые пики.
const EQUITY_SNAPSHOT_RETENTION_MS = 1095 * 24 * 3_600_000; // 3 года

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
 * Дотягивает недостающие equity-точки (напр. из портфельного API HL) — вставляет
 * только те, рядом с которыми (±toleranceMs) НЕТ своего снапшота. Так заполняются
 * провалы/предыстория, а плотные локальные 5-мин точки не задваиваются и не
 * перетираются. Нулевые/отрицательные equity игнорируются.
 * @param {Array<{ts:number, equity:number}>} points
 * @param {number} [toleranceMs=1800000] окно «рядом есть точка» (30 мин)
 * @returns {number} сколько вставлено
 */
export function backfillEquityGaps(points, toleranceMs = 30 * 60_000) {
  const db = getDb();
  const near = db.prepare('SELECT 1 FROM equity_snapshots WHERE ts BETWEEN ? AND ? LIMIT 1');
  const ins = db.prepare('INSERT OR IGNORE INTO equity_snapshots (ts, equity) VALUES (?, ?)');
  let inserted = 0;
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      if (!Number.isFinite(p.ts) || !Number.isFinite(p.equity) || p.equity <= 0) continue;
      if (near.get(p.ts - toleranceMs, p.ts + toleranceMs)) continue;
      ins.run(p.ts, p.equity);
      inserted += 1;
    }
  });
  tx(Array.isArray(points) ? points : []);
  return inserted;
}

/** Убирает мусорные нулевые/отрицательные equity-точки (напр. стартовый $0). */
export function purgeNonPositiveEquity() {
  return getDb().prepare('DELETE FROM equity_snapshots WHERE equity <= 0').run().changes;
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

// ── Day journal — заметка дня для календаря Insights ──
// date = локальный ключ YYYY-MM-DD (как daily-хитмап в pnl.js).
export function getDayNote(date) {
  const row = getDb()
    .prepare('SELECT note FROM day_journal WHERE date = ?')
    .get(date);
  return row?.note ?? '';
}

// Пустая заметка удаляет строку (чистим, чтобы не копить мусор).
export function setDayNote(date, note) {
  const db = getDb();
  const text = String(note ?? '').trim();
  if (!text) {
    db.prepare('DELETE FROM day_journal WHERE date = ?').run(date);
    return;
  }
  db.prepare(
    `INSERT INTO day_journal (date, note, updated_at)
     VALUES (?, ?, unixepoch() * 1000)
     ON CONFLICT(date) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).run(date, text);
}

/**
 * Сделки стратегии/режима из ОБОИХ источников: live-таблица history + архив
 * (data/history_archive.json). Auto-Cleanup при простое бота чистит live-таблицу
 * (см. archiveAndClearHistory), поэтому статистика стратегий обязана читать архив,
 * иначе трек-рекорд обнуляется при каждом простое. Дедуп по
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
 * ВСЕ закрытые сделки режима из обоих источников (live-таблица + архив), деду́п по
 * id. Для страницы «Разбор моих сделок» — нужен разрез по стороне/стратегии/монете
 * сразу, а не по одной стратегии. Archive-aware по той же причине, что и
 * getStrategyHistoryMerged (Auto-Cleanup чистит live-таблицу при простое).
 * @param {('PAPER'|'PRODUCTION')} mode
 * @returns {Array<Object>} сделки, старые → новые
 */
export function getAllTradesMerged(mode = 'PRODUCTION') {
  const live = getDb().prepare('SELECT * FROM history WHERE mode = ?').all(mode);
  const archived = getArchivedHistorySince(0).filter((r) => r.mode === mode);
  const seen = new Set();
  const merged = [];
  for (const r of [...archived, ...live]) {
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
/** Закрытые сделки стратегии (live + архив), старые → новые. Витринам нужен
 *  список, а не сводка: по агрегату доверительный интервал не посчитать. */
export function getStrategyTrades(strategyId, mode = 'PAPER', side = null) {
  return getStrategyHistoryMerged(strategyId, mode, side);
}

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
    // realized_pnl УЖЕ net of fees (calcPnl/calcPaperClose: realizedPnl =
    // pricePnl + fundingPnl − totalFee). fee_paid лежит рядом справочно — вычитать
    // его повторно нельзя, иначе комиссия учитывается дважды.
    const net = (r.realized_pnl || 0);
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
  return rows.slice(-limit).map((r) => (r.realized_pnl || 0)); // realized_pnl уже net of fees
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
  const net = rows.reduce((s, r) => s + (r.realized_pnl || 0), 0); // realized_pnl уже net of fees
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
 * Для каждой монеты: current snapshot + history-derived поля (funding persist 24h,
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

  const FUNDING_WINDOW_H = 24;
  const HF = now - FUNDING_WINDOW_H * 3_600_000;
  const D7  = now - 7  * 86_400_000;
  const HF_FULL = FUNDING_WINDOW_H;
  const D7_FULL  = 7 * 24;
  const D30_FULL = 30 * 24;

  const out = [];
  for (const [coin, arr] of byCoin) {
    const last = arr[arr.length - 1];

    // 24h funding persist
    const f24 = arr.filter((r) => r.ts >= HF && r.funding_apy != null);
    const f24Age = f24.length ? (now - f24[0].ts) / 3_600_000 : 0;
    const extreme = f24.filter((r) => Math.abs(r.funding_apy) > 30).length;
    // avgApy — средний funding-APR за 24ч (в %); порог Setup Scanner |avg|≥50 бьёт
    // именно по нему (не по last), чтобы разовый спайк не зажигал сигнал.
    const avgApy = f24.length
      ? f24.reduce((s, r) => s + r.funding_apy, 0) / f24.length
      : null;
    const fundingPersist = f24Age >= HF_FULL - 1 && f24.length
      ? { ageHours: f24Age, fractionExtreme: extreme / f24.length, samples: f24.length, avgApy }
      : { ageHours: f24Age, etaHours: Math.max(0, HF_FULL - f24Age) };

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
  // Минифицированный JSON (без отступов): архив — машинный append-only лог,
  // pretty-print раздувал его в ~2× (12k строк → 236 КБ). compactHistoryArchive
  // переписывает существующий файл в тот же формат.
  const tmpPath = `${ARCHIVE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged), 'utf-8');
  renameSync(tmpPath, ARCHIVE_PATH);

  // Очищаем таблицу history
  getDb().prepare('DELETE FROM history').run();

  logger.info(
    `[DB] ✅ Archived ${newRows.length} new records (${merged.length} total) → ${ARCHIVE_PATH} | history cleared`,
  );

  return newRows.length;
}

/**
 * Переписывает data/history_archive.json в минифицированном виде (без отступов).
 * Идемпотентно: если файл уже компактный — экономия ~0. Атомарно (tmp + rename),
 * по тем же причинам прав, что и archiveAndClearHistory. Возвращает байты экономии.
 */
export function compactHistoryArchive() {
  const ARCHIVE_PATH = 'data/history_archive.json';
  let before;
  try {
    before = statSync(ARCHIVE_PATH).size;
  } catch {
    return 0; // файла нет — нечего сжимать
  }
  let archive;
  try {
    archive = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8'));
  } catch {
    logger.warn('[DB] compactHistoryArchive: архив не парсится — пропуск');
    return 0;
  }
  if (!Array.isArray(archive)) return 0;

  const tmpPath = `${ARCHIVE_PATH}.${process.pid}.compact.tmp`;
  writeFileSync(tmpPath, JSON.stringify(archive), 'utf-8');
  renameSync(tmpPath, ARCHIVE_PATH);

  let after = before;
  try {
    after = statSync(ARCHIVE_PATH).size;
  } catch { /* noop */ }

  const saved = before - after;
  if (saved > 1024) {
    logger.info(
      `[DB] history_archive сжат: ${(before / 1024).toFixed(0)}→${(after / 1024).toFixed(0)} КиБ ` +
      `(${archive.length} записей)`,
    );
  }
  return saved;
}

/**
 * Периодическое обслуживание trades.db. Вызывается из cron (см. index.js).
 *
 *  - wal_checkpoint(TRUNCATE): сливает WAL в основной файл и зануляет .wal, чтобы
 *    он не рос неограниченно при долгом аптайме (на проде доходил до 4 МБ).
 *  - integrity_check: при повреждении возвращает текст ошибки (вызывающий код
 *    шлёт критический риск-алерт). 'ok' — БД здорова.
 *  - VACUUM (только weekly): возвращает ОС страницы, освобождённые ретеншеном
 *    setup_snapshots (90д) и архивацией history. Без него файл держит high-water
 *    mark. VACUUM синхронный и блокирующий, но trades.db мал (≈2 МБ → <1с) и
 *    better-sqlite3 синхронна — гонок с tick() нет (один event-loop).
 *  - PRAGMA optimize (daily): дёшево обновляет статистику планировщика.
 *
 * @param {{ vacuum?: boolean }} opts
 * @returns {{ ok: boolean, integrity: string, sizeBefore: number, sizeAfter: number }}
 */
export function runDbMaintenance({ vacuum = false } = {}) {
  const d = getDb();

  let sizeBefore = 0;
  try { sizeBefore = statSync(DB_PATH).size; } catch { /* noop */ }

  d.pragma('wal_checkpoint(TRUNCATE)');

  const integrity = d.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    logger.error(`[DB] 🚨 integrity_check FAILED: ${integrity}`);
  }

  if (vacuum) {
    d.exec('VACUUM');
  } else {
    d.pragma('optimize');
  }

  let sizeAfter = sizeBefore;
  try { sizeAfter = statSync(DB_PATH).size; } catch { /* noop */ }

  const freed = sizeBefore - sizeAfter;
  logger.info(
    `[DB] Maintenance (${vacuum ? 'VACUUM' : 'optimize'}) | ` +
    `${(sizeBefore / 1024).toFixed(0)}→${(sizeAfter / 1024).toFixed(0)} КиБ` +
    (freed > 1024 ? ` (освобождено ${(freed / 1024).toFixed(0)} КиБ)` : '') +
    ` | integrity=${integrity}`,
  );

  return { ok: integrity === 'ok', integrity, sizeBefore, sizeAfter };
}

// ─────────────────────────────────────────────────
//  Форвард-лог «Монеты дня» v2 (cod_forward)
// ─────────────────────────────────────────────────

/**
 * Пишет пик, если на эту дату+монету его ещё нет.
 * INSERT OR IGNORE намеренно: фиксируем ПЕРВОЕ срабатывание за сутки. Иначе
 * лог переписывался бы по мере того, как цена уезжает, и форвард получил бы
 * задним числом улучшённый вход.
 * @returns {boolean} true, если строка реально записана
 */
export function recordCodPick(pick) {
  try {
    const info = getDb()
      .prepare(
        `INSERT OR IGNORE INTO cod_forward
           (date, coin, side, created_at, score, entry, stop, risk_pct, chg24h_at, flags, btc_at)
         VALUES (@date, @coin, @side, @created_at, @score, @entry, @stop, @risk_pct, @chg24h_at, @flags, @btc_at)`,
      )
      .run(pick);
    return info.changes > 0;
  } catch (err) {
    logger.warn(`[CoinOfDay] forward pick write failed: ${err.message}`);
    return false;
  }
}

/** Пики, у которых ещё не проставлен ход на 24ч (резолвер добирает по мере созревания). */
export function getUnresolvedCodPicks() {
  try {
    return getDb()
      .prepare(`SELECT * FROM cod_forward WHERE chg_24h IS NULL ORDER BY created_at`)
      .all();
  } catch {
    return [];
  }
}

/** Дописывает ход монеты и BTC на созревших горизонтах. */
export function resolveCodPick(date, coin, res) {
  try {
    getDb()
      .prepare(
        `UPDATE cod_forward
            SET chg_4h = COALESCE(@chg_4h, chg_4h),
                chg_8h = COALESCE(@chg_8h, chg_8h),
                chg_24h = COALESCE(@chg_24h, chg_24h),
                btc_4h = COALESCE(@btc_4h, btc_4h),
                btc_8h = COALESCE(@btc_8h, btc_8h),
                btc_24h = COALESCE(@btc_24h, btc_24h),
                resolved_at = @resolved_at
          WHERE date = @date AND coin = @coin`,
      )
      .run({ date, coin, resolved_at: Date.now(), ...res });
    return true;
  } catch (err) {
    logger.warn(`[CoinOfDay] forward resolve failed ${coin}: ${err.message}`);
    return false;
  }
}

export function getCodPicks(limit = 200) {
  try {
    return getDb()
      .prepare(`SELECT * FROM cod_forward ORDER BY created_at DESC LIMIT ?`)
      .all(limit);
  } catch {
    return [];
  }
}
