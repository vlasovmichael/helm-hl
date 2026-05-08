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
  return Math.max(minHoldMinutes, Math.min(feeBasedMinutes, capMinutes));
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

    // Iter 1.2: под флагом CARRY_LONG_ENABLED берём top-by-abs(apy) — scout
    // уже отсортировал. Без флага — только short (сохраняет старое поведение).
    // Fallback `|| 'short'`: тесты передают scoutData без поля side.
    const best = config.trading.carryLongEnabled
      ? scoutData[0]
      : scoutData.find((c) => (c.side || 'short') === 'short');

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
    logger.warn(
      `[Strategist] CLOSE — ${currentCoin} price ${dir} ${rawMovePct >= 0 ? '+' : ''}${rawMovePct.toFixed(2)}% (${posSide} at risk)`,
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

        logger.info(
          `[Strategist] ROTATE — ${currentCoin} (${current.smoothedApy.toFixed(2)}%) → ${best.coin} (${best.smoothedApy.toFixed(2)}%) | payback: ${hours.toFixed(1)}h`,
        );
        peakUnrealizedPct.delete(currentCoin);
        peakEquityPct.delete(currentCoin);
        return {
          action:       'ROTATE',
          closeCoin:    currentCoin,
          closePrice:   current.price,
          openCoin:     best.coin,
          openPrice:    best.price,
          openApy:      best.smoothedApy,
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
