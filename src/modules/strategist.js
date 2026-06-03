import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getCachedAccountValueSync } from '../core/balanceCache.js';
import { getPriceNMinAgo } from '../core/priceHistory.js';

const {
  roundTrip: ROUND_TRIP,
  maxPaybackHours: MAX_PAYBACK_HOURS,
  maxBreakevenHours: MAX_BREAKEVEN_HOURS,
  negativeFundingTicks: NEGATIVE_FUNDING_TICKS,
  delistConfirmTicks: DELIST_CONFIRM_TICKS,
  delistCooldownMinutes: DELIST_COOLDOWN_MINUTES,
  minEntryApyFloor: MIN_ENTRY_APY_FLOOR,
  predictedDropThreshold: PREDICTED_DROP_THRESHOLD,
  fundingGateMinutes: FUNDING_GATE_MINUTES,
  carryTrailEnabled: CARRY_TRAIL_ENABLED,
  carryTrailArmPct: CARRY_TRAIL_ARM_PCT,
  carryTrailArmPctEquity: CARRY_TRAIL_ARM_PCT_EQUITY,
  carryTrailGiveBackPct: CARRY_TRAIL_GIVE_BACK_PCT,
  carrySpikeProtectionPct: CARRY_SPIKE_PROTECTION_PCT,
  carryLossCooldownMin: CARRY_LOSS_COOLDOWN_MIN,
  carryBeRatchetEnabled: CARRY_BE_RATCHET_ENABLED,
  carryBeArmPctEquity: CARRY_BE_ARM_PCT_EQUITY,
  carryBeArmUsd: CARRY_BE_ARM_USD,
  carryBeFloorPctEquity: CARRY_BE_FLOOR_PCT_EQUITY,
  carryPriceOverFunding: CARRY_PRICE_OVER_FUNDING,
  carryStaleTimeoutMin: CARRY_STALE_TIMEOUT_MIN,
  carryStaleMinPnlEquity: CARRY_STALE_MIN_PNL_EQUITY,
  carryApyDecayExitRatio: CARRY_APY_DECAY_EXIT_RATIO,
  carryMaxHoldMin: CARRY_MAX_HOLD_MIN,
  negativeFundingSoftExitMinPnlPct: NEG_FUND_SOFT_MIN_PNL_PCT,
} = config.trading;

// Market-Regime params — читаем из config.trading в рантайме (а не destructure
// при импорте), чтобы тесты могли переключать флаг без перезагрузки модуля.

/**
 * Side-aware unrealized PnL в процентах от entry. Не учитывает funding.
 *   short: цена упала → плюс
 *   long:  цена выросла → плюс
 */
function unrealizedPct(side, entryPrice, currentPrice) {
  const raw = ((currentPrice - entryPrice) / entryPrice) * 100;
  return side === 'long' ? raw : -raw;
}

/**
 * Side-aware unrealized PnL в долларах.
 */
function unrealizedUsd(side, entryPrice, currentPrice, qty) {
  const raw = (currentPrice - entryPrice) * qty;
  return side === 'long' ? raw : -raw;
}

/**
 * Сколько минут осталось до ближайшей выплаты фандинга (HH:00 UTC).
 * @returns {number} число с дробной частью, например 9.5
 */
function minutesUntilNextFunding() {
  const now      = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return (nextHour.getTime() - now.getTime()) / 60_000;
}

/**
 * true если до выплаты < FUNDING_GATE_MINUTES → soft-exits заблокированы.
 */
function isInFundingGate() {
  return minutesUntilNextFunding() < FUNDING_GATE_MINUTES;
}

// Счётчик: сколько тиков подряд funding < 0
let negativeFundingStreak = 0;

// Счётчик: сколько тиков подряд монета отсутствует в scoutData
let disappearedStreak = 0;

// Cooldown после delisted: { coin, until (timestamp) }
let delistCooldown = { coin: null, until: 0 };

// Trailing TP: пик unrealized PnL% по каждой монете. Активируется только
// когда unrealized ≥ ARM_PCT — защита от шума (мелкие колебания не должны
// арм-ить trailing). При закрытии позиции / возврате в Сценарий А — clear.
//
// Два независимых пика на одну позицию:
//   - peakUnrealizedPct  — % движения цены от entry (price-based, без funding)
//   - peakEquityPct      — price-PnL в $ как % equity (масштаб «реальной прибыли»)
// Carry зарабатывает на funding, поэтому % движения цены может быть < 1%, а
// PnL в $ — несколько % от депо. Чтобы trail срабатывал и в этом случае,
// мониторим оба сигнала параллельно: arm/close по тому, который сработал первым.
const peakUnrealizedPct = new Map();
const peakEquityPct     = new Map();

// Дед v2 — breakeven храповик: coin → true, как только цена дала плюс ≥ BE arm
// (либо $-порог, либо %-equity порог). Один раз взведённый, держится до закрытия
// позиции / возврата в Сценарий А (clear вместе с peak-картами). Пока взведён —
// price-PnL не имеет права уйти ниже breakeven-пола (CLOSE breakeven_ratchet).
const beRatchetArmed = new Map();

/** Test helper: очистить состояние breakeven храповика. */
export function _resetBeRatchet() {
  beRatchetArmed.clear();
}

// Per-coin loss cooldown: после price_spike_protection блокируем монету
// на CARRY_LOSS_COOLDOWN_MIN минут. Защита от паттерна VVV 2026-05-10/11:
// stop-out → монета снова #1 по APY → re-entry через 17ч → второй stop-out.
// coin → expiry timestamp (ms).
const carryLossCooldown = new Map();

function isCoinOnLossCooldown(coin, now = Date.now()) {
  const until = carryLossCooldown.get(coin);
  if (!until) return false;
  if (now >= until) {
    carryLossCooldown.delete(coin);
    return false;
  }
  return true;
}

