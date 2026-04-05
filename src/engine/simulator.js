import { readFile, writeFile, rename } from "fs/promises";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { sendTelegramMessage } from "../utils/telegram.js";

const COMMISSION = 0.001;  // 0.1%
const SLIPPAGE   = 0.0005; // 0.05%
const ROUND_TRIP_COST = (COMMISSION + SLIPPAGE) * 2; // close + open = 0.3%
const MAX_PAYBACK_HOURS = 24;
const MIN_HOLD_HOURS = 4;  // cooldown
const EMA_SLOTS = 6;       // сглаживание: 6 тиков × 5 мин = 30 минут

const STATE_FILE = "logs/state.json";

// EMA-буфер: coin -> { ema, count }
const emaState = new Map();

const stats = {
  balance: 0,
  startBalance: 0,
  position: null,
  history: [],
  startedAt: null,
  peakBalance: 0,
  maxDrawdownPct: 0,
};

async function saveState() {
  const tmp = STATE_FILE + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(stats, null, 2));
    await rename(tmp, STATE_FILE); // atomic on POSIX
  } catch (err) {
    logger.error(`Failed to save state: ${err.message}`);
  }
}

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const saved = JSON.parse(raw);
    Object.assign(stats, saved);
    logger.info(
      `State restored from ${STATE_FILE} | balance: $${stats.balance.toFixed(2)} | trades: ${stats.history.length}`,
    );
    return true;
  } catch {
    return false;
  }
}

export async function initBalance(initialBalance) {
  const restored = await loadState();
  if (!restored) {
    stats.balance      = initialBalance;
    stats.startBalance = initialBalance;
    stats.peakBalance  = initialBalance;
    stats.startedAt    = Date.now();
    logger.info(`Simulator initialized with balance $${initialBalance.toFixed(2)}`);
  }
}

export function getStats() {
  return stats;
}

function openPosition(coin, price, fundingRate, apy) {
  const commission = stats.balance * COMMISSION;
  const slippage   = stats.balance * SLIPPAGE;
  stats.balance -= commission + slippage;

  stats.position = {
    coin,
    entryPrice: price,
    entryTime: Date.now(),
    lastTickTime: Date.now(),
    sizeUsd: stats.balance,
    entryApy: apy,
  };

  logger.info(
    `[OPEN] ${coin} | APY: ${apy.toFixed(2)}% | size: $${stats.balance.toFixed(2)} | fee: $${commission.toFixed(4)} | slippage: $${slippage.toFixed(4)}`,
  );

  const fire = apy > 100 ? "🔥🔥🔥 " : "";
  sendTelegramMessage(
    `${fire}🟢 <b>[OPEN] #${coin}</b>\n` +
    `💰 APY: ${apy.toFixed(2)}%\n` +
    `📊 Размер: $${stats.balance.toFixed(2)}`
  );
}

function closePosition(currentPrice, reason) {
  const { coin, sizeUsd, entryTime, entryApy } = stats.position;
  const commission = sizeUsd * COMMISSION;
  const slippage   = sizeUsd * SLIPPAGE;
  stats.balance -= commission + slippage;

  const holdHours = (Date.now() - entryTime) / 3_600_000;
  const record = {
    coin,
    entryPrice: stats.position.entryPrice,
    closePrice: currentPrice,
    sizeUsd,
    entryApy,
    holdHours: parseFloat(holdHours.toFixed(2)),
    closedAt: new Date().toISOString(),
    reason,
  };

  stats.history.push(record);

  const MAX_HISTORY = 50;
  while (stats.history.length > MAX_HISTORY) {
    const archived = stats.history.shift();
    logger.info(
      `[ARCHIVE] ${archived.coin} | held: ${archived.holdHours}h | entryApy: ${archived.entryApy.toFixed(2)}% | closed: ${archived.closedAt} | reason: ${archived.reason}`,
    );
  }

  stats.position = null;

  logger.info(
    `[CLOSE] ${coin} | reason: ${reason} | held: ${holdHours.toFixed(2)}h | fee: $${commission.toFixed(4)} | slippage: $${slippage.toFixed(4)} | balance: $${stats.balance.toFixed(2)}`,
  );

  sendTelegramMessage(
    `🔴 <b>[CLOSE] #${coin}</b>\n` +
    `📈 Причина: ${reason}\n` +
    `⏳ Удержание: ${holdHours.toFixed(1)}ч`
  );
}

/**
 * Обновляет EMA (экспоненциальное скользящее среднее) для APY монеты.
 * α = 2 / (N + 1) — стандартная формула EMA.
 * Первые EMA_SLOTS тиков идёт «прогрев»: EMA ещё не стабильна,
 * но мы уже возвращаем лучшее приближение, чтобы не блокировать вход.
 */
function updateEma(coin, rawApy) {
  const alpha = 2 / (EMA_SLOTS + 1);
  const entry = emaState.get(coin);

  if (!entry) {
    emaState.set(coin, { ema: rawApy, count: 1 });
    return rawApy;
  }

  entry.ema = alpha * rawApy + (1 - alpha) * entry.ema;
  entry.count++;
  emaState.set(coin, entry);
  return entry.ema;
}

