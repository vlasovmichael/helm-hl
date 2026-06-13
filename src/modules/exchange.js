/**
 * exchange.js — Подключение к Hyperliquid через SDK.
 *
 * Инициализирует клиент с ключом агента (или основным ключом как fallback).
 * Предоставляет обёрнутые в retry методы для торговых операций.
 *
 * Используется ТОЛЬКО в PRODUCTION mode.
 *
 * SDK: hyperliquid (https://github.com/nomeida/hyperliquid)
 * Ключевой нюанс: при использовании agent wallet нужно явно передавать
 * walletAddress (адрес основного кошелька), т.к. SDK не может вывести его
 * из приватного ключа агента.
 */

import { Hyperliquid } from "hyperliquid";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { retryWithBackoff } from "../core/retry.js";
import { getCachedBalance } from "../core/balanceCache.js";
import { coalesce } from "../core/accountState.js";
import { hlInfo } from "../core/hlClient.js";
import {
  getLivePrice as feedGetLivePrice,
  isFeedFresh,
} from "../core/priceFeed.js";

// TTL коалесцирования срезов аккаунта. Balance/positions зовутся 6–12×/тик
// разными потребителями; в этом окне они делят один сетевой фетч. Короткое —
// чтобы cold-читатели (дашборд/integrity) не висели на устаревшем срезе. Hot-
// путь реконсайла кэш не трогает (зовёт getPositions() напрямую).
const ACCT_BALANCE_TTL_MS = parseInt(process.env.HL_BALANCE_TTL_MS || "2500", 10);
const ACCT_POSITIONS_TTL_MS = parseInt(process.env.HL_POSITIONS_TTL_MS || "2500", 10);

let sdk = null;

/**
 * Инициализирует SDK-клиент Hyperliquid.
 *
 * Вызывается один раз при старте бота в PRODUCTION mode.
 * В PAPER mode — не нужен, функция вернёт null.
 *
 * @returns {Promise<Object|null>} — инстанс SDK или null
 */
export async function initExchange() {
  if (!config.isProduction) {
    logger.info("[Exchange] PAPER mode — SDK not initialized");
    return null;
  }

  // Выбираем ключ: агент (рекомендуется) → основной (fallback)
  const privateKey = config.wallet.agentPrivateKey || config.wallet.privateKey;
  const isAgent = !!config.wallet.agentPrivateKey;

  if (!privateKey) {
    throw new Error("[Exchange] No private key available for PRODUCTION mode");
  }

  logger.info(
    `[Exchange] Initializing SDK (${isAgent ? "AGENT wallet" : "⚠️ MAIN wallet"})…`,
  );

  try {
    sdk = new Hyperliquid({
      privateKey,
      // walletAddress нужен при использовании agent key —
      // SDK не может вывести основной адрес из ключа агента.
      // При использовании main key SDK выведет адрес сам,
      // но мы всё равно передаём явно для единообразия.
      walletAddress: config.wallet.address,
      // Testnet: false — мы работаем на mainnet
      testnet: false,
    });

    // SDK требует вызова connect() для инициализации внутренних структур
    await sdk.connect();

    logger.info("[Exchange] ✅ SDK connected successfully");

    // Верификация: запрашиваем состояние аккаунта
    await verifyConnection();

    return sdk;
  } catch (err) {
    logger.error(`[Exchange] ❌ SDK init failed: ${err.message}`);
    throw err;
  }
}

/**
 * Проверяет, что подключение работает: запрашиваем баланс.
 * HL unified mode (2026-05-23): primary source = spotClearinghouseState.
 */
async function verifyConnection() {
  const spotUsdc = await retryWithBackoff(
    () => fetchSpotUsdcBalance(),
    { label: "verify-connection", maxRetries: 3 },
  );

  const free = Math.max(0, spotUsdc.total - spotUsdc.hold);

  logger.info(
    `[Exchange] ✅ Connection verified — ` +
      `Wallet: $${spotUsdc.total.toFixed(2)} | Free: $${free.toFixed(2)}`,
  );

  if (spotUsdc.total <= 0) {
    logger.warn(
      "[Exchange] ⚠️  Spot USDC = $0 — is this the right wallet?",
    );
  }
}

/**
 * Возвращает текущий инстанс SDK.
 * Бросает ошибку если SDK не инициализирован.
 *
 * @returns {Object}
 */
export function getExchange() {
  if (!sdk) {
    throw new Error(
      "[Exchange] SDK not initialized. Call initExchange() first.",
    );
  }
  return sdk;
}

