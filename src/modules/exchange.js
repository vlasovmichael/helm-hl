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
//  Обёртки с retry для будущих торговых операций
//  (пока не используются — подготовка к Шагу 2)
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
 * Получает текущий свободный баланс.
 *
 * @returns {Promise<number>}
 */
export async function getBalance() {
  return retryWithBackoff(
    () =>
      sdk.info.perpetuals
        .getClearinghouseState(config.wallet.address)
        .then((state) => parseFloat(state?.withdrawable ?? "0")),
    { label: "get-balance", maxRetries: 3 },
  );
}

/**
 * Получает полную сводку аккаунта: equity, available, unrealizedPnl.
 *
 * @returns {Promise<{ equity: number, available: number, unrealizedPnl: number }>}
 */
export async function getAccountSummary() {
  return retryWithBackoff(
    () =>
      sdk.info.perpetuals
        .getClearinghouseState(config.wallet.address)
        .then((state) => {
          const ms = state?.marginSummary ?? {};
          return {
            equity:        parseFloat(ms.accountValue ?? "0"),
            available:     parseFloat(state?.withdrawable ?? "0"),
            unrealizedPnl: parseFloat(ms.totalUnrealizedPnl ?? ms.unrealizedPnl ?? "0"),
          };
        }),
    { label: "get-account-summary", maxRetries: 3 },
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
