// ─────────────────────────────────────────────────
//  Production Close — закрытие реальных позиций на Hyperliquid
//  Общий путь для ВСЕХ стратегий (hunter / hunter_long / adopt).
//  Пара к paperClose (paper.js). Диспетчеризуется из index.js (handleClose).
// ─────────────────────────────────────────────────

import { logger } from '../../core/logger.js';
import { retryWithBackoff } from '../../core/retry.js';
import {
  closePosition as dbClosePosition,
  recordBotOid,
} from '../../core/database.js';
import {
  closeMarket,
  getAccountSummary,
  getPositions,
} from '../exchange.js';
import { parseFillResponse } from './fill-parser.js';
import { closeLimitFirst } from './limitClose.js';
import { fetchUserFills, classifyClose, findRoundTripForPosition } from '../userFills.js';
import { calcPnl, checkSlippage, MARKET_SLIPPAGE, FEE_RATE, MAKER_FEE_RATE } from './math.js';
import { config } from '../../core/config.js';
import {
  banSlippage, setCooldown, recordLoss,
  SLIPPAGE_BAN_TTL_MS, REENTRY_COOLDOWN_MS, CB_PAUSE_MS,
} from './state.js';
import { reconcile } from './reconciler.js';
import { notify } from './hooks.js';
import { clearAdoptState, getAdoptPeakPct, consumeAdoptMfeMae } from '../strategistAdopt.js';
import { finalizeAdoptTimeCut } from '../adoptShadowTimeCut.js';
import { finalizeAdoptShadowTrail, clearAdoptShadowTrail } from '../adoptShadowTrail.js';
import {
  notifySlippageBan,
  notifyProductionClose, notifyCloseRejected, notifyCloseFailed,
  notifyExternalClose,
  notifyCircuitBreaker,
} from './notifications.js';

/**
 * Отказ биржи, означающий «позиции, которую мы собирались закрыть, уже нет».
 * `Reduce only order would increase position` — reduce-only ордер на флэте/после
 * разворота (оператор закрыл руками за секунду до нас). Раньше такой отказ только
 * логировался, DB-строка оставалась OPEN со СТАРЫМ entry_price — и если оператор
 * тут же перезаходил, бот продолжал вести чужую позу по старому входу
 * (KAITO 30.07: трейл увидел фейковый пик +8.8% и записал +$1.94 вместо −$0.58).
 */
export function isPositionGoneRejection(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('reduce only order would increase position')
      || m.includes('no position found');
}

/**
 * Жива ли на бирже поза той же монеты и той же стороны, что DB-строка.
 * Отдельно от integrity.liveMatchesPosition: там формат fetchExchangePositions,
 * здесь сырой getPositions(). null = не смогли прочитать биржу.
 */
async function sameSidePositionAlive(position, coin) {
  try {
    const positions = await getPositions();
    const dbSide = (position.side || 'short').toLowerCase();
    return positions.some((ap) => {
      const p = ap?.position ?? ap;
      if (p?.coin !== coin) return false;
      const szi = parseFloat(p?.szi ?? '0');
      if (!szi) return false;
      return (szi < 0 ? 'short' : 'long') === dbSide;
    });
  } catch (err) {
    logger.warn(`[Executor] #${coin} — не смог сверить позу с биржей: ${err.message}`);
    return null;
  }
}