/**
 * Отключает SDK (для graceful shutdown).
 */
export async function disconnectExchange() {
  if (!sdk) return;

  try {
    await sdk.disconnect();
    sdk = null;
    logger.info("[Exchange] ✅ SDK disconnected");
  } catch (err) {
    logger.error(`[Exchange] Disconnect error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────
//  Leverage management
// ─────────────────────────────────────────────────

/**
 * Устанавливает плечо и margin mode для конкретного актива.
 *
 * Вызывается ПЕРЕД открытием позиции — гарантирует, что биржа
 * не применит повышенное плечо из предыдущих настроек.
 *
 * Режим: isolated 1x — минимально возможный риск.
 *   - cross: одна позиция может ликвидировать весь аккаунт
 *   - isolated: ликвидация затрагивает только маржу конкретной позиции
 *
 * SDK: sdk.exchange.updateLeverage(symbol, leverageMode, leverage)
 *
 * @param {string} coin       — "ETH", "BTC" (без "-PERP")
 * @param {number} leverage   — целевое плечо (по умолчанию 1)
 * @param {string} marginMode — "isolated" | "cross" (по умолчанию "isolated")
 * @returns {Promise<void>}
 */
export async function setLeverage(coin, leverage = 1, marginMode = "isolated") {
  if (!sdk) {
    logger.warn(`[Exchange] setLeverage skipped — SDK not initialized`);
    return;
  }

  const symbol = `${coin}-PERP`;

  try {
    await retryWithBackoff(
      () => sdk.exchange.updateLeverage(symbol, marginMode, leverage),
      { label: `set-leverage-${coin}`, maxRetries: 2 },
    );
    logger.info(
      `[Exchange] ✅ Leverage set: ${symbol} → ${leverage}x ${marginMode}`,
    );
  } catch (err) {
    logger.error(
      `[Exchange] ❌ setLeverage(${symbol}, ${leverage}, ${marginMode}) failed: ${err.message}`,
    );
    throw err;
  }
}

/**
 * Проверяет текущие leverage-настройки всех открытых позиций на аккаунте.
 *
 * Возвращает массив { coin, type, value } для каждой позиции.
 * Логирует предупреждение, если обнаружен leverage > maxSafe
 * или mode !== "isolated".
 *
 * @param {number} [maxSafe=1] — порог для предупреждения
 * @returns {Promise<Array<{ coin: string, type: string, value: number }>>}
 */
export async function checkAccountLeverage(maxSafe = 1) {
  if (!sdk) {
    logger.warn(
      `[Exchange] checkAccountLeverage skipped — SDK not initialized`,
    );
    return [];
  }

  const state = await retryWithBackoff(
    () => sdk.info.perpetuals.getClearinghouseState(config.wallet.address),
    { label: "check-leverage", maxRetries: 3 },
  );

  const results = [];

  for (const ap of state?.assetPositions ?? []) {
    const pos = ap?.position;
    if (!pos) continue;

    const leverage = pos.leverage ?? {};
    const entry = {
      coin: pos.coin,
      type: leverage.type ?? "unknown",
      value: leverage.value != null ? parseFloat(leverage.value) : NaN,
    };

    results.push(entry);

    // Предупреждения
    if (entry.type !== "isolated") {
      logger.warn(
        `[Exchange] ⚠️ #${entry.coin} margin mode: ${entry.type} (expected: isolated)`,
      );
    }
    if (!isNaN(entry.value) && entry.value > maxSafe) {
      logger.warn(
        `[Exchange] ⚠️ #${entry.coin} leverage: ${entry.value}x (max safe: ${maxSafe}x)`,
      );
    }
  }

  if (results.length === 0) {
    logger.info(`[Exchange] ✅ No open positions — leverage check skipped`);
  } else {
    const summary = results
      .map((r) => `${r.coin}=${r.value}x(${r.type})`)
      .join(", ");
    logger.info(`[Exchange] ✅ Leverage check: [${summary}]`);
  }

  return results;
}

// ─────────────────────────────────────────────────
//  Обёртки с retry для торговых операций
// ─────────────────────────────────────────────────

/**
 * Получает текущие открытые позиции на бирже.
 *
 * @returns {Promise<Array>}
 */
export async function getPositions() {
  // Через hlInfo (а не raw SDK), чтобы все /info-запросы шли через единый
  // rate-limiter. Раньше SDK-вызовы балансов/позиций конкурировали с candle-
  // флудом за IP-бюджет 1200/min без координации → "unknown error"/$0.
  const state = await hlInfo(
    { type: "clearinghouseState", user: config.wallet.address },
    { label: "get-positions" },
  );
  return state?.assetPositions ?? [];
}