// Ставит per-coin loss cooldown, если closing-PnL по цене < 0. Funding не учитываем —
// он мог быть положительным, но мотивация cooldown'а в том, чтобы не возвращаться в
// монету, которая только что увела позицию в минус по price-move (VVV-паттерн).
function maybeSetLossCooldown(coin, posSide, entryPrice, currentPrice, reason) {
  const pct = unrealizedPct(posSide, entryPrice, currentPrice);
  if (pct >= 0) return;
  const until = Date.now() + CARRY_LOSS_COOLDOWN_MIN * 60_000;
  carryLossCooldown.set(coin, until);
  logger.warn(
    `[Strategist] ${coin} loss cooldown set (${reason}, price PnL ${pct.toFixed(2)}%) | ${CARRY_LOSS_COOLDOWN_MIN}min`,
  );
}

/** Test helper: очистить per-coin loss cooldown. Не используется в проде. */
export function _resetCarryLossCooldown() {
  carryLossCooldown.clear();
}

const {
  minApy,
  entryApy,
  exitBuffer,
  minHoldMinutes,
  breathingMinutes,
} = config.trading;

// Реальный порог выхода = minApy − exitBuffer
// Например: 30 − 5 = 25%. Зона 25–30% = «зона спокойствия».
const effectiveExitApy = minApy - exitBuffer;

/**
 * За сколько часов разница APY окупит round-trip комиссий.
 */
export function calculatePaybackHours(currentApy, targetApy) {
  const deltaHourly = (targetApy - currentApy) / 100 / 365 / 24;
  if (deltaHourly <= 0) return Infinity;
  return ROUND_TRIP / (0.5 * deltaHourly);
}

/**
 * За сколько часов чистый фандинг при данном APY покроет round-trip
 * издержки (вход + выход). Используется как fee-gate при открытии.
 */
export function hoursToBreakeven(apy) {
  const hourlyRate = apy / 100 / 365 / 24;
  if (hourlyRate <= 0) return Infinity;
  return ROUND_TRIP / hourlyRate;
}

/**
 * Сколько минут позиция уже открыта.
 */
function heldMinutes(activePosition) {
  return (Date.now() - activePosition.entry_time) / 60_000;
}

/**
 * Динамический min-hold: позиция обязана сидеть как минимум столько,
 * сколько нужно, чтобы фандинг при её entry_apy окупил round-trip,
 * но не меньше конфигурационного пола и не больше MAX_BREAKEVEN_HOURS
 * (иначе глюк с entry_apy ≈ 0 залочит позицию навсегда — верхний кап
 * как страховка).
 *
 * Критично: на этот гейт завязаны только soft-exits. Экстренные выходы
 * (delist, price spike, negative funding) проверяются выше по функции
 * analyze() и возвращаются раньше, чем мы вообще смотрим на min-hold.
 */
function effectiveMinHold(entryApy) {
  const feeBasedMinutes = hoursToBreakeven(entryApy) * 60;
  const capMinutes      = MAX_BREAKEVEN_HOURS * 60;
  const dynamicMinutes  = Math.max(minHoldMinutes, Math.min(feeBasedMinutes, capMinutes));
  // CARRY_MAX_HOLD_MIN: жёсткий потолок поверх dynamic. 0 = выключить кэп.
  if (CARRY_MAX_HOLD_MIN > 0 && dynamicMinutes > CARRY_MAX_HOLD_MIN) {
    return CARRY_MAX_HOLD_MIN;
  }
  return dynamicMinutes;
}

/**
 * Market-Regime velocity gate. Двухбакетный: bucket 1 ловит быстрый спайк
 * (default 30мин/3%), bucket 2 — медленный pump→plateau (default 2ч/5%).
 * Bucket 2 отключается через MARKET_REGIME_LOOKBACK2_MIN=0.
 *
 * @returns {{ block: true, reason: string } | { block: false, diag: string }}
 *   - block=true: гейт сработал, вызывающему вернуть HOLD
 *   - block=false: pass-through, diag — строка для диагностического лога
 */
function evaluateVelocityGate(coin, side, currentPrice) {
  const t = config.trading;
  const buckets = [
    { mins: t.marketRegimeLookbackMin,  threshold: t.marketRegimeCoinPumpPct,  tag: 'b1' },
  ];
  if (t.marketRegimeLookback2Min > 0) {
    buckets.push({ mins: t.marketRegimeLookback2Min, threshold: t.marketRegimeCoinPumpPct2, tag: 'b2' });
  }

  const moves = [];
  for (const b of buckets) {
    const past = getPriceNMinAgo(coin, b.mins);
    if (past == null) {
      return { block: true, reason: `no ${b.mins}min history yet` };
    }
    const movePct = ((currentPrice - past) / past) * 100;
    const adverse = side === 'short' ? movePct : -movePct;
    if (adverse > b.threshold) {
      const dir = side === 'short' ? 'pumped' : 'dumped';
      return {
        block: true,
        reason: `${dir} ${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}% in ${b.mins}min (${b.tag} threshold ${b.threshold}%)`,
      };
    }
    moves.push(`${b.mins}m=${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}%`);
  }
  return { block: false, diag: moves.join(' ') };
}

/**
 * Carry entry trend gate (Дед v3). Вход-аналог v2 «цена решает».
 *
 * Не открываемся, пока за CARRY_ENTRY_TREND_LOOKBACK_MIN цена ещё движется
 * adversely > CARRY_ENTRY_TREND_ADVERSE_PCT — т.е. импульс прямо сейчас против
 * нашей стороны. Fade/carry хочет реверсию, а не вход в живой тренд; ждём, пока
 * движение выдохнется/развернётся. Закрывает медленный грайнд, который velocity
 * gate (резкий спайк) пропускает.
 *
 *   short: цена ещё растёт > порога за окно → block (шортим в живой памп)
 *   long:  цена ещё падает > порога за окно → block (лонгуем в живой дамп)
 *
 * Окно короткое (default 15мин): монета, что пампанула 2ч назад и встала на
 * плато, пройдёт (recent move ≈ 0) — это валидный fade-сетап. Блокируем только
 * пока adverse-импульс ещё жив.
 *
 * Если истории на окно ещё нет — PASS (не дублируем restart-blackout velocity
 * gate'а; это более тонкий фильтр поверх него).
 *
 * @returns {{ block: true, reason: string } | { block: false, diag: string }}
 */
