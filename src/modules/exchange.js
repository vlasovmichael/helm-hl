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

import axios from "axios";
import { Hyperliquid } from "hyperliquid";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { retryWithBackoff } from "../core/retry.js";
import { getCachedBalance, registerZeroRecoveryHandler } from "../core/balanceCache.js";

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

    // Регистрируем zero-recovery handler в BalanceCache — единая точка для
    // обоих балансовых путей (wallet.js raw axios + exchange.js SDK).
    registerZeroRecoveryHandler(zeroRecoverySpotToPerp);

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
 */
async function verifyConnection() {
  const state = await retryWithBackoff(
    () => sdk.info.perpetuals.getClearinghouseState(config.wallet.address),
    { label: "verify-connection", maxRetries: 3 },
  );

  const accountValue = parseFloat(state?.marginSummary?.accountValue ?? "0");
  const withdrawable = parseFloat(state?.withdrawable ?? "0");

  logger.info(
    `[Exchange] ✅ Connection verified — ` +
      `Account: $${accountValue.toFixed(2)} | Withdrawable: $${withdrawable.toFixed(2)}`,
  );

  if (accountValue <= 0) {
    logger.warn(
      "[Exchange] ⚠️  Account value is $0 — is this the right wallet?",
    );
  }

  return { accountValue, withdrawable };
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
  return retryWithBackoff(
    () =>
      sdk.info.perpetuals
        .getClearinghouseState(config.wallet.address)
        .then((state) => state?.assetPositions ?? []),
    { label: "get-positions", maxRetries: 3 },
  );
}

/**
 * Запрашивает spot-баланс USDC. Используется как диагностика и для
 * авто-трансфера при ситуации "perp=$0 + spot>0" (типичный случай
 * Unified Account Mode или после deposit).
 *
 * @returns {Promise<number>} — USDC баланс в spot wallet (0 если нет)
 */
async function fetchSpotUsdcBalance() {
  try {
    const state = await sdk.info.spot.getSpotClearinghouseState(
      config.wallet.address,
    );
    // SDK маркирует spot-токены суффиксом "-SPOT" чтобы отличать от перп-
    // тикеров. У живых аккаунтов USDC лежит как "USDC-SPOT". Принимаем
    // оба варианта на случай разных версий SDK / raw-ответов.
    const usdc = (state?.balances ?? []).find((b) => {
      const c = (b.coin ?? "").toUpperCase();
      return c === "USDC" || c === "USDC-SPOT";
    });
    if (!usdc) return 0;
    const total = parseFloat(usdc.total ?? "0");
    return Number.isFinite(total) ? total : 0;
  } catch (err) {
    logger.warn(`[Exchange] fetchSpotUsdcBalance failed: ${err.message}`);
    return 0;
  }
}

/**
 * Авто-трансфер spot → perp когда детектим "perp=$0 + spot>0".
 * Защищает от потери торговли когда деньги залегли в spot wallet
 * (Unified Account Mode или после фандинговых выплат на некоторых режимах).
 *
 * @param {number} amount — сумма USDC для перевода (обычно весь spot total)
 * @returns {Promise<boolean>} — true если перевод прошёл
 */
async function autoTransferSpotToPerp(amount) {
  // Защита от dust-трансферов и от того что transferBetweenSpotAndPerp
  // может потребовать минимум на стороне HL.
  if (!(amount > 0.5)) return false;
  try {
    logger.warn(
      `[Exchange] 🔄 Auto-transfer SPOT→PERP: $${amount.toFixed(2)} USDC ` +
        `(perp returned $0, spot has funds — likely Unified Account Mode)`,
    );
    // HL info-API возвращает {status: "ok"|"err", response: ...} — SDK
    // не бросает на "err", надо инспектировать тело ответа.
    const resp = await sdk.exchange.transferBetweenSpotAndPerp(amount, true);
    const respStr = (() => {
      try { return JSON.stringify(resp).slice(0, 400); }
      catch { return String(resp).slice(0, 400); }
    })();
    if (resp?.status && resp.status !== 'ok') {
      logger.error(
        `[Exchange] ❌ Auto-transfer SPOT→PERP rejected by HL: ${respStr}`,
      );
      return false;
    }
    logger.info(
      `[Exchange] ✅ Auto-transfer reply: ${respStr}. Will verify via re-fetch.`,
    );
    return true;
  } catch (err) {
    logger.error(
      `[Exchange] ❌ Auto-transfer SPOT→PERP threw: ${err.message}. ` +
        `Manual fix: disable Unified Account Mode + transfer in HL UI.`,
    );
    return false;
  }
}

