// ─────────────────────────────────────────────────
//  Tax Collector — публичный фасад
// ─────────────────────────────────────────────────
// Оркестрирует ежедневный сбор фиатных операций для PIT-38.
// Вызывается из cron в src/index.js.

import { logger } from '../../core/logger.js';
import { fetchAllFiatEvents, isConfigured } from './binanceClient.js';
import { classifyEvent } from './classifier.js';
import { getNbpRate, toWarsawDate } from './nbpClient.js';
import { appendEntries, getYearSummary, loadLedger } from './ledger.js';

const DEFAULT_LOOKBACK_DAYS    = 35;  // ежедневный пробег с запасом
const FIRST_RUN_LOOKBACK_DAYS  = 90;  // если ledger пустой — тащим за 3 месяца

let firstRunCompleted = false;

/**
 * Главная задача крона. Fail-soft: ничего не бросает в основной поток.
 */
export async function dailyJob() {
  const t0 = Date.now();
  logger.info('[Tax] ─── Daily tax collection started ───');

  if (!isConfigured()) {
    logger.info('[Tax] Binance API keys not configured — skipping. Bot continues normally.');
    return { ok: false, reason: 'no_keys' };
  }

  try {
    // Решаем lookback: первый ли это запуск (ledger текущего года пустой)
    const currentYear = new Date().getFullYear();
    const existingThisYear = await loadLedger(currentYear);

    const lookbackDays = (existingThisYear.length === 0 && !firstRunCompleted)
      ? FIRST_RUN_LOOKBACK_DAYS
      : DEFAULT_LOOKBACK_DAYS;

    const endMs   = Date.now();
    const startMs = endMs - lookbackDays * 24 * 3_600_000;

    logger.info(
      `[Tax] Lookback window: ${lookbackDays}d ` +
      `(${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)})`,
    );

    // ── 1. Тащим всё с Binance ──
    let rawEvents;
    try {
      rawEvents = await fetchAllFiatEvents(startMs, endMs);
    } catch (err) {
      logger.error(`[Tax] Binance fetch failed: ${err.message} — will retry tomorrow`);
      return { ok: false, reason: 'binance_failed' };
    }

    // ── 2. Классифицируем ──
    const classified = [];
    let ignored = 0;
    for (const raw of rawEvents) {
      const c = classifyEvent(raw);
      if (c) classified.push(c);
      else ignored++;
    }
    logger.info(`[Tax] Classified: ${classified.length} relevant, ${ignored} ignored`);

    if (classified.length === 0) {
      logger.info('[Tax] No new fiat events to record');
      firstRunCompleted = true;
      return { ok: true, added: 0, skipped: 0 };
    }

    // ── 3. Обогащаем NBP курсами ──
    const enriched = [];
    let nbpFailed = 0;
    for (const entry of classified) {
      const nbp = await getNbpRate(entry.fiat_currency, entry.date);
      if (!nbp) {
        nbpFailed++;
        logger.warn(
          `[Tax] Skipping entry (no NBP rate): ${entry.tx_id} ${entry.fiat_currency} ${toWarsawDate(entry.date)}`,
        );
        continue;
      }
      enriched.push({
        ...entry,
        nbp_rate:  nbp.rate,
        nbp_date:  nbp.nbpDate,
        pln_total: round2(entry.fiat_val * nbp.rate),
      });
    }

    if (nbpFailed > 0) {
      logger.warn(`[Tax] ${nbpFailed} entries deferred due to NBP API issues`);
    }

    // ── 4. Пишем в ledger (с дедупом) ──
    const result = await appendEntries(enriched);
    logger.info(
      `[Tax] ─── Done in ${Date.now() - t0}ms — ` +
      `added=${result.added}, skipped(dup)=${result.skipped}, deferred(nbp)=${nbpFailed} ───`,
    );

    firstRunCompleted = true;
    return { ok: true, ...result, deferred: nbpFailed };
  } catch (err) {
    logger.error(`[Tax] Unexpected error in dailyJob: ${err.message}`, { stack: err.stack });
    return { ok: false, reason: 'exception', message: err.message };
  }
}

/**
 * Возвращает агрегат по году. Используется /tax командой и /api/tax-summary.
 */
export async function getTaxSummary(year) {
  const y = year || new Date().getFullYear();
  return getYearSummary(y);
}

/**
 * Форматирование для Telegram /tax команды.
 */
export async function formatTaxSummaryForTelegram(year) {
  const y = year || new Date().getFullYear();
  const s = await getTaxSummary(y);
  const profitSign  = s.netProfitPLN >= 0 ? '+' : '';
  const profitEmoji = s.netProfitPLN >= 0 ? '📈' : '📉';

  return (
    `📋 <b>PIT-38 Summary — ${s.year}</b>\n` +
    `<code>─────────────────────</code>\n` +
    `💸 Расходы (Koszty): <b>${s.totalCostsPLN.toFixed(2)} PLN</b>\n` +
    `💰 Доходы (Przychody): <b>${s.totalRevenuePLN.toFixed(2)} PLN</b>\n` +
    `<code>─────────────────────</code>\n` +
    `${profitEmoji} Прибыль (Dochód): <b>${profitSign}${s.netProfitPLN.toFixed(2)} PLN</b>\n` +
    `<code>─────────────────────</code>\n` +
    `📦 Записей в гроссбухе: ${s.count}\n` +
    `<i>Источник: data/tax/${s.year}_ledger.json</i>`
  );
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