/** EMA «прогрета» — набрала достаточно точек для надёжного сигнала */
function isEmaWarmedUp(coin) {
  const entry = emaState.get(coin);
  return entry != null && entry.count >= EMA_SLOTS;
}

/**
 * Breakeven-check: за сколько часов дельта APY окупит двойную комиссию?
 *
 * Доход за час = sizeUsd × 0.5 × hourlyFundingRate
 * Стоимость ротации = sizeUsd × ROUND_TRIP_COST
 *
 * paybackHours = ROUND_TRIP_COST / (0.5 × deltaHourlyRate)
 *              = ROUND_TRIP_COST / (0.5 × (betterApy − currentApy) / 24 / 365 / 100)
 */
function paybackHours(currentApy, betterApy) {
  const deltaHourly = (betterApy - currentApy) / 100 / 365 / 24;
  if (deltaHourly <= 0) return Infinity;
  return ROUND_TRIP_COST / (0.5 * deltaHourly);
}

export async function processTick(marketData) {
  const prevBalance = stats.balance;

  // --- Обновляем EMA для всех монет ---
  const smoothed = marketData.map((m) => ({
    ...m,
    smoothedApy: updateEma(m.coin, m.apy),
  }));

  if (!stats.position) {
    // --------- Нет позиции — ищем лучшую ---------
    // Вход ТОЛЬКО если EMA-сглаженный APY >= entryApy (60%)
    // и EMA прогрета (минимум 30 мин наблюдений)
    const candidates = smoothed.filter(
      (m) => m.fundingRate > 0 && m.smoothedApy >= config.entryApy && isEmaWarmedUp(m.coin),
    );
    const best = candidates.sort((a, b) => b.smoothedApy - a.smoothedApy)[0];

    if (!best) {
      logger.info(
        `No coins meet entry threshold (EMA ≥ ${config.entryApy}%), skipping tick`,
      );
      logSession();
      return;
    }

    openPosition(best.coin, best.price, best.fundingRate, best.smoothedApy);
  } else {
    // --------- Позиция открыта — начисляем фандинг ---------
    const { coin, sizeUsd, lastTickTime } = stats.position;
    const current = smoothed.find((m) => m.coin === coin);

    const now = Date.now();
    const elapsedHours = (now - lastTickTime) / 3_600_000;
    stats.position.lastTickTime = now;

    if (current) {
      const fundingEarned = sizeUsd * 0.5 * current.fundingRate * elapsedHours;
      stats.balance += fundingEarned;

      logger.info(
        `[TICK] ${coin} | funding: $${fundingEarned.toFixed(4)} | rawAPY: ${current.apy.toFixed(2)}% | emaAPY: ${current.smoothedApy.toFixed(2)}% | bal: $${stats.balance.toFixed(2)}`,
      );
    }

    // --------- Проверяем условия выхода ---------
    const currentApy = current?.smoothedApy ?? 0;
    const closePrice = current?.price ?? stats.position.entryPrice;
    const heldHours = (Date.now() - stats.position.entryTime) / 3_600_000;

    // 1. Negative funding — экстренный выход, без cooldown
    if (currentApy < 0) {
      closePosition(closePrice, "negative_funding");

    // 2. APY ниже порога — экстренный выход, без cooldown
    } else if (currentApy < config.minApy) {
      closePosition(closePrice, "apy_below_threshold");

    // 3. Ротация — только после cooldown + breakeven + прогретой EMA
    } else if (heldHours >= MIN_HOLD_HOURS) {
      const best = smoothed
        .filter((m) => m.coin !== coin && m.fundingRate > 0 && isEmaWarmedUp(m.coin))
        .sort((a, b) => b.smoothedApy - a.smoothedApy)[0];

      if (best && best.smoothedApy > currentApy) {
        const hours = paybackHours(currentApy, best.smoothedApy);

        if (hours <= MAX_PAYBACK_HOURS) {
          logger.info(
            `[ROTATION] ${coin} (${currentApy.toFixed(2)}%) -> ${best.coin} (${best.smoothedApy.toFixed(2)}%) | payback: ${hours.toFixed(1)}h`,
          );
          closePosition(closePrice, `rotation_to_${best.coin}`);
        } else {
          logger.info(
            `[ROTATION SKIP] ${best.coin} APY ${best.smoothedApy.toFixed(2)}% but payback ${hours.toFixed(1)}h > ${MAX_PAYBACK_HOURS}h`,
          );
        }
      }
    }
  }

  // --- Обновляем peak, max drawdown ---
  if (stats.balance > stats.peakBalance) {
    stats.peakBalance = stats.balance;
  }
  if (stats.peakBalance > 0) {
    const currentDd = ((stats.peakBalance - stats.balance) / stats.peakBalance) * 100;
    if (currentDd > stats.maxDrawdownPct) {
      stats.maxDrawdownPct = currentDd;
    }
  }
  logSession();

  if (stats.balance !== prevBalance) {
    await saveState();
  }
}

function logSession() {
  const uptimeHours = ((Date.now() - stats.startedAt) / 3_600_000).toFixed(1);
  const trades = stats.history.length;

  logger.info(
    `[SESSION] Up time: ${uptimeHours} hours | Trades: ${trades} | Max Drawdown: ${stats.maxDrawdownPct.toFixed(2)}%`,
  );
}
