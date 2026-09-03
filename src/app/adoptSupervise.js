// ─────────────────────────────────────────────────
//  Adopt Supervise — сопровождение ВСЕХ adopted-поз (multi-slot)
// ─────────────────────────────────────────────────
// План: plans/adopt-mode-plan.md
//
// Юзер может держать несколько ручных входов одновременно. Бот подхватывает
// каждый (adoptReconcile → reduce-only стоп на бирже + DB-row strategy_id='adopt')
// и здесь, КАЖДЫЙ ТИК, ведёт мягкий выход на каждую позу независимо:
//   • analyzeAdopt(pos, livePrice) — BE-храповик + трейл (per-position state по id)
//   • жёсткий стоп держит биржа (resting SL), здесь не дублируем
//
// Почему отдельно от coordinator: coordinator — single-slot (одна позиция-владелец
// слота). Adopt — multi-slot, поэтому его выходы вынесены сюда и идут циклом по
// getActiveAdoptPositions(). coordinator для adopt теперь возвращает HOLD.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActiveAdoptPositions, updateHunterTriggerOids, updatePositionStop, recordBotOid } from '../core/database.js';
import { analyzeAdopt, getAdoptPeakPct, notePeakPct } from '../modules/strategistAdopt.js';
import { getLivePrice, cancelOrderFor, getPositions } from '../modules/exchange.js';
import { decideTargetTrail, unrealizedR, decideFloorMove } from '../modules/targetTrail.js';
import { candleTruth, clearPeakTruth } from '../modules/adoptPeakTruth.js';
import { setTradeWatch, getTradeExtremes, resetTradeExtremes } from '../core/priceFeed.js';
import { execute } from '../modules/executor/index.js';
import { trackAdoptTimeCutTick } from '../modules/adoptShadowTimeCut.js';
import { trackAdoptShadowTrailTick } from '../modules/adoptShadowTrail.js';
import { fireAdoptNtfy } from './adoptReconcile.js';
import { placeExitTrigger } from '../modules/executor/triggers.js';
import { resolveAsset } from '../modules/executor/fill-parser.js';

// Пик-алерт: систематизация дискрец-выхода (оператор закрывает 63% adopt-поз рукой,
// capture 68% MFE) — звонок в момент решения вместо оракула. Условие: пик ≥
// ADOPT_PEAK_ALERT_MFE_PCT и откат ≥ ADOPT_PEAK_ALERT_GIVEBACK_PCT от пика (строго
// раньше трейла с его 30%). Один раз на позицию — иначе спам на болтанке у пика.
const _peakAlerted = new Set(); // position.id

// Чистое (для теста) условие пик-алерта.
export function shouldFirePeakAlert({ peakPct, unrealizedPct, alreadyFired }) {
  const t = config.trading;
  if (!t.adoptPeakAlertEnabled || alreadyFired) return false;
  if (peakPct < t.adoptPeakAlertMfePct) return false;
  if (unrealizedPct <= 0) return false; // ушли в минус — это уже история про BE/стоп
  return peakPct - unrealizedPct >= peakPct * (t.adoptPeakAlertGiveBackPct / 100);
}

async function maybeFirePeakAlert(pos, price) {
  const peak = getAdoptPeakPct(pos.id);
  const isShort = (pos.side || 'short') === 'short';
  const unrealized = isShort
    ? ((pos.entry_price - price) / pos.entry_price) * 100
    : ((price - pos.entry_price) / pos.entry_price) * 100;
  if (!shouldFirePeakAlert({ peakPct: peak, unrealizedPct: unrealized, alreadyFired: _peakAlerted.has(pos.id) })) return;

  _peakAlerted.add(pos.id);
  const retracePct = ((peak - unrealized) / peak) * 100;
  await fireAdoptNtfy(
    `Пик пройден? #${pos.coin} ${pos.side.toUpperCase()} +${unrealized.toFixed(2)}%`,
    `Пик был +${peak.toFixed(2)}%, откат ${retracePct.toFixed(0)}% от пика.\n` +
    `Решай: забрать у пика рукой или дать трейлу (закроет при −${config.trading.adoptTrailGiveBackPct}% отката).`,
    ['bell'],
  );
  logger.info(`[Adopt] 🔔 peak-alert #${pos.coin}: peak +${peak.toFixed(2)}% → +${unrealized.toFixed(2)}% (retrace ${retracePct.toFixed(0)}%)`);
}

/**
 * Один проход сопровождения по всем активным adopt-позам.
 * Закрывает те, по которым analyzeAdopt вернул CLOSE (трейл / BE-храповик).
 * Best-effort: ошибка по одной монете не валит остальные.
 *
 * @param {Function} [priceFn=getLivePrice] — источник цены. Быстрая WS-петля
 *   (wsExitTick) передаёт сюда чистый WS-ридер: на 2-секундном цикле HTTP-
 *   фолбэк не нужен и вреден (лишний вес → затор бюджета).
 * @returns {Promise<number>} число закрытых этим проходом поз
 */