/**
 * Zero-recovery handler — регистрируется в BalanceCache при init PROD.
 * Вызывается ОДИН РАЗ на эпизод $0 (с throttle в BalanceCache).
 * Проверяет spot wallet и при наличии USDC делает auto-transfer.
 *
 * @returns {Promise<boolean>} — true если трансфер успешно прошёл
 */
async function zeroRecoverySpotToPerp() {
  const spotUsdc = await fetchSpotUsdcBalance();
  if (spotUsdc <= 0.5) {
    logger.warn(
      `[Exchange] Zero-recovery: spot.USDC=$${spotUsdc.toFixed(2)} — ` +
        `nothing to transfer. Funds may be in vault, sub-account, or ` +
        `indexer is lagging.`,
    );
    return false;
  }
  return await autoTransferSpotToPerp(spotUsdc);
}

/**
 * Fetcher для balanceCache: дёргает SDK и нормализует ответ в
 * {accountValue, withdrawable, unrealizedPnl}. Retry — только на сеть.
 * Логику spot-recovery теперь делает BalanceCache через handler.
 */
async function fetchBalanceFromSdk() {
  return retryWithBackoff(
    () =>
      sdk.info.perpetuals
        .getClearinghouseState(config.wallet.address)
        .then((state) => {
          const ms = state?.marginSummary ?? {};
          return {
            accountValue:  parseFloat(ms.accountValue ?? "0"),
            withdrawable:  parseFloat(state?.withdrawable ?? "0"),
            unrealizedPnl: parseFloat(
              ms.totalUnrealizedPnl ?? ms.unrealizedPnl ?? "0",
            ),
          };
        }),
    { label: "exchange-get-balance", maxRetries: 3 },
  );
}

/**
 * Получает текущий свободный баланс (withdrawable).
 * Защищён stale-cache'ом от API-глитчей.
 *
 * @returns {Promise<number>}
 */
export async function getBalance() {
  const snap = await getCachedBalance(fetchBalanceFromSdk);
  return snap.withdrawable;
}

/**
 * Получает полную сводку аккаунта: equity, available, unrealizedPnl.
 * Защищён stale-cache'ом от API-глитчей.
 *
 * @returns {Promise<{ equity: number, available: number, unrealizedPnl: number }>}
 */
export async function getAccountSummary() {
  const snap = await getCachedBalance(fetchBalanceFromSdk);
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
  return retryWithBackoff(
    () => sdk.info.perpetuals.getClearinghouseState(config.wallet.address),
    { label: "get-clearinghouse-state-full", maxRetries: 3 },
  );
}

/**
 * Получает метаданные рынка (для определения assetIndex, szDecimals и т.д.).
 *
 * @returns {Promise<Object>}
 */
export async function getMeta() {
  return retryWithBackoff(() => sdk.info.perpetuals.getMeta(), {
    label: "get-meta",
    maxRetries: 2,
  });
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
    const { data } = await axios.post(
      "https://api.hyperliquid.xyz/info",
      { type: "metaAndAssetCtxs" },
      { timeout: 10_000 },
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
 * Live trade-side price для дашборда. Предпочитает midPx (близко к last trade),
 * фолбэк — markPx. Используется только для отображения "Now" линии на графике
 * чтобы цена совпадала с close последней свечи.
 */
export async function getLivePrice(coin) {
  try {
    const { data } = await axios.post(
      "https://api.hyperliquid.xyz/info",
      { type: "metaAndAssetCtxs" },
      { timeout: 10_000 },
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
