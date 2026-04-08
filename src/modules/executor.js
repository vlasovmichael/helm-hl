import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { retryWithBackoff } from "../core/retry.js";
import {
  savePosition,
  closePosition as dbClosePosition,
} from "../core/database.js";
import { getAvailableBalance } from "./wallet.js";
import { getExchange, getBalance, getPositions, getMeta } from "./exchange.js";
import { sendMessage } from "./reporter.js";

// ─────────────────────────────────────────────────
//  Константы
// ─────────────────────────────────────────────────

// Совпадают со Стратегом — единый источник правды о комиссиях
const FEE_RATE = 0.0002; // 0.02% taker
const SLIPPAGE = 0.0001; // 0.01%
const ONE_LEG = FEE_RATE + SLIPPAGE; // 0.03% за одну сторону

const BALANCE_UTILIZATION = 0.95; // 95% от баланса — 5% остаётся на комиссии/маржу

// Slippage для IoC-лимитки (имитация маркет-ордера).
// Реальный fill будет по рынку, это лишь потолок допустимой цены.
const MARKET_SLIPPAGE = 0.03; // 3%

// Порог предупреждения: если реальный slippage > 0.5%, это аномалия.
const SLIPPAGE_WARN_PCT = 0.5;

// Balance reconciliation: допустимое отклонение между ожидаемым и фактическим.
const RECONCILIATION_TOLERANCE_PCT = 2.0;

// ─────────────────────────────────────────────────
//  Кеш метаданных (universe → szDecimals)
// ─────────────────────────────────────────────────

let metaCache = null;
let metaCacheTime = 0;
const META_TTL_MS = 5 * 60_000; // обновляем раз в 5 минут

/**
 * Возвращает szDecimals для монеты из кешированной meta.
 *
 * @param {string} coin — "ETH", "BTC" и т.д. (без "-PERP")
 * @returns {Promise<{ szDecimals: number }>}
 */
async function resolveAsset(coin) {
  if (!metaCache || Date.now() - metaCacheTime > META_TTL_MS) {
    metaCache = await getMeta();
    metaCacheTime = Date.now();
    logger.debug(
      `[Executor] Meta cache refreshed — ${metaCache.universe.length} assets`,
    );
  }

  const asset = metaCache.universe.find((a) => a.name === coin);

  if (!asset) {
    throw new Error(`Asset "${coin}" not found in Hyperliquid universe`);
  }

  return { szDecimals: asset.szDecimals };
}

/**
 * Округление вниз до заданного числа десятичных знаков.
 * Важно: всегда floor, никогда ceil — иначе "Insufficient margin".
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundDown(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.floor(value * factor) / factor;
}

// ─────────────────────────────────────────────────
//  Slippage guard
// ─────────────────────────────────────────────────

/**
 * Вычисляет фактическое проскальзывание и логирует предупреждение если > порога.
 *
 * Для SELL (short open): slippage = (expectedPrice - fillPrice) / expectedPrice
 *   Положительный = мы продали дешевле, чем ожидали (плохо)
 *
 * Для BUY (close short): slippage = (fillPrice - expectedPrice) / expectedPrice
 *   Положительный = мы купили дороже, чем ожидали (плохо)
 *
 * @param {number}  expectedPrice — markPrice из сигнала
 * @param {number}  fillPrice     — avgPx из fill
 * @param {string}  side          — "SELL" или "BUY"
 * @param {string}  coin
 * @returns {{ pct: number, warn: boolean, label: string }}
 */
function checkSlippage(expectedPrice, fillPrice, side, coin) {
  let pct;

  if (side === "SELL") {
    // Шорт: продали дешевле = хуже
    pct = ((expectedPrice - fillPrice) / expectedPrice) * 100;
  } else {
    // Закрытие шорта: купили дороже = хуже
    pct = ((fillPrice - expectedPrice) / expectedPrice) * 100;
  }

  const absPct = Math.abs(pct);
  const warn = absPct > SLIPPAGE_WARN_PCT;
  const sign = pct >= 0 ? "+" : "";
  const label = `${sign}${pct.toFixed(3)}%`;

  if (warn) {
    logger.warn(
      `[Executor] ⚠️ SLIPPAGE #${coin} ${side}: expected $${expectedPrice} → fill $${fillPrice} (${label})`,
    );
  } else {
    logger.debug(`[Executor] Slippage #${coin} ${side}: ${label}`);
  }

  return { pct, warn, label };
}