// Позиции, у которых лимитка уже снята и работает трейл. In-memory: после
// рестарта позиция считается невзведённой, но её лимитки на бирже уже нет —
// поэтому трейл просто взведётся заново на следующем тике (peak восстановится
// из adoptTrailStore), а не оставит позу без выхода.
const _targetTrailArmed = new Set();

// Позиции, по которым свечной пик уже спрашивали хоть раз — только чтобы
// снять троттл в adoptPeakTruth, когда позиция закрылась (иначе его карта
// копит id закрытых поз, а несмываемая Map — ровно тот механизм, которым
// 09.08 выбило кучу V8, см. шапку candleCache.js).
const _peakSynced = new Set();

// Насколько старым может быть закрытие бара, на котором принимается решение о
// выходе по трейлу. Два бара: один текущий (ещё идёт) плюс один запас на лаг
// candleSnapshot. Дальше — источник считается протухшим.
const TRAIL_CLOSE_MAX_AGE_MS = 3 * 60_000;

/** Взведён ли target-trail для позиции — нужно дашборду для Floor-чипа. */
export function isTargetTrailArmed(positionId) {
  return _targetTrailArmed.has(positionId);
}

/**
 * Переставить биржевой стоп за пиком. Возвращает true, если двигали.
 *
 * ПОРЯДОК ВАЖЕН: сначала ставим НОВЫЙ стоп, потом снимаем старый. В окне между
 * ними на бирже два reduce-only стопа — это безопасно (сработает один, второй
 * закроет уже нулевую позу и станет пустышкой). Обратный порядок оставил бы
 * позицию без пола на время сетевого запроса, а это единственный момент, когда
 * она вообще может остаться без защиты.
 *
 * Размер берём С БИРЖИ, а не из БД: после частичного исполнения цели позиция
 * меньше записанной, и стоп на старый размер — это тот самый дрейф зеркала.
 */
async function maybeMoveFloor(pos, peakR) {
  const isShort = (pos.side || 'short') === 'short';
  const d = decideFloorMove({
    entry: pos.entry_price,
    stopPrice: pos.sl_price,
    initialStopPrice: pos.initial_sl_price ?? pos.sl_price,
    isShort,
    peakR,
    giveBackR: config.trading.adoptTargetTrailGiveBackR,
    minStepPct: config.trading.adoptTrailFloorStepPct,
  });
  if (!d.move) return false;

  try {
    const positions = await getPositions();
    const found = (positions || []).find(
      (x) => String(x?.position?.coin || '').toUpperCase() === String(pos.coin).toUpperCase(),
    );
    const sz = Math.abs(parseFloat(found?.position?.szi ?? '0'));
    if (!(sz > 0)) return false; // позы на бирже нет — двигать нечего

    const { szDecimals } = resolveAsset(pos.coin);
    const newOid = await placeExitTrigger(pos.coin, sz, d.px, 'sl', szDecimals, pos.side || 'short');
    const oldOid = pos.hunter_sl_oid;
    if (oldOid) {
      try { await cancelOrderFor(pos.coin, oldOid); } catch (err) {
        logger.warn(`[Adopt] старый стоп #${pos.coin} oid=${oldOid} не снялся: ${err.message}`);
      }
    }
    recordBotOid(newOid, pos.coin, 'sl_trigger', pos.id);
    updateHunterTriggerOids(pos.id, { hunter_sl_oid: newOid, hunter_tp_oid: pos.hunter_tp_oid });
    updatePositionStop(pos.id, d.px);
    pos.sl_price = d.px;
    pos.hunter_sl_oid = newOid;
    logger.info(
      `[Adopt] 🪜 ПОЛ #${pos.coin} поднят ${d.fromR.toFixed(2)}R → ${d.toR.toFixed(2)}R ` +
      `@ $${d.px.toPrecision(6)} (пик ${peakR.toFixed(2)}R) | oid=${newOid}`,
    );
    return true;
  } catch (err) {
    logger.warn(`[Adopt] перестановка пола #${pos.coin} failed: ${err.message}`);
    return false;
  }
}

