// ─────────────────────────────────────────────────
//  «Бумажный adopt» — бот ведёт ВЫХОД бумажных поз под нянькой
// ─────────────────────────────────────────────────
// Ведёт выход двух бумажных стратегий (PAPER_NANNY_STRATEGIES): 'manual_paper'
// (вход рукой) и 'tg_signal' (вход по чужому прогнозу). Механика одна — иначе
// потоки были бы несравнимы. Повторяет ордера реального adopt: жёсткий стоп,
// цель лимиткой, ступени TP-сетки, BE-храповик и трейл (analyzeAdopt).
//
// Порядок осмотра: сначала стоп, потом цель. Внутри интервала настоящий порядок
// неизвестен, и берётся худший — иначе бумага рисовала бы лучше биржи.
//
// 🚨 Ступени сетки живут в ПАМЯТИ: при рестарте частично забранная поза
// досчитается как нетронутая. Терпимо, пока сетка выключена по умолчанию.
//
// Гейт: MANUAL_PAPER_ADOPT_ENABLED. Тихо, без ntfy.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperNannyPositions, closePosition } from '../core/database.js';
import { getLivePrice } from '../modules/exchange.js';
import { analyzeAdopt, clearAdoptState, consumeAdoptMfeMae } from '../modules/strategistAdopt.js';
import { planPaperExit } from '../modules/paperEntry.js';
import { calcPnl, FEE_RATE, MAKER_FEE_RATE } from '../modules/executor/math.js';

/** id позы → уже забранные ступени сетки. Живёт до рестарта (см. шапку). */
const partialLegs = new Map();

/** Достигнута ли цена уровня по ходу позиции. */
function reached(side, price, level) {
  if (!Number.isFinite(level) || level <= 0) return false;
  return side === 'short' ? price <= level : price >= level;
}

/** Пробит ли уровень против позиции (жёсткий стоп). */
function breached(side, price, level) {
  if (!Number.isFinite(level) || level <= 0) return false;
  return side === 'short' ? price >= level : price <= level;
}

/** Ступени от ЗАПИСАННОГО стопа: пересчёт по свежему ATR сдвинул бы их под
 *  уже открытой позой. */
function rungsFor(pos) {
  if (!Number.isFinite(pos.initial_sl_price) || !(pos.initial_sl_price > 0)) return [];
  const stopDistPct = Math.abs((pos.initial_sl_price - pos.entry_price) / pos.entry_price) * 100;
  if (!(stopDistPct > 0)) return [];
  return planPaperExit({
    side: pos.side || 'long',
    entry: pos.entry_price,
    stopDistPct,
    sizeUsd: pos.size_usd,
  }).rungs;
}

/** Частичный мейкерский филл. В память, а не в БД: строка позиции живёт целиком
 *  до закрытия, PnL ступеней доедет в закладку. */
function takeRung(pos, rung) {
  const legs = partialLegs.get(pos.id) || [];
  const { realizedPnl } = calcPnl(
    { ...pos, size_usd: rung.usd },
    rung.px,
    (Date.now() - pos.entry_time) / 3_600_000,
    0,
    MAKER_FEE_RATE,
  );
  legs.push({ r: rung.r, usd: rung.usd, px: rung.px, pnl: realizedPnl });
  partialLegs.set(pos.id, legs);
  logger.info(
    `[PaperNanny] 🪜 ступень #${pos.coin} ${rung.r}R @ ${rung.px.toPrecision(6)} ` +
      `× $${rung.usd.toFixed(2)} → ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(4)}`,
  );
}

/**
 * Итог позы из ступеней и остатка — чистая функция, отсюда же тесты.
 * Комиссия входа берётся с каждого куска по доле, поэтому сумма равна комиссии
 * со всего нотионала: двойного счёта нет.
 *
 * @param {Object} p
 * @param {object} p.pos — строка позиции
 * @param {Array<{usd:number, pnl:number}>} p.legs — забранные ступени
 * @param {number} p.fillPrice — цена закрытия остатка
 * @param {number} p.holdHours
 * @param {number} p.exitFeeRate — ставка выхода остатка (maker для лимитки)
 * @returns {{realizedPnl:number, totalFee:number, remaining:number}}
 */