// ─────────────────────────────────────────────────
//  Balance reconciliation
// ─────────────────────────────────────────────────

/**
 * Проверяет, что после fill баланс/позиция на бирже соответствуют ожиданиям.
 *
 * Вызывается ПОСЛЕ успешного fill (fire-and-forget, не блокирует основной поток).
 * Не бросает исключений — только логирует.
 *
 * @param {string} coin       — монета
 * @param {string} operation  — "OPEN" | "CLOSE" | "ROTATE_CLOSE" | "ROTATE_OPEN"
 * @param {{ expectedSzUsd?: number, expectPosition?: boolean }} checks
 */
async function reconcile(coin, operation, checks) {
  try {
    const positions = await getPositions();

    // Ищем позицию по монете
    const pos = positions.find((ap) => {
      const p = ap?.position ?? ap;
      return p?.coin === coin;
    });
    const posData = pos?.position ?? pos;
    const szi = posData ? parseFloat(posData.szi ?? "0") : 0;
    const hasPos = szi !== 0;

    // ── Проверка: ожидаем позицию или нет ───────
    if (checks.expectPosition === true && !hasPos) {
      logger.error(
        `[Reconcile] ❌ ${operation} #${coin} — expected position on exchange but found NONE!`,
      );
      await sendMessage(
        `⚠️ <b>[RECONCILE] #${coin}</b>\n` +
          `После ${operation}: позиция не найдена на бирже!\n` +
          `🔍 Проверь вручную.`,
        true,
      );
      return;
    }

    if (checks.expectPosition === false && hasPos) {
      logger.warn(
        `[Reconcile] ⚠️ ${operation} #${coin} — expected NO position but found szi=${szi}`,
      );
      await sendMessage(
        `⚠️ <b>[RECONCILE] #${coin}</b>\n` +
          `После ${operation}: позиция всё ещё открыта (szi=${szi})!\n` +
          `🔍 Возможно, частичный fill. Проверь вручную.`,
        true,
      );
      return;
    }

    // ── Проверка: размер позиции ≈ ожидаемый ────
    if (checks.expectPosition && checks.expectedSzUsd && hasPos) {
      const entryPx = parseFloat(posData.entryPx ?? "0");
      const actualUsd = Math.abs(szi) * entryPx;
      const diff = Math.abs(actualUsd - checks.expectedSzUsd);
      const diffPct =
        checks.expectedSzUsd > 0 ? (diff / checks.expectedSzUsd) * 100 : 0;

      if (diffPct > RECONCILIATION_TOLERANCE_PCT) {
        logger.warn(
          `[Reconcile] ⚠️ ${operation} #${coin} — size mismatch: ` +
            `expected ~$${checks.expectedSzUsd.toFixed(2)}, actual ~$${actualUsd.toFixed(2)} (Δ${diffPct.toFixed(1)}%)`,
        );
      } else {
        logger.info(
          `[Reconcile] ✅ ${operation} #${coin} — size OK: ~$${actualUsd.toFixed(2)} (Δ${diffPct.toFixed(1)}%)`,
        );
      }
    }

    // ── Простая проверка: позиция закрыта ────────
    if (checks.expectPosition === false && !hasPos) {
      logger.info(
        `[Reconcile] ✅ ${operation} #${coin} — no position confirmed`,
      );
    }
  } catch (err) {
    // Reconciliation — не критичная операция, не крашим бота
    logger.warn(`[Reconcile] Failed for ${operation} #${coin}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────
//  Парсер ответа биржи
// ─────────────────────────────────────────────────

/**
 * Разбирает ответ SDK на placeOrder / marketOpen / marketClose.
 *
 * Hyperliquid возвращает statuses[] где каждый элемент — это:
 *   { filled: { oid, totalSz, avgPx } }    — ордер исполнен
 *   { resting: { oid } }                    — на книге (не для нас, мы IoC)
 *   "Some error string"                     — бизнес-ошибка (НЕ бросается SDK)
 *
 * @param {Object} result — ответ SDK
 * @param {string} context — "OPEN" / "CLOSE" для логов
 * @returns {{ ok: boolean, oid?: number, avgPx?: number, totalSz?: number, error?: string }}
 */
function parseFillResponse(result, context) {
  try {
    const statuses = result?.response?.data?.statuses;

    if (!Array.isArray(statuses) || statuses.length === 0) {
      return {
        ok: false,
        error: `Empty statuses in ${context} response: ${JSON.stringify(result).slice(0, 300)}`,
      };
    }

    const status = statuses[0];

    // ── Бизнес-ошибка (строка) ──────────────────
    if (typeof status === "string") {
      return { ok: false, error: status };
    }

    // ── Ордер исполнен ──────────────────────────
    if (status.filled) {
      return {
        ok: true,
        oid: status.filled.oid,
        totalSz: parseFloat(status.filled.totalSz),
        avgPx: parseFloat(status.filled.avgPx),
      };
    }

    // ── Ордер встал в книгу (IoC не должен, но обрабатываем) ──
    if (status.resting) {
      return {
        ok: false,
        error: `Order resting (oid=${status.resting.oid}) instead of filling — IoC order should not rest`,
      };
    }

    // ── Ошибка в статусе объектом ───────────────
    if (status.error) {
      return { ok: false, error: status.error };
    }

    return {
      ok: false,
      error: `Unknown status shape: ${JSON.stringify(status).slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse ${context} response: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────
//  Публичный API
// ─────────────────────────────────────────────────

/**
 * Исполняет сигнал от Стратега.
 *
 * @param {{ action: string, [key: string]: any }} signal
 * @param {Object|undefined} activePosition — текущая строка из БД (positions)
 * @returns {Promise<{ ok: boolean, positionId?: number, pnl?: number }>}
 */
export async function execute(signal, activePosition) {
  switch (signal.action) {
    case "OPEN":
      return handleOpen(signal);
    case "CLOSE":
      return handleClose(signal, activePosition);
    case "ROTATE":
      return handleRotate(signal, activePosition);
    case "HOLD":
      return { ok: true };
    default:
      logger.warn(`[Executor] Unknown action: ${signal.action}`);
      return { ok: false };
  }
}

// ─────────────────────────────────────────────────
//  PAPER helpers
// ─────────────────────────────────────────────────

/**
 * Определяет баланс для расчёта размера позиции.
 *
 * PAPER + FAKE_BALANCE: используем виртуальный баланс (для тестов без реальных денег).
 * PAPER без FAKE_BALANCE: реальный withdrawable с биржи.
 *
 * @returns {Promise<number>}
 */
async function getPaperBalance() {
  const fake = config.trading.fakeBalance;

  if (fake != null && fake > 0) {
    logger.info(`[Executor] Using FAKE_BALANCE: $${fake.toFixed(2)}`);
    return fake;
  }

  return getAvailableBalance();
}

/**
 * Открывает виртуальную позицию.
 *
 * @param {string}  coin
 * @param {number}  price
 * @param {number}  apy
 * @param {boolean} [silent=false] — подавить Telegram (при ротации шлём одно общее)
 * @returns {Promise<{ ok: boolean, positionId?: number, sizeUsd?: number }>}
 */
async function paperOpen(coin, price, apy, silent = false) {
  const balance = await getPaperBalance();

  if (balance <= 0) {
    logger.warn(`[Executor] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  const sizeUsd = balance * BALANCE_UTILIZATION;
  const fee = sizeUsd * ONE_LEG;

  const id = savePosition({
    coin,
    size_usd: sizeUsd,
    entry_price: price,
    entry_apy: apy,
    entry_time: Date.now(),
    mode: "PAPER",
  });

  logger.info(
    `[Executor] PAPER OPEN #${coin} | $${sizeUsd.toFixed(2)} (of $${balance.toFixed(2)}) @ $${price} | APY: ${apy.toFixed(2)}% | fee: $${fee.toFixed(4)} | id: ${id}`,
  );

  if (!silent) {
    const fire = apy > 100 ? "🔥🔥🔥 " : "";
    await sendMessage(
      `${fire}🟢 <b>[OPEN] #${coin}</b>\n` +
        `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (${(BALANCE_UTILIZATION * 100).toFixed(0)}% от $${balance.toFixed(2)})\n` +
        `📊 APY: <b>${apy.toFixed(2)}%</b>\n` +
        `💵 Цена: $${price}\n` +
        `🏷 Fee: $${fee.toFixed(4)}`,
    );
  }

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Закрывает виртуальную позицию.
 *
 * @param {{ price: number, reason: string }} signal
 * @param {Object} position — строка из БД
 * @param {boolean} [silent=false] — подавить Telegram (при ротации шлём одно общее)
 * @returns {{ ok: boolean, pnl: number, holdHours: number }}
 */
async function paperClose(signal, position, silent = false) {
  const holdMs = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;
  const closePrice = signal.price;

  // Funding PnL: голый шорт — 100% позиции получает фандинг
  const hourlyRate = position.entry_apy / 100 / 365 / 24;
  const fundingPnl = position.size_usd * hourlyRate * holdHours;

  // Комиссии: вход + выход
  const totalFee = position.size_usd * ONE_LEG * 2;
  const realizedPnl = fundingPnl - totalFee;

  dbClosePosition(position.id, {
    close_price: closePrice,
    realized_pnl: realizedPnl,
    fee_paid: totalFee,
    reason: signal.reason,
  });

  const sign = realizedPnl >= 0 ? "+" : "";
  logger.info(
    `[Executor] PAPER CLOSE #${position.coin} | reason: ${signal.reason} ` +
      `| held: ${holdHours.toFixed(1)}h | PnL: ${sign}$${realizedPnl.toFixed(4)} | fees: $${totalFee.toFixed(4)}`,
  );

  if (!silent) {
    const isCriticalClose = realizedPnl < 0;

    await sendMessage(
      `🔴 <b>[CLOSE] #${position.coin}</b>\n` +
        `📈 Причина: <b>${signal.reason}</b>\n` +
        `⏳ Удержание: ${holdHours.toFixed(1)}ч\n` +
        `💰 PnL: <b>${sign}$${realizedPnl.toFixed(4)}</b>\n` +
        `🏷 Fee: $${totalFee.toFixed(4)}`,
      isCriticalClose,
    );
  }

  return { ok: true, pnl: realizedPnl, holdHours };
}

// ─────────────────────────────────────────────────
//  PRODUCTION helpers
// ─────────────────────────────────────────────────

/**
 * Открывает реальную SHORT-позицию на Hyperliquid.
 *
 * Стратегия дельта-нейтральная: шортим перп для сбора фандинга.
 * Ордер: IoC Limit (имитация маркета) через sdk.custom.marketOpen().
 *
 * Последовательность:
 *   1. getBalance()      → свободный USDC
 *   2. resolveAsset()    → szDecimals для округления размера
 *   3. Расчёт size       → (balance × 0.95) / price, floor до szDecimals
 *   4. marketOpen()      → IoC sell (short) с 3% slippage-потолком
 *   5. parseFillResponse → проверка fill / обработка ошибок
 *   6. checkSlippage()   → предупреждение если > 0.5%
 *   7. savePosition()    → сохраняем в БД с реальной ценой fill
 *   8. reconcile()       → фоновая проверка позиции на бирже
 *   9. sendMessage()     → Telegram-уведомление
 *
 * @param {string}  coin  — "ETH", "BTC" (без "-PERP")
 * @param {number}  price — текущая markPrice (для логов; реальная цена = avgPx)
 * @param {number}  apy   — текущий smoothedApy
 * @param {boolean} [silent=false]
 * @returns {Promise<{ ok: boolean, positionId?: number, sizeUsd?: number }>}
 */
async function productionOpen(coin, price, apy, silent = false) {
  const exchange = getExchange();

  // ── 1. Баланс ─────────────────────────────────
  let balance;
  try {
    balance = await getBalance();
  } catch (err) {
    logger.error(
      `[Executor] PROD OPEN #${coin} — failed to get balance: ${err.message}`,
    );
    await sendMessage(
      `🚨 <b>[OPEN FAILED] #${coin}</b>\nНе удалось получить баланс: <code>${err.message}</code>`,
      true,
    );
    return { ok: false };
  }

  if (balance <= 0) {
    logger.warn(
      `[Executor] PROD OPEN #${coin} — balance is $${balance.toFixed(2)}, cannot open`,
    );
    await sendMessage(
      `⚠️ <b>[OPEN SKIPPED] #${coin}</b>\nБаланс: <b>$${balance.toFixed(2)}</b> — недостаточно средств.`,
      true,
    );
    return { ok: false };
  }

  // ── 2. szDecimals ─────────────────────────────
  let szDecimals;
  try {
    ({ szDecimals } = await resolveAsset(coin));
  } catch (err) {
    logger.error(
      `[Executor] PROD OPEN #${coin} — resolveAsset failed: ${err.message}`,
    );
    await sendMessage(
      `🚨 <b>[OPEN FAILED] #${coin}</b>\nАктив не найден: <code>${err.message}</code>`,
      true,
    );
    return { ok: false };
  }

  // ── 3. Расчёт размера ────────────────────────
  const sizeUsd = balance * BALANCE_UTILIZATION;
  const rawSz = sizeUsd / price;
  const sz = roundDown(rawSz, szDecimals);

  if (sz <= 0) {
    logger.warn(
      `[Executor] PROD OPEN #${coin} — size rounds to 0 ` +
        `(rawSz=${rawSz}, szDecimals=${szDecimals}, balance=$${balance.toFixed(2)}, price=$${price})`,
    );
    await sendMessage(
      `⚠️ <b>[OPEN SKIPPED] #${coin}</b>\n` +
        `Размер позиции округляется до 0.\n` +
        `Баланс: $${balance.toFixed(2)} | Цена: $${price} | szDecimals: ${szDecimals}`,
      true,
    );
    return { ok: false };
  }

  // ── 4. Отправляем ордер ──────────────────────
  logger.info(
    `[Executor] PROD OPEN #${coin} — placing market SELL | ` +
      `sz: ${sz} (~$${(sz * price).toFixed(2)}) | markPrice: $${price} | slippage: ${MARKET_SLIPPAGE * 100}%`,
  );

  let result;
  try {
    result = await retryWithBackoff(
      () =>
        exchange.custom.marketOpen(
          `${coin}-PERP`,
          false, // is_buy=false → SELL (short)
          sz,
          undefined, // px: SDK берёт midPrice
          MARKET_SLIPPAGE,
        ),
      { label: `open-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    logger.error(
      `[Executor] PROD OPEN #${coin} — order request failed: ${err.message}`,
    );
    await sendMessage(
      `🚨 <b>[OPEN FAILED] #${coin}</b>\n` +
        `Ордер не отправлен (сетевая ошибка):\n<code>${err.message}</code>`,
      true,
    );
    return { ok: false };
  }

  // ── 5. Парсим ответ ──────────────────────────
  const fill = parseFillResponse(result, "OPEN");

  if (!fill.ok) {
    logger.error(
      `[Executor] PROD OPEN #${coin} — exchange rejected: ${fill.error}`,
    );
    await sendMessage(
      `🚨 <b>[OPEN REJECTED] #${coin}</b>\n` +
        `Биржа отклонила ордер:\n<code>${fill.error}</code>\n\n` +
        `Запрошено: ${sz} ${coin} (~$${(sz * price).toFixed(2)})`,
      true,
    );
    return { ok: false };
  }

  // ── 6. Slippage guard ────────────────────────
  const slip = checkSlippage(price, fill.avgPx, "SELL", coin);

  // ── 7. Сохраняем в БД ────────────────────────
  const fillUsd = fill.totalSz * fill.avgPx;

  const id = savePosition({
    coin,
    size_usd: fillUsd,
    entry_price: fill.avgPx,
    entry_apy: apy,
    entry_time: Date.now(),
    mode: "PRODUCTION",
  });

  logger.info(
    `[Executor] ✅ PROD OPEN #${coin} | oid: ${fill.oid} | ` +
      `filled: ${fill.totalSz} @ $${fill.avgPx} ($${fillUsd.toFixed(2)}) | ` +
      `slippage: ${slip.label} | APY: ${apy.toFixed(2)}% | id: ${id}`,
  );

  // ── 8. Reconciliation (fire-and-forget) ──────
  reconcile(coin, "OPEN", { expectPosition: true, expectedSzUsd: fillUsd });

  // ── 9. Telegram ──────────────────────────────
  if (!silent) {
    const slipWarn = slip.warn ? "⚠️ " : "";
    const fire = apy > 100 ? "🔥🔥🔥 " : "";

    await sendMessage(
      `${fire}🟢 <b>[PROD OPEN] #${coin}</b>\n` +
        `<code>─────────────────────</code>\n` +
        `💰 Размер: <b>$${fillUsd.toFixed(2)}</b> (${fill.totalSz} ${coin})\n` +
        `💵 Fill: <b>$${fill.avgPx}</b> (mark: $${price})\n` +
        `${slipWarn}📉 Slippage: <b>${slip.label}</b>\n` +
        `📊 APY: <b>${apy.toFixed(2)}%</b>\n` +
        `🔑 OID: <code>${fill.oid}</code> | DB: id=${id}`,
    );
  }

  return { ok: true, positionId: Number(id), sizeUsd: fillUsd };
}

/**
 * Закрывает реальную позицию на Hyperliquid.
 *
 * Использует sdk.custom.marketClose() который:
 *   1. Запрашивает clearinghouseState для определения текущего szi
 *   2. Строит IoC buy (reduce_only=true) на полный размер позиции
 *   3. Отправляет ордер
 *
 * @param {{ price: number, reason: string }} signal
 * @param {Object}  position — строка из БД
 * @param {boolean} [silent=false]
 * @returns {Promise<{ ok: boolean, pnl?: number, holdHours?: number }>}
 */
async function productionClose(signal, position, silent = false) {
  const exchange = getExchange();
  const coin = position.coin;

  const holdMs = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;

  logger.info(
    `[Executor] PROD CLOSE #${coin} — reason: ${signal.reason} | ` +
      `held: ${holdHours.toFixed(1)}h | markPrice: $${signal.price}`,
  );

  // ── 1. Отправляем ордер на закрытие ──────────
  let result;
  try {
    result = await retryWithBackoff(
      () =>
        exchange.custom.marketClose(
          `${coin}-PERP`,
          undefined, // size: закрыть полностью
          undefined, // px: SDK берёт midPrice
          MARKET_SLIPPAGE,
        ),
      { label: `close-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    if (err.message?.includes("No position found")) {
      logger.error(
        `[Executor] PROD CLOSE #${coin} — no position on exchange! ` +
          `Likely closed via SL/TP or liquidated.`,
      );
      await sendMessage(
        `🚨 <b>[CLOSE FAILED] #${coin}</b>\n` +
          `Позиции нет на бирже!\n` +
          `Возможная причина: <b>TP/SL/ликвидация</b> пока бот работал.\n` +
          `🔍 Проверь историю ордеров на бирже!`,
        true,
      );
      return { ok: false };
    }

    logger.error(
      `[Executor] PROD CLOSE #${coin} — order request failed: ${err.message}`,
    );
    await sendMessage(
      `🚨 <b>[CLOSE FAILED] #${coin}</b>\n` +
        `Ордер не отправлен (сетевая ошибка):\n<code>${err.message}</code>\n\n` +
        `⚠️ <b>Позиция всё ещё открыта!</b> Закрой вручную!`,
      true,
    );
    return { ok: false };
  }

  // ── 2. Парсим ответ ──────────────────────────
  const fill = parseFillResponse(result, "CLOSE");

  if (!fill.ok) {
    logger.error(
      `[Executor] PROD CLOSE #${coin} — exchange rejected: ${fill.error}`,
    );
    await sendMessage(
      `🚨 <b>[CLOSE REJECTED] #${coin}</b>\n` +
        `Биржа отклонила ордер:\n<code>${fill.error}</code>\n\n` +
        `⚠️ <b>Позиция всё ещё открыта!</b> Закрой вручную!`,
      true,
    );
    return { ok: false };
  }

  // ── 3. Slippage guard ────────────────────────
  const slip = checkSlippage(signal.price, fill.avgPx, "BUY", coin);

  // ── 4. Считаем реальный PnL ──────────────────
  const pricePnl =
    (position.size_usd * (position.entry_price - fill.avgPx)) /
    position.entry_price;
  // Funding PnL: голый шорт — 100% позиции получает фандинг
  const hourlyRate = position.entry_apy / 100 / 365 / 24;
  const fundingPnl = position.size_usd * hourlyRate * holdHours;
  const totalFee = position.size_usd * FEE_RATE * 2;
  const realizedPnl = pricePnl + fundingPnl - totalFee;

  // ── 5. Закрываем в БД ────────────────────────
  dbClosePosition(position.id, {
    close_price: fill.avgPx,
    realized_pnl: realizedPnl,
    fee_paid: totalFee,
    reason: signal.reason,
  });

  const sign = realizedPnl >= 0 ? "+" : "";
  logger.info(
    `[Executor] ✅ PROD CLOSE #${coin} | oid: ${fill.oid} | ` +
      `filled: ${fill.totalSz} @ $${fill.avgPx} | slippage: ${slip.label} | ` +
      `pricePnl: ${pricePnl >= 0 ? "+" : ""}$${pricePnl.toFixed(4)} | ` +
      `fundingPnl: +$${fundingPnl.toFixed(4)} | fees: $${totalFee.toFixed(4)} | ` +
      `total: ${sign}$${realizedPnl.toFixed(4)} | held: ${holdHours.toFixed(1)}h`,
  );

  // ── 6. Reconciliation (fire-and-forget) ──────
  reconcile(coin, "CLOSE", { expectPosition: false });

  // ── 7. Telegram ──────────────────────────────
  if (!silent) {
    const isCritical = realizedPnl < 0;
    const slipWarn = slip.warn ? "⚠️ " : "";

    await sendMessage(
      `🔴 <b>[PROD CLOSE] #${coin}</b>\n` +
        `<code>─────────────────────</code>\n` +
        `📈 Причина: <b>${signal.reason}</b>\n` +
        `⏳ Удержание: ${holdHours.toFixed(1)}ч\n` +
        `<code>─────────────────────</code>\n` +
        `💵 Entry: $${position.entry_price} → Exit: $${fill.avgPx}\n` +
        `${slipWarn}📉 Slippage: <b>${slip.label}</b>\n` +
        `📊 Price PnL: ${pricePnl >= 0 ? "+" : ""}$${pricePnl.toFixed(4)}\n` +
        `💰 Funding PnL: +$${fundingPnl.toFixed(4)}\n` +
        `🏷 Fees: $${totalFee.toFixed(4)}\n` +
        `<b>💎 Итого: ${sign}$${realizedPnl.toFixed(4)}</b>\n` +
        `<code>─────────────────────</code>\n` +
        `🔑 OID: <code>${fill.oid}</code>`,
      isCritical,
    );
  }

  return { ok: true, pnl: realizedPnl, holdHours };
}

/**
 * Боевая ротация: закрываем старую позицию → открываем новую.
 *
 * Между close и open биржа освобождает маржу — getBalance() в productionOpen
 * подхватит свежий withdrawable.
 *
 * Оба вызова идут с silent=true, в конце шлём ОДИН консолидированный чек.
 * Если close прошёл, а open упал — Critical Alert: бот остался «голым».
 *
 * @param {{ closeCoin, closePrice, openCoin, openPrice, openApy, paybackHours, reason }} signal
 * @param {Object} position — текущая позиция из БД
 * @returns {Promise<{ ok: boolean, closePnl?: number, positionId?: number }>}
 */
async function productionRotate(signal, position) {
  logger.info(
    `[Executor] PROD ROTATE — ${signal.closeCoin} → ${signal.openCoin} | ` +
      `payback: ${signal.paybackHours}h | reason: ${signal.reason}`,
  );

  // ── Шаг 1: закрываем старую (silent) ─────────
  const closeResult = await productionClose(
    { price: signal.closePrice, reason: signal.reason },
    position,
    true, // silent
  );

  if (!closeResult.ok) {
    // Close не прошёл — позиция осталась, бот продолжает сопровождать её
    logger.error(
      `[Executor] PROD ROTATE — close leg failed, aborting rotation`,
    );
    await sendMessage(
      `🚨 <b>[ROTATE ABORTED]</b> ${signal.closeCoin} → ${signal.openCoin}\n` +
        `Close не удался — позиция <b>#${signal.closeCoin}</b> осталась открытой.\n` +
        `Бот продолжает сопровождение.`,
      true,
    );
    return { ok: false };
  }

  // ── Шаг 2: открываем новую (silent) ──────────
  const openResult = await productionOpen(
    signal.openCoin,
    signal.openPrice,
    signal.openApy,
    true, // silent
  );

  if (!openResult.ok) {
    // КРИТИЧНО: Close прошёл, Open упал → бот «голый» (без позиции)
    const closePnlSign = closeResult.pnl >= 0 ? "+" : "";

    logger.error(
      `[Executor] 🚨 PROD ROTATE — close OK but open FAILED! Bot is NAKED (no position).`,
    );

    await sendMessage(
      `🚨🚨🚨 <b>[ROTATE FAILED — БОТ БЕЗ ПОЗИЦИИ]</b>\n` +
        `<code>═════════════════════</code>\n` +
        `🔴 Закрыл: <b>#${signal.closeCoin}</b> ✅\n` +
        `💰 PnL: ${closePnlSign}$${closeResult.pnl.toFixed(4)}\n` +
        `<code>─────────────────────</code>\n` +
        `🟢 Открыть: <b>#${signal.openCoin}</b> ❌ ПРОВАЛ\n` +
        `<code>═════════════════════</code>\n` +
        `⚠️ Бот остался <b>БЕЗ ПОЗИЦИИ</b>!\n` +
        `Средства свободны. Бот попробует войти\n` +
        `в следующем тике автоматически.`,
      true, // critical — будим в любое время
    );

    return { ok: false, closePnl: closeResult.pnl };
  }

  // ── Шаг 3: ОДНО консолидированное уведомление ─
  const closePnlSign = closeResult.pnl >= 0 ? "+" : "";
  const isCritical = closeResult.pnl < 0;

  await sendMessage(
    `🔄 <b>[PROD ROTATE]</b> ${signal.closeCoin} → <b>${signal.openCoin}</b>\n` +
      `<code>═════════════════════</code>\n` +
      `🔴 Закрыл: <b>#${signal.closeCoin}</b> (${closeResult.holdHours.toFixed(1)}ч)\n` +
      `💰 PnL: <b>${closePnlSign}$${closeResult.pnl.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🟢 Открыл: <b>#${signal.openCoin}</b>\n` +
      `💰 Размер: <b>$${openResult.sizeUsd.toFixed(2)}</b>\n` +
      `📊 APY: <b>${signal.openApy.toFixed(2)}%</b>\n` +
      `⏱ Payback: ${signal.paybackHours}h\n` +
      `<code>═════════════════════</code>`,
    isCritical,
  );

  return {
    ok: true,
    closePnl: closeResult.pnl,
    positionId: openResult.positionId,
  };
}

// ─────────────────────────────────────────────────
//  Handlers (роутинг PAPER ↔ PRODUCTION)
// ─────────────────────────────────────────────────

async function handleOpen(signal) {
  if (config.isProduction) {
    return productionOpen(signal.coin, signal.price, signal.apy);
  }

  return paperOpen(signal.coin, signal.price, signal.apy);
}

async function handleClose(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] CLOSE signal but no active position — nothing to do`,
    );
    return { ok: false };
  }

  if (config.isProduction) {
    return productionClose(signal, position);
  }

  return paperClose(signal, position);
}

async function handleRotate(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] ROTATE signal but no active position — treating as OPEN`,
    );
    return handleOpen({
      action: "OPEN",
      coin: signal.openCoin,
      price: signal.openPrice,
      apy: signal.openApy,
    });
  }

  if (config.isProduction) {
    return productionRotate(signal, position);
  }

  // ── PAPER ротация: close + open, одно консолидированное уведомление ──

  const closeResult = await paperClose(
    { price: signal.closePrice, reason: signal.reason },
    position,
    true,
  );

  if (!closeResult.ok) return closeResult;

  const openResult = await paperOpen(
    signal.openCoin,
    signal.openPrice,
    signal.openApy,
    true,
  );

  if (!openResult.ok) {
    await sendMessage(
      `⚠️ <b>[ROTATE FAILED]</b> ${signal.closeCoin} закрыт, но ${signal.openCoin} не открылся!\n` +
        `💰 Close PnL: ${closeResult.pnl >= 0 ? "+" : ""}$${closeResult.pnl.toFixed(4)}\n` +
        `🔍 Причина: баланс $0 или ошибка. Бот остаётся без позиции.`,
      true,
    );
    return { ok: false, closePnl: closeResult.pnl };
  }

  const closePnlSign = closeResult.pnl >= 0 ? "+" : "";

  await sendMessage(
    `🔄 <b>[ROTATE]</b> ${signal.closeCoin} → <b>${signal.openCoin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🔴 Закрыл: #${signal.closeCoin} (${closeResult.holdHours.toFixed(1)}ч)\n` +
      `💰 PnL: <b>${closePnlSign}$${closeResult.pnl.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🟢 Открыл: #${signal.openCoin} @ $${signal.openPrice}\n` +
      `📊 APY: <b>${signal.openApy.toFixed(2)}%</b>\n` +
      `💰 Размер: <b>$${openResult.sizeUsd.toFixed(2)}</b>\n` +
      `⏱ Payback: ${signal.paybackHours}h`,
  );

  return {
    ok: true,
    closePnl: closeResult.pnl,
    positionId: openResult.positionId,
  };
}