export async function superviseAdoptPositions(priceFn = getLivePrice) {
  if (!config.isProduction) return 0;
  const positions = getActiveAdoptPositions();
  // Прополка peak-alert метки: позиция закрылась → id из Set (иначе копит мусор).
  const activeIds = new Set(positions.map((p) => p.id));
  for (const id of [..._peakAlerted]) if (!activeIds.has(id)) _peakAlerted.delete(id);
  for (const id of [..._targetTrailArmed]) if (!activeIds.has(id)) _targetTrailArmed.delete(id);
  for (const id of [..._peakSynced]) if (!activeIds.has(id)) { _peakSynced.delete(id); clearPeakTruth(id); }
  // Поток сделок по монетам под нянькой: точный пик без единого запроса к API.
  // setTradeWatch идемпотентен и сам отписывается от ушедших монет.
  try { setTradeWatch(positions.map((p) => p.coin)); } catch (err) {
    logger.debug(`[Adopt] setTradeWatch failed: ${err.message}`);
  }
  if (positions.length === 0) return 0;

  let closed = 0;
  for (const pos of positions) {
    let price = null;
    try {
      price = await priceFn(pos.coin); // default: WS-first, HTTP fallback
    } catch (err) {
      logger.debug(`[Adopt] supervise getLivePrice #${pos.coin} failed: ${err.message}`);
    }
    if (!Number.isFinite(price) || price <= 0) continue; // нет цены → ждём след. тик

    // ── Пик по свечам биржи, до всех решений ──────────────────────────────
    // Тиковый пик считается по allMids (~22 кадра/мин) и пропускает проколы:
    // 03.09 из-за этого не взвёлся target-trail на HEMI, хотя ход был 1.25R.
    // Свеча рисуется по сделкам и такие фитили видит. Берём МАКСИМУМ двух
    // источников (см. notePeakPct), сеть трогаем не чаще раза в 30с на позу.
    // Стоит ДО analyzeAdopt: на пике завязан и BE-храповик, не только трейл.
    // ── Пик по СДЕЛКАМ: мгновенно, без запросов ───────────────────────────
    // Сделки приходят по WS в реальном времени, поэтому касание уровня видно
    // сразу, а не через полминуты, как со свечами. Именно этой секунды не
    // хватило трейлу на ARB 03.09: он взвёлся ПОСЛЕ того, как лимитка забрала
    // позу. Экстремумы копятся с момента подписки; всё, что было до неё,
    // закрывают свечи ниже — оба источника вливаются одним max'ом.
    // Первый осмотр позиции: чистим экстремумы монеты. Подписка живёт по МОНЕТЕ,
    // а позиции по ней сменяют друг друга — без сброса новая поза унаследовала бы
    // пик предыдущей и взвела трейл на чужом движении.
    if (!_peakSynced.has(pos.id)) {
      try { resetTradeExtremes(pos.coin); } catch { /* noop */ }
    }
    try {
      const ext = getTradeExtremes(pos.coin);
      if (ext) {
        const isShort = (pos.side || 'short') === 'short';
        const px = isShort ? ext.lo : ext.hi;
        const pct = ((isShort ? pos.entry_price - px : px - pos.entry_price) / pos.entry_price) * 100;
        if (pct > 0) notePeakPct(pos.id, pct, { persist: pos.mode === 'PRODUCTION' });
      }
    } catch (err) {
      logger.debug(`[Adopt] trade peak #${pos.coin} failed: ${err.message}`);
    }

    let truth = null;
    try {
      truth = await candleTruth(pos);
      _peakSynced.add(pos.id);
      const cPeak = truth?.peakPct;
      if (cPeak != null && notePeakPct(pos.id, cPeak, { persist: pos.mode === 'PRODUCTION' })) {
        logger.debug(`[Adopt] пик #${pos.coin} поднят свечами до ${cPeak.toFixed(2)}%`);
      }
    } catch (err) {
      logger.debug(`[Adopt] candle truth #${pos.coin} failed: ${err.message}`);
    }

    const sig = analyzeAdopt(pos, price);
    // Shadow time-cut: measurement-only, реальный выход не трогает. После
    // analyzeAdopt — peak в strategistAdopt уже обновлён этим тиком.
    try { trackAdoptTimeCutTick(pos, price); } catch (err) {
      logger.debug(`[Adopt] shadow time-cut tick #${pos.coin} failed: ${err.message}`);
    }
    // Shadow trail (гипотеза adopt-trail-025r): считает 0.25R-модель и симуляцию
    // текущего трейла на ОДНОМ потоке цен. Тоже measurement-only.
    try { trackAdoptShadowTrailTick(pos, price); } catch (err) {
      logger.debug(`[Adopt] shadow trail tick #${pos.coin} failed: ${err.message}`);
    }
    // ── Target-trail: на подходе к цели снять лимитку и вести стоп за ценой ──
    // ⚠️ Выключено по умолчанию (ADOPT_TARGET_TRAIL_ENABLED). Замер дал
    // +0.154R против фиксации при CI95 [−0.033, +0.378] — знак не установлен,
    // медиана против. Гипотеза adopt-target-trail, судить один раз на n=60.
    // Гарда «только позы, рождённые при этом процессе» СНЯТА 03.09.2026. Она
    // стояла потому, что пик жил только в памяти и после рестарта был неизвестен
    // — взводиться «задним числом» на неизвестном пике означало снять лимитку и,
    // возможно, тут же выйти по рынку. Теперь пик восстанавливается из свечей за
    // первый же тик (см. adoptPeakTruth), то есть после рестарта он ИЗВЕСТЕН и
    // не хуже, чем был. Обоснования у гарды не осталось, а цена её была высокой:
    // каждый деплой выключал правило до конца текущей позиции.
    if (config.trading.adoptTargetTrailEnabled && pos.sl_price > 0) {
      try {
        const isShort = (pos.side || 'short') === 'short';
        // Пик меряем по фитилям (честный MFE), а ОТКАТ — по закрытию последнего
        // минутного бара. Причина: give-back 0.25R меньше внутриминутного
        // размаха неликвида (HEMI 03.09: пик прыгнул с 0.82R до 2.19R одним
        // движением), и на тиковой цене трейл закрывался бы по откату от цены,
        // которую видел один принт. Закрытие бара пережило минуту торговли.
        // Бар протух (нет сети дольше двух минут) → падаем на тик: выйти
        // по чуть худшей цене лучше, чем не выйти вовсе.
        // Эталон 1R — стоп НА ВХОДЕ. Пол едет, и мерить R от него нельзя:
        // после первой перестановки порог взвода и отдача считались бы в
        // разных единицах (см. decideFloorMove).
        const refStop = pos.initial_sl_price ?? pos.sl_price;
        const stopDistPct = (Math.abs(pos.entry_price - refStop) / pos.entry_price) * 100;
        const closeAge = truth?.close ? Date.now() - truth.close.time : Infinity;
        const decisionPx = closeAge <= TRAIL_CLOSE_MAX_AGE_MS ? truth.close.px : price;
        const curR = unrealizedR({ entry: pos.entry_price, price: decisionPx, stopPrice: refStop, isShort });
        const peakR = stopDistPct > 0 ? (getAdoptPeakPct(pos.id) ?? 0) / stopDistPct : null;
        const d = decideTargetTrail({
          currentR: curR,
          peakR,
          armed: _targetTrailArmed.has(pos.id),
          armR: config.trading.adoptTargetTrailArmR,
          giveBackR: config.trading.adoptTargetTrailGiveBackR,
        });

        if (d.action === 'ARM') {
          // Снимаем цель ДО того, как пометить позицию взведённой: если отмена
          // не прошла, лимитка остаётся на бирже и сделка закроется как раньше —
          // это безопасный исход. Обратный порядок оставил бы позу без цели.
          // Ступени TP-сетки при этом НЕ снимаем, и это намеренно: они ближе к
          // рынку, чем цель, и забирают свою часть мейкером, пока трейл ведёт
          // остаток. Ровно та связка «часть лимитками, хвост трейлом», ради
          // которой сетка и заводилась.
          if (pos.hunter_tp_oid) await cancelOrderFor(pos.coin, pos.hunter_tp_oid);
          _targetTrailArmed.add(pos.id);
          logger.info(`[Adopt] 🎯 TARGET-TRAIL ARM #${pos.coin}: ${d.reason}`);
        } else if (d.action === 'CLOSE' && !config.trading.adoptTrailFloorOrder) {
          logger.info(`[Adopt] 🎯 TARGET-TRAIL CLOSE #${pos.coin}: ${d.reason}`);
          await execute({ action: 'CLOSE', reason: 'adopt_target_trail', strategy_id: 'adopt' }, pos);
          _targetTrailArmed.delete(pos.id);
          closed++;
          continue;
        }

        // ── Пол ордером: бот не закрывает, а двигает стоп за пиком ──────────
        // Закрытие остаётся за биржей. Это и делает «locked» честным: уровень
        // становится ордером, который исполнится, даже если бот лежит, а не
        // числом, которое некому проверить между тиками (см. decideFloorMove).
        if (config.trading.adoptTrailFloorOrder && _targetTrailArmed.has(pos.id)) {
          await maybeMoveFloor(pos, peakR);
        }
      } catch (err) {
        logger.warn(`[Adopt] target-trail #${pos.coin} failed: ${err.message}`);
      }
    }

    if (sig.action === 'HOLD') {
      // Пик-алерт (best-effort): звонок оператору у пика, пока трейл ещё не сработал.
      try { await maybeFirePeakAlert(pos, price); } catch (err) {
        logger.debug(`[Adopt] peak-alert #${pos.coin} failed: ${err.message}`);
      }
      continue;
    }

    try {
      await execute({ ...sig, strategy_id: 'adopt' }, pos);
      closed++;
    } catch (err) {
      logger.error(`[Adopt] supervise execute #${pos.coin} failed: ${err.message}`);
    }
  }
  return closed;
}