export async function productionClose(signal, position, silent = false) {
  const coin = position.coin;
  // Close-направление инвертируется к open: short→BUY, long→SELL.
  const posSide      = position.side || 'short';
  const closeLabel   = posSide === 'long' ? 'SELL' : 'BUY';

  const holdMs = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;

  logger.info(
    `[Executor] PROD CLOSE ${posSide.toUpperCase()} #${coin} — reason: ${signal.reason} | ` +
      `held: ${holdHours.toFixed(1)}h | markPrice: $${signal.price}`,
  );

  // ── 0. Снимаем реальный накопленный фандинг ДО закрытия ─
  // После marketClose позиция исчезнет из clearinghouseState и cumFunding пропадёт.
  // HL convention (side-agnostic): cumFunding.sinceOpen — сколько трейдер заплатил
  // (signed). Получал фандинг → отрицательный → realFundingUsd = -sinceOpen положительный.
  // Платил → положительный → realFundingUsd отрицательный.
  // Подтверждено эмпирически на PURR (short): sinceOpen=-0.009869 → +$0.009869 профита.
  let realFundingUsd = null;
  try {
    const positions = await getPositions();
    const found = positions.find((ap) => (ap?.position?.coin) === coin);
    if (!found) {
      // Позиции уже нет на бирже — это external close (SL/TP/liq/manual).
      // marketClose ниже упадёт с "No position found" и уйдёт в external-close ветку,
      // где cause определяется через userFills. cumFunding читать неоткуда — это нормально.
      logger.info(
        `[Executor] PROD CLOSE #${coin} — position absent in clearinghouseState (external close path); skipping cumFunding read`,
      );
    } else {
      const sinceOpenRaw = found?.position?.cumFunding?.sinceOpen;
      const sinceOpen = parseFloat(sinceOpenRaw);
      if (Number.isFinite(sinceOpen)) {
        realFundingUsd = -sinceOpen;
        logger.info(
          `[Executor] PROD CLOSE #${coin} — cumFunding.sinceOpen=${sinceOpen} → realFundingUsd=$${realFundingUsd.toFixed(6)}`,
        );
      } else {
        logger.warn(
          `[Executor] PROD CLOSE #${coin} — cumFunding.sinceOpen unparseable (${sinceOpenRaw}), fallback to APY estimate`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      `[Executor] PROD CLOSE #${coin} — failed to read cumFunding (${err.message}), fallback to APY estimate`,
    );
  }

  // ── 1. Отправляем ордер на закрытие ──────────
  // По умолчанию сначала мейкером (CLOSE_LIMIT_ENABLED), с добивкой маркетом по
  // дедлайну — см. шапку limitClose.js. Старый путь остаётся под флагом=false.
  let result;
  let limitFill = null;
  try {
    if (config.trading.closeLimitEnabled) {
      limitFill = await closeLimitFirst({ coin, side: posSide });
    } else {
      result = await retryWithBackoff(
        () =>
          closeMarket(coin, undefined, MARKET_SLIPPAGE), // size undefined → закрыть полностью
        { label: `close-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
      );
    }
  } catch (err) {
    if (err.message?.includes("No position found")) {
      logger.error(
        `[Executor] PROD CLOSE #${coin} — no position on exchange! ` +
          `Likely closed via ADL/SL/TP or liquidated. Syncing DB…`,
      );
      return await syncDbAfterExternalClose(position, coin, holdHours);
    }

    logger.error(
      `[Executor] PROD CLOSE #${coin} — order request failed: ${err.message}`,
    );
    await notifyCloseFailed({
      coin,
      error: `Ордер не отправлен (сетевая ошибка):\n<code>${err.message}</code>`,
      positionStillOpen: true,
    });
    return { ok: false };
  }

  // ── 2. Парсим ответ ──────────────────────────
  // limitClose отдаёт уже готовую форму fill'а — парсить нечего.
  const fill = limitFill ?? parseFillResponse(result, "CLOSE");

  if (!fill.ok) {
    logger.error(
      `[Executor] PROD CLOSE #${coin} — exchange rejected: ${fill.error}`,
    );
    // Отказ «позиции уже нет» = наша DB-строка устарела. Сверяемся с биржей и,
    // если same-side позы действительно нет, закрываем строку по реальным fills
    // вместо того чтобы оставить её OPEN со старым entry_price.
    if (isPositionGoneRejection(fill.error)) {
      const alive = await sameSidePositionAlive(position, coin);
      if (alive === false) {
        logger.error(
          `[Executor] PROD CLOSE #${coin} — reduce-only отвергнут и позы на бирже нет ` +
            `(закрыта руками/стопом до нас). Синхронизирую БД по fills…`,
        );
        return await syncDbAfterExternalClose(position, coin, holdHours);
      }
      logger.warn(
        `[Executor] PROD CLOSE #${coin} — reduce-only отвергнут, но поза ` +
          `${alive === null ? 'непроверяема' : 'ещё на месте'} → оставляю integrity разбираться.`,
      );
    }
    await notifyCloseRejected({ coin, error: fill.error });
    return { ok: false };
  }

  return await finishProductionClose({
    signal, position, coin, posSide, closeLabel, holdMs, holdHours,
    realFundingUsd, fill, silent,
  });
}

/**
 * Позиции на бирже нет (ADL/SL/TP/ручное закрытие/reduce-only отказ) — закрываем
 * DB-строку по реальным fills. Выделено из productionClose, чтобы оба пути
 * («No position found» и отказ reduce-only) синхронизировали БД одинаково.
 */
async function syncDbAfterExternalClose(position, coin, holdHours) {
  let estimatedPnl = 0;
  let equity = 0;
  try {
    const summary = await getAccountSummary();
    equity = summary.equity;
    // PnL ≈ equity_now − equity_at_open. Если entry_equity не сохранён
    // (старая позиция) — оставим 0, чтобы не врать.
    const hasEntry = Number.isFinite(position.entry_equity) && position.entry_equity > 0;
    const equityOk = Number.isFinite(equity) && equity > 0;

    // 🚨 Глитч индексатора отдаёт неправдоподобно низкую equity, и оценка PnL
    // улетает в десятки долларов минуса. equity < половины entry_equity — почти
    // всегда глитч: при lev≤1x сделка физически не роняет депо вдвое.
    if (hasEntry && equityOk && equity >= position.entry_equity * 0.5) {
      estimatedPnl = equity - position.entry_equity;
    } else if (hasEntry && equityOk) {
      logger.warn(
        `[Executor] PROD CLOSE #${coin} — equity $${equity.toFixed(2)} implausibly low ` +
          `vs entry_equity $${position.entry_equity.toFixed(2)} (likely API glitch), ` +
          `writing 0 instead of fake negative. Check Reporter alert for real PnL.`,
      );
    } else if (!equityOk) {
      logger.warn(
        `[Executor] PROD CLOSE #${coin} — equity unreadable ($${equity}), ` +
          `est. PnL not computable, writing 0 instead of fake negative.`,
      );
    }
  } catch { /* PnL неизвестен */ }

  // Classify cause via userFills: matched oid → TP/SL trigger;
  // liquidation flag → liquidation; иначе manual_close (оператор закрыл руками
  // через UI до того, как бот успел отправить marketClose).
  const classified = {
    reason: 'external_close_detected_on_exit',
    pnl: null, fee: 0, closePx: null, closedAt: null, feeSource: null,
  };
  try {
    const fills = await fetchUserFills(position.entry_time - 60_000);
    const coinFills = fills.filter((f) => f.coin.toUpperCase() === coin.toUpperCase());
    const c = classifyClose(position, coinFills);
    // Причина закрытия — только из classifyClose: лишь он различает
    // sl_trigger/tp_trigger/liquidation по oid и флагу ликвидации.
    if (c.reason !== 'external_unknown') {
      classified.reason = c.reason;
    }

    // Цифры — из round-trip матчера: он даёт комиссию за ОБЕ ноги и матчит
    // ногу по entry_price (фикс KAITO 13.07), а classifyClose отдаёт fee
    // только закрывающих филлов. Обычный путь закрытия пишет в fee_paid обе
    // ноги (size × (ONE_LEG + exitFeeRate)) — внешний обязан быть с ним
    // согласован, иначе комиссии внешних закрытий систематически занижены,
    // а PnL завышен. Фолбэк на classifyClose, если ногу сматчить не удалось.
    const leg = findRoundTripForPosition(position, coinFills);
    const src = leg && Number.isFinite(leg.pnl) ? leg : c;
    if (Number.isFinite(src.fee)) classified.fee = src.fee;
    if (Number.isFinite(src.pnl)) {
      classified.pnl = src.pnl;
      // Контракт БД: realized_pnl = net (price PnL − комиссии).
      estimatedPnl = src.pnl - classified.fee;
    }
    if (Number.isFinite(src.closePx)) classified.closePx = src.closePx;
    classified.feeSource = src === leg ? 'round_trip' : 'close_fills';
    // Реальное время закрытия из fills. Без него в history попадал момент
    // ДЕТЕКТА (бот замечает внешнее закрытие через десятки секунд), и
    // дедуп ленты (makeHistoryCoverage, допуск 5с) промахивался — одна
    // сделка показывалась дважды: `close` из history + `manual_close` из
    // fills. Кейс kSHIB 26.07: fill 09:40:01, детект 09:40:30.
    if (Number.isFinite(src.closedAt)) classified.closedAt = src.closedAt;
    logger.info(
      `[Executor] PROD CLOSE #${coin} — external classified as '${classified.reason}' | ` +
        `pnl(fills)=${classified.pnl != null ? '$' + classified.pnl.toFixed(4) : 'n/a'} gross, ` +
        `fee=$${classified.fee.toFixed(4)} (${classified.feeSource}) → net $${estimatedPnl.toFixed(4)} | ` +
        `closePx(fills)=${classified.closePx != null ? '$' + classified.closePx : 'n/a'} | ` +
        `closedAt(fills)=${classified.closedAt ? new Date(classified.closedAt).toISOString() : 'n/a'}`,
    );
  } catch (clsErr) {
    logger.debug(`[Executor] classifyClose failed: ${clsErr.message}`);
  }

  try {
    dbClosePosition(position.id, {
      close_price:  classified.closePx ?? 0,
      realized_pnl: estimatedPnl,
      fee_paid:     classified.fee,
      closed_at:    classified.closedAt ?? undefined,
      reason:       classified.reason,
    });
    logger.info(
      `[Executor] ✅ DB synced: #${coin} (id=${position.id}) → CLOSED | ` +
        `reason: ${classified.reason} | est. PnL: $${estimatedPnl.toFixed(4)}`,
    );
  } catch (dbErr) {
    logger.error(`[Executor] DB close failed: ${dbErr.message}`);
  }

  await notifyExternalClose({
    coin, sizeUsd: position.size_usd, entryPrice: position.entry_price,
    holdHours, estimatedPnl, equity,
  });
  return { ok: false };
}

/**
 * Обычный путь: ордер исполнился — PnL, БД, уведомления. Выделено из
 * productionClose при рефакторинге external-close (тело не менялось).
 */
async function finishProductionClose({
  signal, position, coin, posSide, closeLabel, holdMs, holdHours,
  realFundingUsd, fill, silent,
}) {
  // ── 3. Slippage guard ────────────────────────
  const slip = checkSlippage(signal.price, fill.avgPx, closeLabel);

  // Через limit-first путь между решением и fill'ом проходит до CLOSE_LIMIT_WAIT_MS.
  // Разница цен там измеряет движение рынка за время ожидания, а не качество
  // исполнения, и банить монету за неё нельзя — иначе бот сам себе выключит
  // торговлю на первом же быстром движении. Логируем, но не баним.
  const waitedForMaker = fill.kind != null;

  if (slip.ban && waitedForMaker) {
    logger.warn(
      `[Executor] ⚠️ #${coin} цена ушла на ${slip.label} за время ожидания мейкер-выхода ` +
        `(kind=${fill.kind}) — это дрейф рынка, не слиппедж; бан не ставлю`,
    );
  } else if (slip.ban) {
    banSlippage(coin);
    logger.error(
      `[Executor] 🚫 SLIPPAGE BAN #${coin} ${closeLabel}: ${slip.label} (>${1.5}%) — ` +
        `trading paused for ${SLIPPAGE_BAN_TTL_MS / 60_000}min`,
    );
    await notifySlippageBan({
      coin, slipLabel: slip.label,
      banMinutes: SLIPPAGE_BAN_TTL_MS / 60_000,
    });
  } else if (slip.warn) {
    logger.warn(
      `[Executor] ⚠️ SLIPPAGE #${coin} ${closeLabel}: expected $${signal.price} → fill $${fill.avgPx} (${slip.label})`,
    );
  } else {
    logger.debug(`[Executor] Slippage #${coin} ${closeLabel}: ${slip.label}`);
  }

  // ── 3.5. Re-entry cooldown ──────────────────
  setCooldown(coin);
  logger.info(
    `[Executor] ⏳ Re-entry cooldown set: #${coin} → ${REENTRY_COOLDOWN_MS / 60_000}min`,
  );

  // ── 4. Считаем реальный PnL ──────────────────
  // Мейкер-выход платит 0.3 бп вместо 2 бп + слиппедж — если считать его по
  // тейкерской ставке, вся экономия от лимитки исчезнет в учёте.
  const exitFeeRate = fill.kind === 'limit' ? MAKER_FEE_RATE : FEE_RATE;
  const { pricePnl, fundingPnl, totalFee, realizedPnl, fundingSource } =
    calcPnl(position, fill.avgPx, holdHours, realFundingUsd, exitFeeRate);

  // ── 5. Закрываем в БД ────────────────────────
  // MFE/MAE + hold_seconds для разбора выходов няньки.
  let exitFeatures = null;
  if (position.strategy_id === 'adopt') {
    const mm = consumeAdoptMfeMae(position.id);
    const sz = position.size_usd || 0;
    exitFeatures = {
      mfe_pct:      mm.mfePct,
      mae_pct:      mm.maePct,
      mfe_usd:      mm.mfePct != null ? (mm.mfePct / 100) * sz : null,
      mae_usd:      mm.maePct != null ? (mm.maePct / 100) * sz : null,
      hold_seconds: Math.round(holdMs / 1000),
    };
    if (signal.reason === 'adopt_trail_tp' || signal.reason === 'adopt_breakeven_ratchet') {
      exitFeatures.trail_peak_pct      = signal.peakPct ?? getAdoptPeakPct(position.id);
      exitFeatures.trail_give_back_pct = signal.giveBackPct ?? null;
    }
    finalizeAdoptTimeCut(position, fill.avgPx); // shadow time-cut: строка сравнения
    finalizeAdoptShadowTrail(position, fill.avgPx); // shadow trail: 0.25R vs текущий
    clearAdoptShadowTrail(position.id);
    clearAdoptState(position.id);
  }

  dbClosePosition(position.id, {
    close_price:  fill.avgPx,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
    exitFeatures,
  });

  recordBotOid(fill.oid, coin, 'close', position.id);

  const sign = realizedPnl >= 0 ? "+" : "";
  const fSign = fundingPnl >= 0 ? "+" : "";
  logger.info(
    `[Executor] ✅ PROD CLOSE #${coin} | oid: ${fill.oid} | ` +
      `filled: ${fill.totalSz} @ $${fill.avgPx} | slippage: ${slip.label} | ` +
      `pricePnl: ${pricePnl >= 0 ? "+" : ""}$${pricePnl.toFixed(4)} | ` +
      `fundingPnl: ${fSign}$${fundingPnl.toFixed(4)} (${fundingSource}) | fees: $${totalFee.toFixed(4)} | ` +
      `total: ${sign}$${realizedPnl.toFixed(4)} | held: ${holdHours.toFixed(1)}h`,
  );

  // ── 6. Reconciliation (fire-and-forget) ──────
  reconcile(coin, "CLOSE", { expectPosition: false });

  // ── 7. Уведомления + hooks ───────────────────
  if (!silent) {
    await notifyProductionClose({
      coin, holdHours, entryPrice: position.entry_price,
      avgPx: fill.avgPx, slip, pricePnl, fundingPnl,
      totalFee, realizedPnl, reason: signal.reason,
      oid: fill.oid, side: posSide,
    });
  }

  // Circuit breaker: фиксируем убыток
  if (realizedPnl < 0) {
    const tripped = recordLoss(coin, realizedPnl);
    if (tripped) {
      logger.error(
        `[Executor] 🛑 CIRCUIT BREAKER TRIPPED after PROD loss #${coin} ($${realizedPnl.toFixed(4)})`,
      );
      await notifyCircuitBreaker({
        losses: 3,
        pauseMinutes: CB_PAUSE_MS / 60_000,
        lastCoin: coin,
        lastPnl: realizedPnl,
      });
    }
  }

  notify('afterClose', {
    coin, pnl: realizedPnl, holdHours,
    reason: signal.reason, fill, mode: 'PRODUCTION', side: posSide,
  });

  return { ok: true, pnl: realizedPnl, holdHours };
}
