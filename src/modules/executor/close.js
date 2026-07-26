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
import { fetchUserFills, classifyClose, findRoundTripForPosition } from '../userFills.js';
import { calcPnl, checkSlippage, MARKET_SLIPPAGE } from './math.js';
import {
  banSlippage, setCooldown, recordLoss,
  SLIPPAGE_BAN_TTL_MS, REENTRY_COOLDOWN_MS, CB_PAUSE_MS,
} from './state.js';
import { reconcile } from './reconciler.js';
import { notify } from './hooks.js';
import {
  consumeHunterMfeMae, clearHunterTrailState, getHunterPeakPct, recordHunterSlExternal,
} from '../strategistHunter.js';
import {
  consumeHunterLongMfeMae, clearHunterLongTrailState, getHunterLongPeakPct,
  recordHunterLongLossEvent,
} from '../strategistHunterLong.js';
import { setHunterCrossCooldown } from '../hunterCrossCooldown.js';
import { clearAdoptState, getAdoptPeakPct, consumeAdoptMfeMae } from '../strategistAdopt.js';
import { finalizeAdoptTimeCut } from '../adoptShadowTimeCut.js';
import {
  notifySlippageBan,
  notifyProductionClose, notifyCloseRejected, notifyCloseFailed,
  notifyExternalClose,
  notifyCircuitBreaker,
  notifyHunterTrailTp, notifyHunterLongTrailTp,
} from './notifications.js';

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
  let result;
  try {
    result = await retryWithBackoff(
      () =>
        closeMarket(coin, undefined, MARKET_SLIPPAGE), // size undefined → закрыть полностью
      { label: `close-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    if (err.message?.includes("No position found")) {
      logger.error(
        `[Executor] PROD CLOSE #${coin} — no position on exchange! ` +
          `Likely closed via ADL/SL/TP or liquidated. Syncing DB…`,
      );

      let estimatedPnl = 0;
      let equity = 0;
      try {
        const summary = await getAccountSummary();
        equity = summary.equity;
        // PnL ≈ equity_now − equity_at_open. Если entry_equity не сохранён
        // (старая позиция) — оставим 0, чтобы не врать.
        const hasEntry = Number.isFinite(position.entry_equity) && position.entry_equity > 0;
        const equityOk = Number.isFinite(equity) && equity > 0;

        // Guard: API/indexer-glitch может вернуть implausibly low equity
        // (был кейс TON id=61 2026-05-12: TP реально дал +$0.80, а equity
        // на момент reconcile показала $0.5x → estPnl получился −$24.48).
        // Если equity < половины entry_equity — это почти всегда glitch,
        // настоящий трейд физически не мог уронить equity на 50%+ при lev≤1x.
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
      let classified = {
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
        if (position.strategy_id === 'hunter' || position.strategy_id === 'hunter_long') {
          setHunterCrossCooldown(position.coin);
        }
        // Fix C (2026-05-20): external close на hunter_long почти всегда = убыток
        // (delist/halt/liquidation/user manual close). Ставим post-SL cooldown +
        // инкрементим SL-streak, чтобы не войти повторно в ту же токсичную монету.
        // Исключение: если classifier явно вернул tp_trigger → не пенализуем.
        if (
          position.strategy_id === 'hunter_long' &&
          !['tp_trigger', 'hunter_long_tp', 'hunter_long_trail_tp'].includes(classified.reason)
        ) {
          recordHunterLongLossEvent(position.coin);
        }
        // Симметрия Fix C для SHORT (2026-06-12): external close на hunter SHORT —
        // тоже почти всегда убыток (ликвидация / ручное закрытие оператором). Раньше
        // шорт получал только cross-cooldown (60мин), без post-SL cooldown, поэтому
        // бот мог перезашортить ту же монету через ~час (кейс HMSTR #142→#147).
        // Ставим post-SL cooldown, кроме явного TP.
        if (
          position.strategy_id === 'hunter' &&
          !['tp_trigger', 'hunter_tp'].includes(classified.reason)
        ) {
          recordHunterSlExternal(position.coin);
        }
      } catch (dbErr) {
        logger.error(`[Executor] DB close failed: ${dbErr.message}`);
      }

      await notifyExternalClose({
        coin, sizeUsd: position.size_usd, entryPrice: position.entry_price,
        holdHours, estimatedPnl, equity,
      });
      return { ok: false };
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
  const fill = parseFillResponse(result, "CLOSE");

  if (!fill.ok) {
    logger.error(
      `[Executor] PROD CLOSE #${coin} — exchange rejected: ${fill.error}`,
    );
    await notifyCloseRejected({ coin, error: fill.error });
    return { ok: false };
  }

  // ── 3. Slippage guard ────────────────────────
  const slip = checkSlippage(signal.price, fill.avgPx, closeLabel);

  if (slip.ban) {
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
  const { pricePnl, fundingPnl, totalFee, realizedPnl, fundingSource } =
    calcPnl(position, fill.avgPx, holdHours, realFundingUsd);

  // ── 5. Закрываем в БД ────────────────────────
  // Hunter: подмешиваем MFE/MAE из tick-трекера + hold_seconds.
  let exitFeatures = null;
  if (position.strategy_id === 'hunter') {
    const mm = consumeHunterMfeMae(position.id);
    exitFeatures = {
      mfe_usd:      mm?.mfeUsd ?? null,
      mae_usd:      mm?.maeUsd ?? null,
      mfe_pct:      mm?.mfePct ?? null,
      mae_pct:      mm?.maePct ?? null,
      hold_seconds: Math.round(holdMs / 1000),
    };
    if (signal.reason === 'hunter_trail_tp') {
      exitFeatures.trail_peak_pct      = signal.peakPct ?? getHunterPeakPct(position.id);
      exitFeatures.trail_give_back_pct = signal.giveBackPct ?? null;
    }
    clearHunterTrailState(position.id);
  } else if (position.strategy_id === 'hunter_long') {
    const mm = consumeHunterLongMfeMae(position.id);
    exitFeatures = {
      mfe_usd:      mm?.mfeUsd ?? null,
      mae_usd:      mm?.maeUsd ?? null,
      mfe_pct:      mm?.mfePct ?? null,
      mae_pct:      mm?.maePct ?? null,
      hold_seconds: Math.round(holdMs / 1000),
    };
    if (signal.reason === 'hunter_long_trail_tp') {
      exitFeatures.trail_peak_pct      = signal.peakPct ?? getHunterLongPeakPct(position.id);
      exitFeatures.trail_give_back_pct = signal.giveBackPct ?? null;
    }
    clearHunterLongTrailState(position.id);
  } else if (position.strategy_id === 'adopt') {
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
    clearAdoptState(position.id);
  }

  dbClosePosition(position.id, {
    close_price:  fill.avgPx,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
    exitFeatures,
  });

  if (position.strategy_id === 'hunter' || position.strategy_id === 'hunter_long') {
    setHunterCrossCooldown(position.coin);
  }

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

  // ── 7. Telegram + hooks ──────────────────────
  if (!silent) {
    if (position.strategy_id === 'hunter' && signal.reason === 'hunter_trail_tp') {
      await notifyHunterTrailTp({
        coin,
        entryPrice:   position.entry_price,
        closePrice:   fill.avgPx,
        peakPct:      signal.peakPct ?? exitFeatures?.trail_peak_pct ?? 0,
        giveBackPct:  signal.giveBackPct ?? exitFeatures?.trail_give_back_pct ?? 0,
        pnl:          realizedPnl,
        fee:          totalFee,
        holdMinutes:  Math.round(holdHours * 60),
        fixedTpPrice: position.tp_price,
      });
    } else if (position.strategy_id === 'hunter_long' && signal.reason === 'hunter_long_trail_tp') {
      await notifyHunterLongTrailTp({
        coin,
        entryPrice:   position.entry_price,
        closePrice:   fill.avgPx,
        peakPct:      signal.peakPct ?? exitFeatures?.trail_peak_pct ?? 0,
        giveBackPct:  signal.giveBackPct ?? exitFeatures?.trail_give_back_pct ?? 0,
        pnl:          realizedPnl,
        fee:          totalFee,
        holdMinutes:  Math.round(holdHours * 60),
        fixedTpPrice: position.tp_price,
      });
    } else {
      await notifyProductionClose({
        coin, holdHours, entryPrice: position.entry_price,
        avgPx: fill.avgPx, slip, pricePnl, fundingPnl,
        totalFee, realizedPnl, reason: signal.reason,
        oid: fill.oid, side: posSide,
      });
    }
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