function evaluateEntryTrendGate(coin, side, currentPrice) {
  const t = config.trading;
  const lookback  = t.carryEntryTrendLookbackMin;
  const threshold = t.carryEntryTrendAdversePct;

  const past = getPriceNMinAgo(coin, lookback);
  if (past == null) {
    return { block: false, diag: `no ${lookback}min history (pass)` };
  }
  const movePct = ((currentPrice - past) / past) * 100;
  const adverse = side === 'short' ? movePct : -movePct;
  if (adverse > threshold) {
    const dir = side === 'short' ? 'rising' : 'falling';
    return {
      block: true,
      reason: `still ${dir} ${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}% in ${lookback}min (threshold ${threshold}%, momentum against ${side})`,
    };
  }
  return { block: false, diag: `${lookback}m=${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}%` };
}

/**
 * Market-Regime BTC gate (Iter B). Глобальный фильтр: если BTC двинулся
 * adversely > порога за окно lookback — блокируем новый вход.
 *
 * - short: BTC pumpнул > порога → красный свет (рынок тащит вверх).
 * - long: BTC dumpнул > порога → красный свет (рынок тащит вниз).
 *
 * Источник цены: priceHistory (наполняется из scout.js на каждый тик).
 * Если истории мало (рестарт <N мин назад) — блокируем (защитный default).
 *
 * @returns {{ block: true, reason: string } | { block: false, diag: string }}
 */
function evaluateBtcRegime(side) {
  const t = config.trading;
  const now = Date.now();
  const lookback = t.marketRegimeBtcLookbackMin;

  const past    = getPriceNMinAgo('BTC', lookback, now);
  const current = getPriceNMinAgo('BTC', 0, now);
  if (past == null || current == null) {
    return { block: true, reason: `no BTC ${lookback}min history yet` };
  }
  const movePct = ((current - past) / past) * 100;
  const adverse = side === 'short' ? movePct : -movePct;
  if (adverse > t.marketRegimeBtcPumpPct) {
    const dir = side === 'short' ? 'pumped' : 'dumped';
    return {
      block: true,
      reason: `BTC ${dir} ${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}% in ${lookback}min (threshold ${t.marketRegimeBtcPumpPct}%)`,
    };
  }
  return { block: false, diag: `BTC ${lookback}m=${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}%` };
}

/**
 * @param {Array<{coin, price, fundingRate, rawApy, smoothedApy, slowApy}>} scoutData
 * @param {Object|undefined} activePosition — строка из таблицы positions
 * @returns {{ action: string, [key: string]: any }}
 */
