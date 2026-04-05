import { readFile, writeFile, rename } from "fs/promises";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const COMMISSION = 0.001;  // 0.1%
const SLIPPAGE   = 0.0005; // 0.05%
const ROTATION_THRESHOLD = 1.1;

const STATE_FILE = "logs/state.json";

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
}

export async function processTick(marketData) {
  const prevBalance = stats.balance;

  if (!stats.position) {
    const best = marketData
      .filter((m) => m.apy >= config.minApy)
      .sort((a, b) => b.apy - a.apy)[0];

    if (!best) {
      logger.info("No coins meet minApy threshold, skipping tick");
      logSession();
      return;
    }

    openPosition(best.coin, best.price, best.fundingRate, best.apy);
  } else {
    // Позиция открыта — начисляем фандинг
    const { coin, sizeUsd, lastTickTime } = stats.position;
    const current = marketData.find((m) => m.coin === coin);

    const now = Date.now();
    const elapsedHours = (now - lastTickTime) / 3_600_000;
    stats.position.lastTickTime = now;

    if (current) {
      const shortPositionSize = sizeUsd * 0.5;
      const fundingEarned = shortPositionSize * current.fundingRate * elapsedHours;
      stats.balance += fundingEarned;

      logger.info(
        `[TICK] ${coin} | funding earned: $${fundingEarned.toFixed(4)} | APY: ${current.apy.toFixed(2)}% | balance: $${stats.balance.toFixed(2)}`,
      );
    }

    // Проверяем условия выхода
    const currentApy = current?.apy ?? 0;
    const closePrice = current?.price ?? stats.position.entryPrice;

    if (currentApy < 0) {
      closePosition(closePrice, "negative_funding");
    } else if (currentApy < config.minApy) {
      closePosition(closePrice, "apy_below_threshold");
    } else {
      const better = marketData
        .filter((m) => m.coin !== coin)
        .sort((a, b) => b.apy - a.apy)[0];

      if (better && better.apy >= currentApy * ROTATION_THRESHOLD) {
        closePosition(closePrice, `rotation_to_${better.coin}`);
      }
    }
  }

  // Обновляем peak, max drawdown и логируем сессию
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

  // Сохраняем только если баланс изменился
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