/**
 * Коалесцированные позиции для cold-читателей (per-tick reconcile, integrity,
 * orphan, dashboard, setup-scanner). В окне TTL все делят один clearinghouseState
 * вместо ~6 независимых фетчей за тик. НЕ использовать в polling-цикле после
 * ордера — там нужна свежесть, зови getPositions() напрямую.
 *
 * @param {number} [maxAgeMs]
 * @returns {Promise<Array>}
 */
export async function getPositionsCached(maxAgeMs = ACCT_POSITIONS_TTL_MS) {
  return coalesce("positions", getPositions, maxAgeMs);
}

/**
 * Открытые ордера (включая trigger SL/TP) в формате фронтенда HL:
 * orderType 'Stop Market' / 'Take Profit Market', triggerPx, reduceOnly.
 * Используется Setup Scanner'ом для отображения SL/TP операторских позиций.
 *
 * @returns {Promise<Array>}
 */
export async function getFrontendOpenOrders() {
  const orders = await hlInfo(
    { type: "frontendOpenOrders", user: config.wallet.address },
    { label: "frontend-open-orders" },
  );
  return Array.isArray(orders) ? orders : [];
}

/**
 * Запрашивает USDC из spotClearinghouseState. Возвращает {total, hold}.
 * Используется как primary source баланса в unified mode (см.
 * memory/hl_unified_migration_2026_05_23.md). SDK маркирует spot-токены
 * суффиксом "-SPOT" чтобы отличать от перп-тикеров — принимаем оба.
 *
 * @returns {Promise<{ total: number, hold: number }>}
 */
export async function fetchSpotUsdcBalance() {
  try {
    const state = await hlInfo(
      { type: "spotClearinghouseState", user: config.wallet.address },
      { label: "spot-balance" },
    );
    const usdc = (state?.balances ?? []).find((b) => {
      const c = (b.coin ?? "").toUpperCase();
      return c === "USDC" || c === "USDC-SPOT";
    });
    if (!usdc) return { total: 0, hold: 0 };
    const total = parseFloat(usdc.total ?? "0");
    const hold  = parseFloat(usdc.hold ?? "0");
    return {
      total: Number.isFinite(total) ? total : 0,
      hold:  Number.isFinite(hold)  ? hold  : 0,
    };
  } catch (err) {
    logger.warn(`[Exchange] fetchSpotUsdcBalance failed: ${err.message}`);
    return { total: 0, hold: 0 };
  }
}

/**
 * Fetcher для balanceCache. HL 2026-05-23: unified-by-default → primary
 * source баланса = spotClearinghouseState. clearinghouseState (perp)
 * остаётся только для unrealized PnL по открытым позициям. Контракт
 * кэша {accountValue, withdrawable, unrealizedPnl} прежний, поменялись
 * только источники:
 *   accountValue  = spot.USDC.total + perp.unrealizedPnl
 *   withdrawable  = spot.USDC.total - spot.USDC.hold
 *   unrealizedPnl = perp.marginSummary.totalUnrealizedPnl
 */
async function fetchBalanceFromSdk() {
  // Оба чтения идут через hlInfo (единый rate-limiter + внутренний retry).
  const [perpState, spotUsdc] = await Promise.all([
    hlInfo(
      { type: "clearinghouseState", user: config.wallet.address },
      { label: "balance-perp" },
    ),
    fetchSpotUsdcBalance(),
  ]);

  const ms = perpState?.marginSummary ?? {};
  const perpUnrealized = parseFloat(
    ms.totalUnrealizedPnl ?? ms.unrealizedPnl ?? "0",
  );
  const upnl = Number.isFinite(perpUnrealized) ? perpUnrealized : 0;

  const accountValue = spotUsdc.total + upnl;
  const withdrawable = Math.max(0, spotUsdc.total - spotUsdc.hold);

  return {
    accountValue,
    withdrawable,
    unrealizedPnl: upnl,
  };
}

/**
 * Получает текущий свободный баланс (withdrawable).
 * Защищён stale-cache'ом от API-глитчей.
 *
 * @returns {Promise<number>}
 */
export async function getBalance() {
  const snap = await getCachedBalance(fetchBalanceCoalesced);
  return snap.withdrawable;
}

// fetchBalanceFromSdk через coalesce: 6+ вызовов getBalance/getAccountSummary
// за тик делят один сетевой срез (perp+spot). balanceCache по-прежнему сверху —
// решает, доверять свежему ответу или жить на кэше при $0-глитче индексатора.
function fetchBalanceCoalesced() {
  return coalesce("balance", fetchBalanceFromSdk, ACCT_BALANCE_TTL_MS);
}