export function analyze(scoutData, activePosition) {
  // ═══════════════════════════════════════════════
  //  Сценарий А: нет позиции — ищем вход
  // ═══════════════════════════════════════════════
  if (!activePosition) {
    // Сбрасываем счётчики — нет позиции
    negativeFundingStreak = 0;
    disappearedStreak = 0;
    peakUnrealizedPct.clear();
    peakEquityPct.clear();
    beRatchetArmed.clear();

    // Per-coin loss cooldown: после price_spike_protection монета на N мин в бане.
    // Фильтруем кандидатов ДО выбора best — иначе бот может HOLD'ить на cooldown'нутой
    // монете, пропуская следующую по списку.
    const now = Date.now();
    const eligible = scoutData.filter((c) => {
      if (isCoinOnLossCooldown(c.coin, now)) {
        const remainMin = ((carryLossCooldown.get(c.coin) - now) / 60_000).toFixed(0);
        logger.info(
          `[Strategist] skip ${c.coin} (loss cooldown, ${remainMin}min remaining)`,
        );
        return false;
      }
      return true;
    });

    // Iter 1.2: под флагом CARRY_LONG_ENABLED берём top-by-abs(apy) — scout
    // уже отсортировал. Без флага — только short (сохраняет старое поведение).
    // Fallback `|| 'short'`: тесты передают scoutData без поля side.
    const best = config.trading.carryLongEnabled
      ? eligible[0]
      : eligible.find((c) => (c.side || 'short') === 'short');

    const bestSide = best?.side || 'short';
    const bestAbsApy = best ? Math.abs(best.smoothedApy) : 0;

    if (!best || bestAbsApy < entryApy) {
      logger.info(
        `[Strategist] HOLD — no coin ≥ ${entryApy}% | best: ${best?.coin ?? '—'} @ ${best?.smoothedApy.toFixed(2) ?? 0}%`,
      );
      return { action: 'HOLD' };
    }

    // Защитный порог: не входим если APY ниже пола
    if (bestAbsApy < MIN_ENTRY_APY_FLOOR) {
      logger.info(
        `[Strategist] HOLD — ${best.coin} APY ${best.smoothedApy.toFixed(2)}% < floor ${MIN_ENTRY_APY_FLOOR}%`,
      );
      return { action: 'HOLD' };
    }

    // Fee-aware entry gate: round-trip должен окупиться за MAX_BREAKEVEN_HOURS
    // чистым фандингом. Это наш защитный механизм от «суеты» на слабых сигналах.
    const breakevenH = hoursToBreakeven(bestAbsApy);
    if (breakevenH > MAX_BREAKEVEN_HOURS) {
      logger.info(
        `[Strategist] HOLD (fee-gate) — ${best.coin} @ ${best.smoothedApy.toFixed(2)}% ` +
          `→ breakeven ${breakevenH.toFixed(1)}h > ${MAX_BREAKEVEN_HOURS}h`,
      );
      return { action: 'HOLD' };
    }

    // Predicted-drop filter: carry не входит при прогнозируемом падении
    // фандинга. Для long-стороны APY отрицательные → сравниваем abs-значения.
    if (best.predictedApy != null && best.rawApy !== 0) {
      const rawAbs       = Math.abs(best.rawApy);
      const predictedAbs = Math.abs(best.predictedApy);
      const drop = (rawAbs - predictedAbs) / rawAbs;
      if (drop > PREDICTED_DROP_THRESHOLD) {
        logger.info(
          `[Strategist] HOLD (predicted drop) — ${best.coin} APY ${best.rawApy.toFixed(0)}% → ` +
            `predicted ${best.predictedApy.toFixed(0)}% (-${(drop * 100).toFixed(0)}%)`,
        );
        return { action: 'HOLD' };
      }
    }

    // Delist cooldown: не входим в монету, которая недавно «исчезла».
    // Защита от цикла delisted → re-entry → delisted (FARTCOIN/MAVIA паттерн).
    if (
      delistCooldown.coin === best.coin &&
      Date.now() < delistCooldown.until
    ) {
      const remainMin = ((delistCooldown.until - Date.now()) / 60_000).toFixed(0);
      logger.info(
        `[Strategist] HOLD (delist cooldown) — ${best.coin} recently delisted, ${remainMin}min remaining`,
      );
      return { action: 'HOLD' };
    }

    // Market Regime velocity gate (двухбакетный): не лезем в шорт против
    // только что pumpанувшей монеты (и зеркально — в long против падающей).
    if (config.trading.marketRegimeVelocityEnabled) {
      const gate = evaluateVelocityGate(best.coin, bestSide, best.price);
      if (gate.block) {
        logger.info(
          `[Strategist] HOLD (velocity gate) — ${best.coin} ${gate.reason} (side=${bestSide})`,
        );
        return { action: 'HOLD' };
      }
      logger.info(
        `[Strategist] velocity gate PASS — ${best.coin} ${gate.diag} (side=${bestSide})`,
      );
    }

    // Market Regime BTC gate (Iter B): глобальный фон рынка. Coin может стоять
    // ровно, но BTC тащит весь рынок — short в зелёный bg / long в красный bg плохо.
    if (config.trading.marketRegimeBtcEnabled) {
      const gate = evaluateBtcRegime(bestSide);
      if (gate.block) {
        logger.info(
          `[Strategist] HOLD (BTC regime) — ${gate.reason} (side=${bestSide})`,
        );
        return { action: 'HOLD' };
      }
      logger.info(`[Strategist] BTC regime PASS — ${gate.diag} (side=${bestSide})`);
    }

    // Entry trend gate (Дед v3): не входим, пока импульс ещё против нас за
    // последние N минут. Симметрия к v2 «цена решает» — теперь и на входе.
    if (config.trading.carryEntryTrendEnabled) {
      const gate = evaluateEntryTrendGate(best.coin, bestSide, best.price);
      if (gate.block) {
        logger.info(
          `[Strategist] HOLD (entry trend) — ${best.coin} ${gate.reason}`,
        );
        return { action: 'HOLD' };
      }
      logger.info(
        `[Strategist] entry trend PASS — ${best.coin} ${gate.diag} (side=${bestSide})`,
      );
    }

    logger.info(
      `[Strategist] OPEN ${bestSide.toUpperCase()} — ${best.coin} @ ${best.smoothedApy.toFixed(2)}% | breakeven ${breakevenH.toFixed(1)}h`,
    );
    return {
      action: 'OPEN',
      coin:   best.coin,
      apy:    best.smoothedApy,
      price:  best.price,
      side:   bestSide,
    };
  }

  // ═══════════════════════════════════════════════
  //  Сценарий Б: есть позиция
  // ═══════════════════════════════════════════════
  const currentCoin = activePosition.coin;
  const current     = scoutData.find((m) => m.coin === currentCoin);
  const held        = heldMinutes(activePosition);
  const posSide     = activePosition.side || 'short';

  // ── Экстренные выходы (игнорируют minHold) ────
  // Эти проверки срабатывают ВСЕГДА — даже через 1 секунду.

  // 1. Монета исчезла — с гистерезисом.
  //    API Hyperliquid иногда «мерцает» — пропускает монету на 1-2 тика.
  //    Закрываем только после DELIST_CONFIRM_TICKS подряд.
  if (!current) {
    disappearedStreak++;
    logger.warn(
      `[Strategist] ${currentCoin} disappeared — streak: ${disappearedStreak}/${DELIST_CONFIRM_TICKS}`,
    );

    if (disappearedStreak >= DELIST_CONFIRM_TICKS) {
      disappearedStreak = 0;
      delistCooldown = { coin: currentCoin, until: Date.now() + DELIST_COOLDOWN_MINUTES * 60_000 };
      peakUnrealizedPct.delete(currentCoin);
      peakEquityPct.delete(currentCoin);
      beRatchetArmed.delete(currentCoin);
      logger.warn(
        `[Strategist] CLOSE — ${currentCoin} confirmed delisted (${DELIST_CONFIRM_TICKS} ticks) | ` +
          `cooldown ${DELIST_COOLDOWN_MINUTES}min`,
      );
      return {
        action: 'CLOSE',
        coin:   currentCoin,
        price:  activePosition.entry_price,
        reason: 'delisted',
      };
    }

    return { action: 'HOLD' };
  }

  // Монета вернулась в scoutData — сброс счётчика
  if (disappearedStreak > 0) {
    logger.info(
      `[Strategist] ${currentCoin} reappeared after ${disappearedStreak} tick(s) — streak reset`,
    );
    disappearedStreak = 0;
  }

  // 2. Adverse price move > CARRY_SPIKE_PROTECTION_PCT — защита от убытка.
  //    short: pump против нас. long: dump против нас.
  const rawMovePct  = ((current.price - activePosition.entry_price) / activePosition.entry_price) * 100;
  const adverseMove = posSide === 'long' ? -rawMovePct : rawMovePct;
  if (adverseMove > CARRY_SPIKE_PROTECTION_PCT) {
    peakUnrealizedPct.delete(currentCoin);
    peakEquityPct.delete(currentCoin);
    const dir = posSide === 'long' ? 'dumped' : 'spiked';
    const cooldownUntil = Date.now() + CARRY_LOSS_COOLDOWN_MIN * 60_000;
    carryLossCooldown.set(currentCoin, cooldownUntil);
    logger.warn(
      `[Strategist] CLOSE — ${currentCoin} price ${dir} ${rawMovePct >= 0 ? '+' : ''}${rawMovePct.toFixed(2)}% (${posSide} at risk) | cooldown ${CARRY_LOSS_COOLDOWN_MIN}min`,
    );
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  current.price,
      reason: 'price_spike_protection',
    };
  }

  // 3. Trailing TP: фиксируем прибыль когда позиция сдала GIVE_BACK% от пика.
  //    Carry — short, поэтому price-PnL = (entry − current) / entry * 100.
  //    Параллельно мониторим два сигнала, либой может зафайрить close:
  //      (a) % движения цены ≥ CARRY_TRAIL_ARM_PCT (классический)
  //      (b) price-PnL$ как % equity ≥ CARRY_TRAIL_ARM_PCT_EQUITY — нужен для
  //          carry, где цена дрейфует на 0.5–1%, но $ от funding'а — несколько
  //          процентов депо. Без (b) на маленьких позициях trail не армится.
  //    Идёт ВЫШЕ negative_funding: цель — выйти на просадке от пика, пока funding
  //    ещё положительный. Игнорирует minHold (это защитный, не soft-выход).
  if (CARRY_TRAIL_ENABLED) {
    const unrealizedPctVal = unrealizedPct(posSide, activePosition.entry_price, current.price);

    // Path A: price-move %
    if (unrealizedPctVal >= CARRY_TRAIL_ARM_PCT) {
      const prevPeak = peakUnrealizedPct.get(currentCoin) ?? 0;
      if (unrealizedPctVal > prevPeak) peakUnrealizedPct.set(currentCoin, unrealizedPctVal);
    }

    // Path B: equity %. Equity берём из balance cache (sync). Если кэша нет —
    // path B молча disabled (path A продолжает работать).
    const equity = getCachedAccountValueSync();
    let equityPct = null;
    if (equity && equity > 0) {
      const qty    = activePosition.size_usd / activePosition.entry_price;
      const pnlUsd = unrealizedUsd(posSide, activePosition.entry_price, current.price, qty);
      equityPct    = (pnlUsd / equity) * 100;

      if (equityPct >= CARRY_TRAIL_ARM_PCT_EQUITY) {
        const prevPeakEq = peakEquityPct.get(currentCoin) ?? 0;
        if (equityPct > prevPeakEq) peakEquityPct.set(currentCoin, equityPct);
      }
    }

    const peakPrice  = peakUnrealizedPct.get(currentCoin) ?? 0;
    const peakEquity = peakEquityPct.get(currentCoin) ?? 0;

    // Path A trigger
    if (peakPrice >= CARRY_TRAIL_ARM_PCT) {
      const giveBack          = peakPrice - unrealizedPctVal;
      const giveBackThreshold = peakPrice * (CARRY_TRAIL_GIVE_BACK_PCT / 100);
      if (giveBack >= giveBackThreshold) {
        logger.warn(
          `[Strategist] CLOSE — ${currentCoin} trailing TP (price): peak +${peakPrice.toFixed(2)}% → ` +
            `now +${unrealizedPctVal.toFixed(2)}% (gave back ${(giveBack / peakPrice * 100).toFixed(0)}% ≥ ${CARRY_TRAIL_GIVE_BACK_PCT}%)`,
        );
        peakUnrealizedPct.delete(currentCoin);
        peakEquityPct.delete(currentCoin);
        return {
          action: 'CLOSE',
          coin:   currentCoin,
          price:  current.price,
          reason: 'trailing_tp',
        };
      }
    }

    // Path B trigger
    if (peakEquity >= CARRY_TRAIL_ARM_PCT_EQUITY && equityPct !== null) {
      const giveBack          = peakEquity - equityPct;
      const giveBackThreshold = peakEquity * (CARRY_TRAIL_GIVE_BACK_PCT / 100);
      if (giveBack >= giveBackThreshold) {
        logger.warn(
          `[Strategist] CLOSE — ${currentCoin} trailing TP (equity): peak +${peakEquity.toFixed(2)}% eq → ` +
            `now +${equityPct.toFixed(2)}% eq (gave back ${(giveBack / peakEquity * 100).toFixed(0)}% ≥ ${CARRY_TRAIL_GIVE_BACK_PCT}%)`,
        );
        peakUnrealizedPct.delete(currentCoin);
        peakEquityPct.delete(currentCoin);
        return {
          action: 'CLOSE',
          coin:   currentCoin,
          price:  current.price,
          reason: 'trailing_tp_equity',
        };
      }
    }
  }

  // 3.4 Breakeven храповик (дед v2): как только цена дала плюс ≥ BE arm (любой из
  //     порогов: $-абсолютный ИЛИ %-equity), взводим храповик и больше НИКОГДА не
  //     даём price-PnL уйти ниже breakeven-пола. Ловит подарки МЕНЬШЕ trail-arm
  //     (1.2% eq) — именно те, что дед раньше отдавал обратно в 0. Идёт ВЫШЕ
  //     funding-выходов, игнорирует minHold (защитный, не soft-выход).
  let priceProtectionArmed = false;
  if (CARRY_BE_RATCHET_ENABLED) {
    const qty       = activePosition.size_usd / activePosition.entry_price;
    const pricePnlUsd = unrealizedUsd(posSide, activePosition.entry_price, current.price, qty);
    const eq        = getCachedAccountValueSync();
    const pricePnlEqPct = eq && eq > 0 ? (pricePnlUsd / eq) * 100 : null;

    // Arm: $-порог ИЛИ %-equity порог (что сработает первым).
    const armNow =
      pricePnlUsd >= CARRY_BE_ARM_USD ||
      (pricePnlEqPct !== null && pricePnlEqPct >= CARRY_BE_ARM_PCT_EQUITY);
    if (armNow) beRatchetArmed.set(currentCoin, true);

    if (beRatchetArmed.get(currentCoin)) {
      priceProtectionArmed = true;
      // Пол: price-PnL опустился до/ниже breakeven (FLOOR=0) → выходим в безубыток.
      // С equity сравниваем по %, без кэша — по $ (floor=0).
      const belowFloor =
        pricePnlEqPct !== null
          ? pricePnlEqPct <= CARRY_BE_FLOOR_PCT_EQUITY
          : pricePnlUsd <= 0;
      if (belowFloor) {
        logger.warn(
          `[Strategist] CLOSE — ${currentCoin} breakeven ratchet: price-PnL ` +
            `${pricePnlUsd >= 0 ? '+' : ''}$${pricePnlUsd.toFixed(2)}` +
            `${pricePnlEqPct !== null ? ` (${pricePnlEqPct.toFixed(2)}% eq)` : ''} ` +
            `≤ floor ${CARRY_BE_FLOOR_PCT_EQUITY}% — не отдаём подарок в 0`,
        );
        peakUnrealizedPct.delete(currentCoin);
        peakEquityPct.delete(currentCoin);
        beRatchetArmed.delete(currentCoin);
        return {
          action: 'CLOSE',
          coin:   currentCoin,
          price:  current.price,
          reason: 'breakeven_ratchet',
        };
      }
    }
  }

  // priceProtectionArmed также истина, если взведён обычный trailing (peak ≥ arm).
  // Используется ниже гейтом «цена > фандинг»: пока цена защищена trail/ratchet,
  // funding-выходы (apy_decay / stale / apy_below) не выдёргивают деда — пусть едет.
  if (
    (peakUnrealizedPct.get(currentCoin) ?? 0) >= CARRY_TRAIL_ARM_PCT ||
    (peakEquityPct.get(currentCoin) ?? 0) >= CARRY_TRAIL_ARM_PCT_EQUITY
  ) {
    priceProtectionArmed = true;
  }
  const fundingExitBlocked = CARRY_PRICE_OVER_FUNDING && priceProtectionArmed;

  // 3.5 Smart guards против "тихих" carry-позиций (FARTCOIN 2026-05-13).
  //
  // КРИТИЧНО: оба guard'а фолсят ТОЛЬКО при unrealizedPct ≥ 0. Если позиция
  // в минусе — НЕ фиксируем лосс, fall through к: spike protection (-4%) /
  // negative funding / hold lock + apy_below_threshold. Логика "выйти из
  // мёртвой позиции, чтобы освободить слот" применима только когда не несём
  // ущерб от закрытия.
  const guardUnrealizedPct = unrealizedPct(posSide, activePosition.entry_price, current.price);

  // Guard A — APY decay exit: если slowApy упал в N раз от entry_apy, нет смысла
  // дожидаться hold lock — сигнал, на котором заходили, развалился. Игнорим minHold.
  // 0 = выключено.
  if (CARRY_APY_DECAY_EXIT_RATIO > 0 && activePosition.entry_apy > 0 && guardUnrealizedPct >= 0) {
    const entryAbs   = Math.abs(activePosition.entry_apy);
    const currentAbs = Math.abs(current.slowApy);
    const ratio      = currentAbs / entryAbs;
    if (ratio < CARRY_APY_DECAY_EXIT_RATIO) {
      // Цена > фандинг (дед v2): trail/ratchet взведён — не выходим по распаду
      // APY, пусть ценовой winner едет. Выход отдаём trailing/breakeven.
      if (fundingExitBlocked) {
        logger.info(
          `[Strategist] HOLD (price>funding) — ${currentCoin} apy_decay ${(ratio * 100).toFixed(0)}% ` +
            `but price protection armed — trail/ratchet рулит выходом`,
        );
      } else if (isInFundingGate()) {
        logger.info(
          `[Strategist] HOLD (funding gate) — ${currentCoin} apy_decay ${(ratio * 100).toFixed(0)}% ` +
            `but ${minutesUntilNextFunding().toFixed(1)}min to funding payout`,
        );
      } else {
        logger.warn(
          `[Strategist] CLOSE — ${currentCoin} apy_decay: slowApy ${current.slowApy.toFixed(2)}% / ` +
            `entryApy ${activePosition.entry_apy.toFixed(1)}% = ${(ratio * 100).toFixed(0)}% < ${(CARRY_APY_DECAY_EXIT_RATIO * 100).toFixed(0)}% threshold (held ${held.toFixed(0)}min)`,
        );
        peakUnrealizedPct.delete(currentCoin);
        peakEquityPct.delete(currentCoin);
        return {
          action: 'CLOSE',
          coin:   currentCoin,
          price:  current.price,
          reason: 'apy_decay',
        };
      }
    }
  }

  // Guard B — stale-position timeout: если за CARRY_STALE_TIMEOUT_MIN ни разу
  // не был достигнут CARRY_STALE_MIN_PNL_EQUITY% от equity (peakEquity всё ещё 0),
  // позиция бесполезна — закрываем. peakEquity арм-ится в trailing TP блоке выше
  // (требует unrealized ≥ CARRY_TRAIL_ARM_PCT_EQUITY), здесь сравниваем с
  // независимым порогом CARRY_STALE_MIN_PNL_EQUITY (обычно ниже trail arm).
  // 0 = выключено. ТОЛЬКО при unrealizedPct ≥ 0 (см. коммент к Guard A).
  if (CARRY_STALE_TIMEOUT_MIN > 0 && held >= CARRY_STALE_TIMEOUT_MIN && guardUnrealizedPct >= 0) {
    const equity = getCachedAccountValueSync();
    if (equity && equity > 0) {
      const qty           = activePosition.size_usd / activePosition.entry_price;
      const pnlUsd        = unrealizedUsd(posSide, activePosition.entry_price, current.price, qty);
      const equityPctNow  = (pnlUsd / equity) * 100;
      const peakEquityVal = peakEquityPct.get(currentCoin) ?? 0;
      const bestEverEqPct = Math.max(equityPctNow, peakEquityVal);
      if (bestEverEqPct < CARRY_STALE_MIN_PNL_EQUITY) {
        if (fundingExitBlocked) {
          logger.info(
            `[Strategist] HOLD (price>funding) — ${currentCoin} stale ${held.toFixed(0)}min ` +
              `but price protection armed — trail/ratchet рулит выходом`,
          );
        } else if (isInFundingGate()) {
          logger.info(
            `[Strategist] HOLD (funding gate) — ${currentCoin} stale ${held.toFixed(0)}min but ` +
              `${minutesUntilNextFunding().toFixed(1)}min to funding payout`,
          );
        } else {
          logger.warn(
            `[Strategist] CLOSE — ${currentCoin} stale: held ${held.toFixed(0)}min ≥ ${CARRY_STALE_TIMEOUT_MIN}min ` +
              `but best equity PnL was only ${bestEverEqPct.toFixed(2)}% < ${CARRY_STALE_MIN_PNL_EQUITY}% threshold`,
          );
          peakUnrealizedPct.delete(currentCoin);
          peakEquityPct.delete(currentCoin);
          return {
            action: 'CLOSE',
            coin:   currentCoin,
            price:  current.price,
            reason: 'stale_position',
          };
        }
      }
    }
  }

  // 4. Фандинг развернулся против позиции (мы платим, а не нам).
  //    short страдает при fundingRate < 0; long — при fundingRate > 0.
  //    Гистерезис: закрываем только если adverse N тиков подряд.
  const fundingAdverse =
    posSide === 'long' ? current.fundingRate > 0 : current.fundingRate < 0;
  if (fundingAdverse) {
    negativeFundingStreak++;
    logger.warn(
      `[Strategist] ⚠️ ${currentCoin} funding adverse for ${posSide} (${current.fundingRate}) — ` +
        `streak: ${negativeFundingStreak}/${NEGATIVE_FUNDING_TICKS}`,
    );

    if (negativeFundingStreak >= NEGATIVE_FUNDING_TICKS) {
      // Soft путь (через snайпера): funding развернулся, но позиция в плюсе ≥ X% —
      // не теряем время, но экономим maker-комиссию. В минусе → market, чтоб резать.
      const unrealizedPctVal = unrealizedPct(posSide, activePosition.entry_price, current.price);
      const useSoftExit      = unrealizedPctVal >= NEG_FUND_SOFT_MIN_PNL_PCT;
      const reason           = useSoftExit ? 'negative_funding_softexit' : 'negative_funding';

      logger.warn(
        `[Strategist] CLOSE — ${currentCoin} funding adverse ${negativeFundingStreak} ticks ` +
          `(unrealized ${unrealizedPctVal >= 0 ? '+' : ''}${unrealizedPctVal.toFixed(2)}% → ${useSoftExit ? 'soft via sniper' : 'market'})`,
      );
      negativeFundingStreak = 0; // сброс
      peakUnrealizedPct.delete(currentCoin); // позиция закрывается → пик не нужен
      peakEquityPct.delete(currentCoin);
      maybeSetLossCooldown(currentCoin, posSide, activePosition.entry_price, current.price, reason);
      return {
        action: 'CLOSE',
        coin:   currentCoin,
        price:  current.price,
        reason,
      };
    }
  } else {
    // Funding снова в нашу пользу — сброс счётчика
    if (negativeFundingStreak > 0) {
      logger.info(
        `[Strategist] ✅ ${currentCoin} funding recovered (${current.fundingRate}) — streak reset`,
      );
      negativeFundingStreak = 0;
    }
  }

  // ── Обычные выходы (только после minHold) ─────
  // Используем slowApy — глубокое сглаживание, без паники.
  // minHold динамический: = max(60, hoursToBreakeven(entryApy) * 60).
  // То есть позиция обязана сидеть ровно столько, сколько нужно её
  // фандингу, чтобы покрыть round-trip комиссий.
  const minHold = effectiveMinHold(activePosition.entry_apy);

  if (held >= minHold) {
    // APY упал ниже (minApy − exitBuffer)
    // Пример: minApy=30, exitBuffer=5 → выходим только ниже 25%
    // Для long-стороны slowApy отрицательный — сравниваем по модулю.
    if (Math.abs(current.slowApy) < effectiveExitApy) {
      // Цена > фандинг (дед v2): trail/ratchet взведён — не режем по падению APY,
      // пусть ценовой winner едет. Выход отдаём trailing/breakeven.
      if (fundingExitBlocked) {
        logger.info(
          `[Strategist] HOLD (price>funding) — ${currentCoin} slowApy ${current.slowApy.toFixed(2)}% ` +
            `< exit ${effectiveExitApy}% but price protection armed — trail/ratchet рулит выходом`,
        );
        return { action: 'HOLD' };
      }
      // Funding-Aware Gate: не выходим в окне выплаты — потеряем накопленный фандинг
      if (isInFundingGate()) {
        logger.info(
          `[Strategist] HOLD (funding gate) — ${currentCoin} slowApy ${current.slowApy.toFixed(2)}% ` +
            `< exit ${effectiveExitApy}% but ${minutesUntilNextFunding().toFixed(1)}min to funding payout`,
        );
        return { action: 'HOLD' };
      }

      logger.warn(
        `[Strategist] CLOSE — ${currentCoin} slowApy ${current.slowApy.toFixed(2)}% < effectiveExit ${effectiveExitApy}% (held ${held.toFixed(0)}min)`,
      );
      peakUnrealizedPct.delete(currentCoin);
      peakEquityPct.delete(currentCoin);
      beRatchetArmed.delete(currentCoin);
      maybeSetLossCooldown(currentCoin, posSide, activePosition.entry_price, current.price, 'apy_below_threshold');
      return {
        action: 'CLOSE',
        coin:   currentCoin,
        price:  current.price,
        reason: 'apy_below_threshold',
      };
    }
  } else {
    logger.info(
      `[Strategist] ${currentCoin} slowApy=${current.slowApy.toFixed(2)}% | hold lock: ${held.toFixed(0)}/${minHold.toFixed(0)} min (dynamic, entryApy=${activePosition.entry_apy.toFixed(1)}%)`,
    );
  }

  // ── Ротация (fee-recovery guard + breathing) ──
  // Симметричный гейт: ротация запрещена, пока текущая позиция не
  // окупила свой round-trip (оценка через entry_apy и held time).
  // Это строго сильнее старого breathingMinutes — то остаётся
  // декоративным нижним полом, но его руками не трогаем.
  const rotationMinHold = effectiveMinHold(activePosition.entry_apy);

  if (held < rotationMinHold) {
    logger.debug(
      `[Strategist] ${currentCoin} rotation locked: ${held.toFixed(0)}/${rotationMinHold.toFixed(0)} min ` +
        `(fee-recovery, entryApy=${activePosition.entry_apy.toFixed(1)}%)`,
    );
    return { action: 'HOLD' };
  }

  if (held >= breathingMinutes) {
    // Ротация только в пределах того же side (Iter 1.1). Без флага у всех
    // активных позиций side='short' (миграция 1.0), поведение идентично.
    const activeSide = posSide;
    const best = scoutData.find(
      (m) => m.coin !== currentCoin && (m.side || 'short') === activeSide,
    );

    // Сравниваем по модулю: для long обе цифры отрицательные, более «глубокое»
    // отрицательное = более выгодный кандидат.
    if (best && Math.abs(best.smoothedApy) > Math.abs(current.smoothedApy)) {
      const hours = calculatePaybackHours(Math.abs(current.smoothedApy), Math.abs(best.smoothedApy));

      if (hours <= MAX_PAYBACK_HOURS) {
        // Funding-Aware Gate: ротация = close+open, close теряет накопленный фандинг
        if (isInFundingGate()) {
          logger.info(
            `[Strategist] HOLD (funding gate) — would rotate ${currentCoin} → ${best.coin} ` +
              `but ${minutesUntilNextFunding().toFixed(1)}min to funding payout`,
          );
          return { action: 'HOLD' };
        }

        // Market Regime velocity gate тоже на ротации — целевая монета
        // может pumpить (для short) или dumpить (для long).
        if (config.trading.marketRegimeVelocityEnabled) {
          const gate = evaluateVelocityGate(best.coin, activeSide, best.price);
          if (gate.block) {
            logger.info(
              `[Strategist] HOLD (velocity gate) — would rotate to ${best.coin} but ${gate.reason}`,
            );
            return { action: 'HOLD' };
          }
          logger.info(
            `[Strategist] velocity gate PASS (rotate→${best.coin}) — ${gate.diag}`,
          );
        }

        // BTC regime gate на ротации (Iter B): рынок мог развернуться в красное
        // для нашей стороны — лучше остаться в текущей и доехать, чем платить
        // комиссии на ротацию против фона.
        if (config.trading.marketRegimeBtcEnabled) {
          const gate = evaluateBtcRegime(activeSide);
          if (gate.block) {
            logger.info(
              `[Strategist] HOLD (BTC regime) — would rotate to ${best.coin} but ${gate.reason}`,
            );
            return { action: 'HOLD' };
          }
          logger.info(
            `[Strategist] BTC regime PASS (rotate→${best.coin}) — ${gate.diag}`,
          );
        }

        logger.info(
          `[Strategist] ROTATE — ${currentCoin} (${current.smoothedApy.toFixed(2)}%) → ${best.coin} (${best.smoothedApy.toFixed(2)}%) | payback: ${hours.toFixed(1)}h`,
        );
        peakUnrealizedPct.delete(currentCoin);
        peakEquityPct.delete(currentCoin);
        beRatchetArmed.delete(currentCoin);
        maybeSetLossCooldown(currentCoin, posSide, activePosition.entry_price, current.price, 'rotate_better_apy');
        return {
          action:       'ROTATE',
          closeCoin:    currentCoin,
          closePrice:   current.price,
          openCoin:     best.coin,
          openPrice:    best.price,
          openApy:      best.smoothedApy,
          openSide:     activeSide, // ротация всегда same-side
          paybackHours: parseFloat(hours.toFixed(1)),
          reason:       'better_apy',
        };
      }

      logger.info(
        `[Strategist] HOLD — ${best.coin} ${best.smoothedApy.toFixed(2)}% but payback ${hours.toFixed(1)}h > ${MAX_PAYBACK_HOURS}h`,
      );
    }
  }

  return { action: 'HOLD' };
}