export function blendPaperResult({ pos, legs = [], fillPrice, holdHours, exitFeeRate = FEE_RATE }) {
  const takenUsd = legs.reduce((s, l) => s + l.usd, 0);
  const remaining = Math.max(0, pos.size_usd - takenUsd);
  const tail = calcPnl({ ...pos, size_usd: remaining }, fillPrice, holdHours, 0, exitFeeRate);
  const legPnl = legs.reduce((s, l) => s + l.pnl, 0);
  const legFee = legs.reduce((s, l) => s + l.usd * (FEE_RATE + MAKER_FEE_RATE), 0);
  return {
    realizedPnl: tail.realizedPnl + legPnl,
    totalFee: tail.totalFee + legFee,
    remaining,
  };
}

/** Закрывает бумажную позу по fillPrice, пишет в history, чистит state. */
function closePaper(pos, fillPrice, reason, exitFeeRate = FEE_RATE) {
  const now = Date.now();
  const holdHours = (now - pos.entry_time) / 3_600_000;
  const legs = partialLegs.get(pos.id) || [];
  const { realizedPnl, totalFee } = blendPaperResult({ pos, legs, fillPrice, holdHours, exitFeeRate });

  const { mfePct, maePct } = consumeAdoptMfeMae(pos.id);
  closePosition(pos.id, {
    close_price: fillPrice,
    realized_pnl: realizedPnl,
    fee_paid: totalFee,
    reason,
    closed_at: now,
    exitFeatures: {
      hold_seconds: Math.round((now - pos.entry_time) / 1000),
      mfe_pct: mfePct,
      mae_pct: maePct,
    },
  });
  clearAdoptState(pos.id);
  partialLegs.delete(pos.id);
  logger.info(
    `[PaperNanny] CLOSE #${pos.coin} ${(pos.side || 'long').toUpperCase()} @ ${fillPrice} ` +
      `→ ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(4)} ` +
      `(${reason}${legs.length ? `, ${legs.length} ступ.` : ''})`,
  );
}

/**
 * Один проход сопровождения по всем открытым бумажным позам под нянькой.
 * Best-effort: ошибка по одной монете не валит остальные.
 * @param {(coin:string)=>Promise<number>} [priceFn] — инжектится в тестах
 * @returns {Promise<number>} число закрытых этим проходом поз
 */
export async function superviseManualPaperPositions(priceFn = getLivePrice) {
  if (!config.trading.manualPaperAdoptEnabled) return 0;
  const positions = getActivePaperNannyPositions();
  if (positions.length === 0) return 0;

  let closed = 0;
  for (const pos of positions) {
    const side = pos.side || 'long';
    let price = null;
    try {
      price = await priceFn(pos.coin); // WS-first, HTTP fallback
    } catch (err) {
      logger.debug(`[PaperNanny] getLivePrice #${pos.coin} failed: ${err.message}`);
    }
    if (!Number.isFinite(price) || price <= 0) continue;

    try {
      // 1. Жёсткий стоп — исполняем по цене стопа, как resting-SL биржи, тейкером.
      if (breached(side, price, pos.sl_price)) {
        closePaper(pos, pos.sl_price, 'paper_sl');
        closed++;
        continue;
      }

      // 2. Ступени сетки — reduce-only лимитки, мейкерский филл по цене ступени.
      const done = partialLegs.get(pos.id) || [];
      for (const rung of rungsFor(pos)) {
        if (done.some((l) => l.r === rung.r)) continue;
        if (reached(side, price, rung.px)) takeRung(pos, rung);
      }

      // 3. Цель — тоже лимитка: филл по цене цели и по мейкерской ставке.
      if (reached(side, price, pos.tp_price)) {
        closePaper(pos, pos.tp_price, 'paper_tp', MAKER_FEE_RATE);
        closed++;
        continue;
      }

      // 4. Мягкий выход (BE-храповик / трейл) — тот же код, что у реального adopt.
      const sig = analyzeAdopt(pos, price);
      if (sig.action === 'CLOSE') {
        closePaper(pos, sig.price, (sig.reason || 'paper_exit').replace(/^adopt/, 'paper'));
        closed++;
      }
    } catch (err) {
      logger.error(`[PaperNanny] supervise #${pos.coin} failed: ${err.message}`);
    }
  }
  return closed;
}

/** Забранные ступени позы — для витрины и тестов. */
export function getPaperLegs(positionId) {
  return partialLegs.get(positionId) || [];
}

/** Сброс памяти ступеней — нужен тестам. */
export function resetPaperLegs() {
  partialLegs.clear();
}