/**
 * Получает полную сводку аккаунта: equity, available, unrealizedPnl.
 * Защищён stale-cache'ом от API-глитчей.
 *
 * @returns {Promise<{ equity: number, available: number, unrealizedPnl: number }>}
 */
export async function getAccountSummary() {
  const snap = await getCachedBalance(fetchBalanceCoalesced);
  return {
    equity:        snap.accountValue,
    available:     snap.withdrawable,
    unrealizedPnl: snap.unrealizedPnl,
  };
}

/**
 * Возвращает ПОЛНЫЙ срез clearinghouseState (равен ответу info-API).
 * Используется как "тяжёлый" final check в reconciler — даёт всё:
 * marginSummary, assetPositions, withdrawable, crossMarginSummary и т.п.
 *
 * @returns {Promise<Object>}
 */
export async function getClearinghouseStateFull() {
  return hlInfo(
    { type: "clearinghouseState", user: config.wallet.address },
    { label: "get-clearinghouse-state-full" },
  );
}

/**
 * Получает метаданные рынка (для определения assetIndex, szDecimals и т.д.).
 *
 * @returns {Promise<Object>}
 */
export async function getMeta() {
  return hlInfo({ type: "meta" }, { label: "get-meta", maxRetries: 2 });
}

/**
 * Получает текущую Mark Price для конкретного тикера.
 *
 * Использует metaAndAssetCtxs API — возвращает markPx из assetCtx.
 * Лёгкий запрос: один POST, парсим нужную монету.
 *
 * @param {string} coin — "ETH", "BTC" и т.д. (без "-PERP")
 * @returns {Promise<number|null>} — markPrice или null если не найден
 */
export async function getMarkPrice(coin) {
  try {
    const data = await hlInfo(
      { type: "metaAndAssetCtxs" },
      { label: "exchange/markPrice", timeoutMs: 10_000 },
    );

    const [meta, ctxs] = data ?? [];
    const universe = meta?.universe;
    if (!Array.isArray(universe) || !Array.isArray(ctxs)) return null;

    const upperCoin = coin.toUpperCase();
    const idx = universe.findIndex(
      (a) => (a.name ?? "").toUpperCase() === upperCoin,
    );

    if (idx === -1 || !ctxs[idx]) return null;

    const px = parseFloat(ctxs[idx].markPx ?? ctxs[idx].midPx ?? "0");
    return px > 0 ? px : null;
  } catch (err) {
    logger.warn(`[Exchange] getMarkPrice(${coin}) failed: ${err.message}`);
    return null;
  }
}

/**
 * Live trade-side price для дашборда. Используется только для отображения
 * "Now" линии на графике, чтобы цена совпадала с close последней свечи.
 *
 * Источник #1 — WS-фид allMids (priceFeed): мгновенно, без HTTP. Дашборд
 * рендерит цену в 5+ местах на каждый рефреш, и раньше каждый вызов летел
 * тяжёлым metaAndAssetCtxs (все ~760 монет) → штормил rate-limit → 429 →
 * бэклог в hlClient → Scout ловил RTT > 10s. Теперь берём mid из того же
 * WS-кэша, что и торговые тики. HTTP остаётся только фолбэком, если фид
 * протух (reconnect и т.п.).
 */
export async function getLivePrice(coin) {
  // Fast path: свежий WS-фид.
  if (isFeedFresh()) {
    const live = feedGetLivePrice(coin);
    if (live && live.price > 0) return live.price;
  }

  // Фолбэк: фид протух или монеты в кэше нет — добираем по HTTP.
  try {
    const data = await hlInfo(
      { type: "metaAndAssetCtxs" },
      { label: "exchange/livePrice", timeoutMs: 10_000 },
    );
    const [meta, ctxs] = data ?? [];
    const universe = meta?.universe;
    if (!Array.isArray(universe) || !Array.isArray(ctxs)) return null;
    const upperCoin = coin.toUpperCase();
    const idx = universe.findIndex((a) => (a.name ?? "").toUpperCase() === upperCoin);
    if (idx === -1 || !ctxs[idx]) return null;
    const px = parseFloat(ctxs[idx].midPx ?? ctxs[idx].markPx ?? "0");
    return px > 0 ? px : null;
  } catch (err) {
    logger.debug(`[Exchange] getLivePrice(${coin}) failed: ${err.message}`);
    return null;
  }
}
