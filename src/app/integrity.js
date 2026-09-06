// ─────────────────────────────────────────────────
//  Integrity Check — детектор внешнего закрытия позиций
// ─────────────────────────────────────────────────
// Каждые 60с проверяет: если в БД есть OPEN-позиция, но на бирже
// по этому тикеру позиция отсутствует, значит она была закрыта
// внешне (ADL, ликвидация, ручное действие).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition, getActiveAdoptPositions, closePosition as dbClosePosition } from '../core/database.js';
import { getPositionsCached, getAccountSummary, cancelOrderFor, getFrontendOpenOrders } from '../modules/exchange.js';
import { fireNtfy } from '../core/ntfy.js';
import { note } from '../core/healthRegistry.js';
import { fetchExchangePositions } from '../modules/sync.js';
import { fetchUserFills, classifyClose, findRoundTripForPosition } from '../modules/userFills.js';
import { maybeAdoptManualPosition, reconcileProvisionalAdoptEntries, resolveManualOpenTime } from './adoptReconcile.js';
import { clearAdoptState, consumeAdoptMfeMae } from '../modules/strategistAdopt.js';
import { finalizeAdoptTimeCut } from '../modules/adoptShadowTimeCut.js';
import { finalizeAdoptShadowTrail, clearAdoptShadowTrail } from '../modules/adoptShadowTrail.js';
import {
  state,
  INTEGRITY_CHECK_INTERVAL_MS,
  INTEGRITY_GRACE_PERIOD_MS,
  INTEGRITY_VANISH_DEFER_MS,
} from './state.js';

/**
 * Утилита для надёжного сравнения тикеров.
 * Игнорирует регистр и суффиксы типа -PERP.
 */
function isSameCoin(apiCoin, targetCoin) {
  if (!apiCoin || !targetCoin) return false;
  const a = apiCoin.toLowerCase();
  const t = targetCoin.toLowerCase();
  return a === t || a === `${t}-perp` || a === `@${t}` || a.replace("-perp", "") === t;
}

/**
 * Жива ли НА БИРЖЕ позиция той же монеты И ТОЙ ЖЕ СТОРОНЫ, что DB-поза.
 * false → поза либо исчезла, либо флипнулась (на бирже противоположная сторона) →
 * наша DB-поза фактически закрыта. 🚨 Сверять сторону обязательно: без этого
 * флип short→long не детектится.
 * @returns {boolean}
 */
export function liveMatchesPosition(dbPosition, exchangePositions) {
  const dbSide = (dbPosition?.side || 'short').toLowerCase();
  return (exchangePositions || []).some((ap) => {
    const pos = ap?.position ?? ap;
    const szi = parseFloat(pos?.szi ?? '0');
    if (!isSameCoin(pos?.coin, dbPosition?.coin) || szi === 0) return false;
    return (szi < 0 ? 'short' : 'long') === dbSide;
  });
}

/**
 * Порог расхождения цены входа, после которого DB-строка и биржевая поза
 * считаются РАЗНЫМИ позициями (0.2% — выше любого округления/усреднения).
 */
const ENTRY_DRIFT_TOL = 0.002;

/**
 * Чистое решение «та же поза / скейл-ин / перезаход» (см. isReopenedPosition).
 * Выделено, чтобы тестировать без похода в fills.
 *
 * @param {object} a
 * @param {number} a.dbEntryPrice — entry_price DB-строки
 * @param {number} a.exEntryPx    — entryPx позы на бирже
 * @param {number} a.dbEntryTime  — entry_time DB-строки (unix ms)
 * @param {number|null} a.openTime — время открытия НЫНЕШНЕЙ позы из fills, null=неизвестно
 * @returns {'same'|'scale-in'|'reopen'|'unknown'}
 */
export function classifyEntryDrift({ dbEntryPrice, exEntryPx, dbEntryTime, openTime }) {
  if (!(dbEntryPrice > 0) || !(exEntryPx > 0)) return 'unknown';
  const drift = Math.abs(exEntryPx - dbEntryPrice) / dbEntryPrice;
  if (drift <= ENTRY_DRIFT_TOL) return 'same';
  if (!Number.isFinite(openTime)) return 'unknown';
  // 5с допуск: entry_time DB и время fill'а могут разойтись на индексации.
  return openTime > dbEntryTime + 5_000 ? 'reopen' : 'scale-in';
}

/**
 * Оператор перезашёл в тот же коин той же стороной между проходами: монета и
 * сторона совпадают, а позиция УЖЕ ДРУГАЯ. 🚨 Сверки монеты и стороны мало —
 * DB-строка живёт со СТАРЫМ entry_price, трейл считает % от чужого входа.
 *
 * Перезаход от скейл-ина отличаем по флэту: openTime заметно ПОЗЖЕ нашего
 * entry_time ⇒ между входами был ноль. Fills дёргаем только при разошедшейся
 * цене входа (дешёвый гейт).
 *
 * @returns {Promise<boolean>} true → DB-строку надо закрыть по fills и усыновить заново
 */
async function isReopenedPosition(dbPosition, exchangePositions) {
  const dbSide  = (dbPosition.side || 'short').toLowerCase();
  const dbEntry = Number(dbPosition.entry_price);
  if (!(dbEntry > 0)) return false;

  const live = (exchangePositions || [])
    .map((ap) => ap?.position ?? ap)
    .find((p) => {
      const szi = parseFloat(p?.szi ?? '0');
      return isSameCoin(p?.coin, dbPosition.coin) && szi !== 0
        && (szi < 0 ? 'short' : 'long') === dbSide;
    });
  if (!live) return false;

  const exEntry = parseFloat(live.entryPx ?? live.entry_price ?? '0');
  if (!(exEntry > 0)) return false;
  const drift = Math.abs(exEntry - dbEntry) / dbEntry;
  // Дешёвый гейт: цена входа совпала → та же поза, fills не дёргаем.
  if (classifyEntryDrift({ dbEntryPrice: dbEntry, exEntryPx: exEntry, dbEntryTime: dbPosition.entry_time, openTime: null }) === 'same') {
    return false;
  }

  let openTime;
  try {
    const fills = await fetchUserFills(dbPosition.entry_time - 60_000, { force: true });
    openTime = resolveManualOpenTime({
      coin: dbPosition.coin, fills, currentNet: parseFloat(live.szi),
    });
  } catch (err) {
    logger.debug(`[Integrity] reopen-check fills #${dbPosition.coin} failed: ${err.message}`);
    return false;   // не смогли проверить → не рискуем закрывать живую строку
  }

  const verdict = classifyEntryDrift({
    dbEntryPrice: dbEntry, exEntryPx: exEntry, dbEntryTime: dbPosition.entry_time, openTime,
  });
  if (verdict === 'unknown') return false;   // не поняли → живую строку не трогаем
  if (verdict === 'scale-in') {
    logger.warn(
      `[Integrity] #${dbPosition.coin} цена входа уехала ` +
        `($${dbEntry} → $${exEntry}, ${(drift * 100).toFixed(2)}%), но флэта не было — ` +
        `похоже на скейл-ин, строку не трогаю (трейл считает от старого входа).`,
    );
    return false;
  }

  logger.error(
    `[Integrity] ♻️ ПЕРЕЗАХОД #${dbPosition.coin} ${dbSide.toUpperCase()}: DB-строка ` +
      `(id=${dbPosition.id}, entry $${dbEntry}) устарела — на бирже уже другая поза ` +
      `(entry $${exEntry}, открыта ${new Date(openTime).toISOString()}). ` +
      `Закрываю строку по реальным fills, новую подхватит adopt.`,
  );
  return true;
}

/**
 * Проверяет ОДНУ позицию: если её нет на бирже — закрывает в БД с классификацией
 * причины и шлёт уведомление. exchangePositions/equity/withdrawable передаются
 * сверху (один fetch на весь проход, multi-position).
 * @param {boolean} [forceClose] — пропустить проверку «жива ли поза» (вызывающий
 *   уже установил, что DB-строка не соответствует бирже: перезаход).
 * @returns {Promise<boolean>} true если позиция была закрыта внешне
 */
async function closeIfVanished(dbPosition, exchangePositions, equity, withdrawable, forceClose = false) {
  const now = Date.now();

  // Grace period после ОТКРЫТИЯ позиции (даём 10с на индексацию API)
  if (now - dbPosition.entry_time < 10_000) return false;

  // «На месте» = живая поза той же монеты И ТОЙ ЖЕ СТОРОНЫ. Поза противоположной
  // стороны на бирже = ФЛИП (оператор закрыл и развернулся) → наша DB-поза закрыта →
  // проваливаемся в закрытие (fix #1 запишет реальную ногу, adopt усыновит новую).
  if (!forceClose && liveMatchesPosition(dbPosition, exchangePositions)) {
    // Поза снова на месте (был лаг API) — сбрасываем defer-метку, чтобы реальное
    // исчезновение позже получило свежее окно ожидания close-fill.
    state.vanishedSince.delete(dbPosition.id);
    return false;
  }

  // ── Позиция исчезла ──────────────
  // Точный PnL/цену даёт close-fill (classifyClose ниже). Equity-diff
  // (equity_now − equity_at_open) — грубый фолбэк: он загрязнён плавающим PnL
  // других поз и фандингом, поэтому только когда fills так и не показали
  // закрытие после defer-окна.
  const holdHours = (Date.now() - dbPosition.entry_time) / 3_600_000;

  let estimatedPnl  = 0;
  let feePaid       = 0;       // комиссия из close-fills (контракт DB: realized_pnl net of fees)
  let pnlAccurate   = false;
  let pnlFromFills  = false;   // true → PnL взят из реального close-fill
  let closeReason   = 'external_close';
  let closePx       = 0;
  let closedAtOverride = null;

  // force:true обходит 30с-кэш: close-fill мог проиндексироваться только что
  // (лаг HL 10–30с), а stale-кэш отдаст пустоту и уронит нас в equity-diff.
  try {
    const fills = await fetchUserFills(dbPosition.entry_time - 60_000, { force: true });
    const coinFills = fills.filter(
      (f) => f.coin.toUpperCase() === dbPosition.coin.toUpperCase(),
    );
    // Причину закрытия (sl/tp/manual/liq) берём из classifyClose — она смотрит на
    // первый close-fill и его oid. PnL из неё НЕ берём: она суммирует ВСЕ
    // close-fills после entry_time и при флипе/повторном заходе мержит чужие ноги.
    const c = classifyClose(dbPosition, coinFills);
    if (c.reason !== 'external_unknown') closeReason = c.reason;

    // ── PnL/цена — только из конкретной same-side ноги (матч по цене входа) ──
    // 🚨 При флипе или быстром перезаходе classifyClose складывает обе ноги в
    // одну цифру. Нет чистой ноги (лаг индексации) → leg=null → уходим в defer
    // и ждём, а не пишем мусорную сумму.
    const leg = findRoundTripForPosition(dbPosition, coinFills);
    if (leg && Number.isFinite(leg.pnl)) {
      if (Number.isFinite(c.pnl) && Math.abs((leg.pnl ?? 0) - (c.pnl ?? 0)) > 1e-6) {
        logger.warn(
          `[Integrity] #${dbPosition.coin} FLIP/merge: classifyClose sum=$${(c.pnl ?? 0).toFixed(4)} ` +
            `→ реальная ${dbPosition.side}-нога (по цене входа) pnl=$${leg.pnl.toFixed(4)}`,
        );
      }
      estimatedPnl = leg.pnl;
      feePaid      = Number.isFinite(leg.fee) ? leg.fee : 0;
      pnlAccurate  = true;
      pnlFromFills = true;
      if (Number.isFinite(leg.closePx)) closePx = leg.closePx;
      if (Number.isFinite(leg.closedAt)) closedAtOverride = leg.closedAt;
    }

    logger.info(
      `[Integrity] #${dbPosition.coin} classified as '${closeReason}' | ` +
        `pnl=${Number.isFinite(estimatedPnl) ? '$' + estimatedPnl.toFixed(4) : 'n/a'} | ` +
        `closePx=${closePx ? '$' + closePx : 'n/a'}`,
    );
  } catch (clsErr) {
    logger.debug(`[Integrity] classifyClose failed: ${clsErr.message}`);
  }

  // ── Defer: close-fill ещё не проиндексирован ──────────────────────────────
  // Поза исчезла, но fills так и не показали закрытие → реального PnL у нас нет,
  // а equity-diff наврёт. Откладываем запись на следующие проходы integrity (60с),
  // пока индексатор HL не догонит. Но не дольше INTEGRITY_VANISH_DEFER_MS — иначе
  // слот завис бы навсегда (напр. если fill реально потерян).
  if (!pnlFromFills) {
    const firstSeen = state.vanishedSince.get(dbPosition.id);
    if (!firstSeen) {
      state.vanishedSince.set(dbPosition.id, now);
      logger.warn(
        `[Integrity] #${dbPosition.coin} исчез с биржи, но close-fill ещё не виден — ` +
          `откладываю запись закрытия (жду индексации реального PnL).`,
      );
      return false;
    }
    if (now - firstSeen < INTEGRITY_VANISH_DEFER_MS) {
      logger.debug(
        `[Integrity] #${dbPosition.coin} всё ещё без close-fill ` +
          `(${Math.round((now - firstSeen) / 1000)}с в ожидании) — продолжаю ждать.`,
      );
      return false;
    }
    // Defer-окно вышло — закрываем по equity-diff, но честно помечаем неточным
    // (pnlAccurate=false) и НЕ пишем close_price (его у нас нет).
    if (Number.isFinite(dbPosition.entry_equity) && dbPosition.entry_equity > 0) {
      estimatedPnl = equity - dbPosition.entry_equity;
    }
    pnlAccurate = false;
    logger.warn(
      `[Integrity] #${dbPosition.coin} close-fill не появился за ` +
        `${Math.round(INTEGRITY_VANISH_DEFER_MS / 60_000)}мин — закрываю по equity-diff ` +
        `(PnL≈$${estimatedPnl.toFixed(4)}, НЕточный, close_price не записан).`,
    );
  }
  // Дошли до записи закрытия — defer-метка больше не нужна.
  state.vanishedSince.delete(dbPosition.id);

  // DB-контракт: realized_pnl = NET of fees (как bot-пути calcPnl/hunterReconcile).
  // Из fills приходит price PnL ДО комиссий (Σ closedPnl) → вычитаем комиссию.
  // Equity-diff путь (pnlFromFills=false) уже net (equity отражает fees) и комиссию
  // отдельно не знает → не трогаем, fee_paid=0.
  if (pnlFromFills) estimatedPnl -= feePaid;

  logger.error(
    `[Integrity] ⚠️ EXTERNAL CLOSE: #${dbPosition.coin} был OPEN в БД, но ОТСУТСТВУЕТ ` +
      `на бирже. withdrawable=$${withdrawable.toFixed(2)}, equity=$${equity.toFixed(2)} ` +
      `| reason=${closeReason} | pnl=$${estimatedPnl.toFixed(4)}${pnlFromFills ? ' (fills)' : ' (equity-diff)'}`,
  );

  // Adopt: подмешиваем MFE/MAE (peak/trough unrealized% за время ведения) +
  // hold_seconds ДО clearAdoptState. Внешний путь (sl_trigger/manual_close) —
  // основной для adopt, поэтому без этого mfe/mae для стопов не записывались.
  let exitFeatures = null;
  if (dbPosition.strategy_id === 'adopt') {
    const mm = consumeAdoptMfeMae(dbPosition.id);
    const sz = dbPosition.size_usd || 0;
    const closeTs = Number.isFinite(closedAtOverride) ? closedAtOverride : Date.now();
    exitFeatures = {
      mfe_pct:      mm.mfePct,
      mae_pct:      mm.maePct,
      mfe_usd:      mm.mfePct != null ? (mm.mfePct / 100) * sz : null,
      mae_usd:      mm.maePct != null ? (mm.maePct / 100) * sz : null,
      hold_seconds: Math.round((closeTs - dbPosition.entry_time) / 1000),
    };
  }

  dbClosePosition(dbPosition.id, {
    close_price:  closePx,
    realized_pnl: estimatedPnl,
    fee_paid:     pnlFromFills ? feePaid : 0,
    reason:       closeReason,
    closed_at:    closedAtOverride,  // реальное время ноги (флип) — иначе Date.now()
    exitFeatures,
  });

  // Позиции больше нет — снимаем её недобитые ордера. 🚨 Выживший reduce-only
  // из пары SL+TP закроет НОВУЮ позу при перезаходе в ту же монету.
  const staleOids = [dbPosition.hunter_sl_oid, dbPosition.hunter_tp_oid].filter(Boolean);
  for (const oid of staleOids) {
    try {
      await cancelOrderFor(dbPosition.coin, oid);
      logger.info(`[Integrity] снял осиротевший ордер #${dbPosition.coin} oid=${oid}`);
    } catch (err) {
      // Сработал или уже снят — штатный исход, а не ошибка.
      logger.debug(`[Integrity] cancel oid=${oid} #${dbPosition.coin}: ${err.message}`);
    }
  }

  // Adopt: внешнее/ручное закрытие — частый путь выхода для adopted-позы.
  // Shadow time-cut финализируем ДО clearAdoptState, затем чистим per-position
  // trail-state, иначе peak-Map копит мусор.
  if (dbPosition.strategy_id === 'adopt') {
    finalizeAdoptTimeCut(dbPosition, closePx);
    finalizeAdoptShadowTrail(dbPosition, closePx);
    clearAdoptShadowTrail(dbPosition.id);
    clearAdoptState(dbPosition.id);
  }

  logger.info(
    `[Integrity] DB position #${dbPosition.coin} (id=${dbPosition.id}) closed | ` +
      `held: ${holdHours.toFixed(1)}h | estimated PnL: $${estimatedPnl.toFixed(4)}`,
  );

  // TG-уведомление о внешнем закрытии — только для БОТ-стратегий: там external
  // close = ADL/ликвидация/неожиданность, реальный риск-сигнал. Для adopt ручное
  // закрытие — штатный путь выхода, поэтому молчим (событие остаётся в логе выше).
  if (dbPosition.strategy_id !== 'adopt') {
    const pnlSign  = estimatedPnl >= 0 ? '+' : '';
    const pnlEmoji = estimatedPnl >= 0 ? '📈' : '📉';
    const pnlLine = pnlAccurate
      ? `${pnlEmoji} PnL: ${pnlSign}$${estimatedPnl.toFixed(4)}\n`
      : `PnL: точная оценка недоступна (нет entry_equity)\n` +
        `Смотри Hyperliquid UI или сравни с предыдущим equity вручную.\n`;

    // Риск-алерт: позиция исчезла с биржи помимо бота (ADL, ликвидация, рука).
    // Знать об этом надо немедленно и ночью тоже.
    await fireNtfy({
      title: `⚠️ Внешнее закрытие #${dbPosition.coin}`,
      message:
        `Закрыт на стороне биржи (ADL, ликвидация или ручное действие)\n` +
        `Размер: $${dbPosition.size_usd.toFixed(2)} | Entry: $${dbPosition.entry_price}\n` +
        `Удержание: ${holdHours.toFixed(1)}ч\n` +
        pnlLine +
        `Equity: $${equity.toFixed(2)} | Withdrawable: $${withdrawable.toFixed(2)}\n` +
        `Слот освобождён.`,
      tags: ['rotating_light'],
      urgent: true,
    });
  }

  return true;
}

/**
 * @returns {Promise<boolean>} true если хотя бы одна позиция была закрыта внешне
 */
/**
 * Монеты, у которых на бирже висят reduce-only ордера, но живой позиции нет.
 *
 * Reduce-only ордер существует только для закрытия позиции — если позиции нет,
 * ордер осиротел. Такие ордера держат маржу и дают ложную сигнатуру «лага API».
 *
 * Чистая функция: без сети и БД, чтобы тест не требовал живого кошелька.
 *
 * @param {Array} openOrders — ответ frontendOpenOrders
 * @param {Array} dbPositions — строки позиций, которые проверяет Integrity
 * @returns {string[]} монеты-сироты (в верхнем регистре)
 */
export function orphanReduceOnlyCoins(openOrders, dbPositions) {
  const wanted = new Set(
    (dbPositions || []).map((p) => String(p?.coin || '').toUpperCase()).filter(Boolean),
  );
  if (wanted.size === 0) return [];
  const found = new Set();
  for (const o of openOrders || []) {
    const coin = String(o?.coin || '').toUpperCase();
    if (!coin || !wanted.has(coin)) continue;
    if (o?.reduceOnly === true || o?.isPositionTpsl === true) found.add(coin);
  }
  return [...found];
}

// ── Здоровье сверки «БД ↔ биржа» для health-плашки ─────────────────────────
// Исход проверки уезжает в шапку дашборда (core/healthRegistry.js).
//
// 🚨 РАЗРЕШЁННОЕ расхождение и ЗАВИСШЕЕ — разные вещи. Позиция, исчезнувшая с
// биржи и тут же закрытая в БД, — сработавший механизм, хоть в логе и ERROR.
// Лаг индексатора — состояние, где зеркало и биржа не сошлись и правды мы не
// знаем: разовый проход норма, затяжной — поломка. Отсюда счёт подряд.
const LAG_FAIL_STREAK = 3; // ≥3 проходов подряд (~3 мин) — это уже не «API отстал»
let _lagStreak = 0;

const HEALTH_TTL_MS = INTEGRITY_CHECK_INTERVAL_MS * 3;

function noteMirror(status, detail) {
  note('db_vs_exchange', { category: 'xref', status, detail, ttlMs: HEALTH_TTL_MS });
}

export async function integrityCheck() {
  if (!config.isProduction) return false;

  const now = Date.now();

  // 1. Grace period после старта бота
  if (state.botStartedAt > 0 && now - state.botStartedAt < INTEGRITY_GRACE_PERIOD_MS) {
    return false;
  }

  if (now - state.lastIntegrityCheck < INTEGRITY_CHECK_INTERVAL_MS) return false;
  state.lastIntegrityCheck = now;

  // Слот-позиция (Hunter/carry/...) + ВСЕ adopt-позы (multi-slot). Дедуп по id.
  const slotPos = getActivePosition();
  const adoptPositions = getActiveAdoptPositions();
  const byId = new Map();
  if (slotPos) byId.set(slotPos.id, slotPos);
  for (const p of adoptPositions) byId.set(p.id, p);
  const positionsToCheck = [...byId.values()];
  if (positionsToCheck.length === 0) {
    _lagStreak = 0;
    noteMirror('pass', 'no open positions — nothing to cross-check');
    return false;
  }

  try {
    const exchangePositions = await getPositionsCached();

    // Account summary один раз на проход (margin-guard + PnL fallback).
    let equity = 0;
    let withdrawable = 0;
    try {
      const summary = await getAccountSummary();
      equity       = summary.equity;
      withdrawable = summary.available;
    } catch {
      // деградируем — PnL уйдёт на fills/неизвестно, margin-guard пропустит
    }

    // Какие из проверяемых позиций реально отсутствуют в ответе биржи?
    const liveOnExchange = exchangePositions.filter(
      (ap) => parseFloat((ap?.position ?? ap)?.szi ?? '0') !== 0,
    );
    // Поза «исчезла», если на бирже нет живой позы той же монеты И ТОЙ ЖЕ
    // СТОРОНЫ (флип противоположной стороны тоже = исчезла).
    const vanished = positionsToCheck.filter(
      (db) => !liveMatchesPosition(db, liveOnExchange),
    );

    // Поза «на месте» по монете+стороне, но это уже ДРУГАЯ поза (закрыл→перезашёл):
    // строка тоже подлежит закрытию, только forceClose (см. isReopenedPosition).
    const reopened = [];
    for (const db of positionsToCheck) {
      if (vanished.includes(db)) continue;
      if (Date.now() - db.entry_time < 10_000) continue;   // тот же grace, что в closeIfVanished
      try {
        if (await isReopenedPosition(db, liveOnExchange)) reopened.push(db);
      } catch (err) {
        logger.debug(`[Integrity] reopen-check #${db.coin} failed: ${err.message}`);
      }
    }

    // 🚨 Всё на месте = норма, без margin-guard: withdrawable < 50% equity
    // истинно всегда, когда деньги в позах, и гард спамил бы варнингом.
    if (vanished.length === 0 && reopened.length === 0) {
      _lagStreak = 0;
      noteMirror('pass', `${positionsToCheck.length} position(s) in place, no drift`);
      return false;
    }

    // Лаг-сигнатура: биржа вернула ПУСТО, а маржа занята → позиции есть, API
    // отстал. Есть хоть одна поза в ответе — это не общий лаг, а исчезновение
    // конкретной монеты, оно ниже.
    //
    // 🚨 Занятая маржа сама по себе не лаг: осиротевшие reduce-only ордера держат
    // её тоже, и круг замыкается — ордера не снять, пока строка открыта. Поэтому
    // сначала спрашиваем ордера: reduce-only без позиции = сирота.
    if (
      liveOnExchange.length === 0 &&
      equity > 10 &&
      withdrawable < equity * 0.5
    ) {
      let orphanCoins = [];
      try {
        orphanCoins = orphanReduceOnlyCoins(await getFrontendOpenOrders(), positionsToCheck);
      } catch (err) {
        // ордера не отдались — консервативный путь
        logger.debug(`[Integrity] open-orders read failed: ${err.message}`);
      }
      if (orphanCoins.length === 0) {
        logger.warn(
          `[Integrity] ⚡ getPositions() пуст, но маржа заблокирована: ` +
            `withdrawable=$${withdrawable.toFixed(2)} vs equity=$${equity.toFixed(2)} ` +
            `(${((withdrawable / equity) * 100).toFixed(1)}%). Похоже на лаг API — skipping.`,
        );
        _lagStreak++;
        noteMirror(
          _lagStreak >= LAG_FAIL_STREAK ? 'fail' : 'warn',
          `API lag, ${_lagStreak} pass(es) in a row: exchange empty, ` +
            `yet $${(equity - withdrawable).toFixed(2)} of margin is held`,
        );
        return false;
      }
      logger.warn(
        `[Integrity] маржа заблокирована, но это НЕ лаг API: reduce-only ордера без позиции ` +
          `#${orphanCoins.join(', #')} — закрываю строки и снимаю сирот`,
      );
    }

    let anyClosed = false;
    for (const dbPosition of vanished) {
      try {
        if (await closeIfVanished(dbPosition, exchangePositions, equity, withdrawable)) {
          anyClosed = true;
        }
      } catch (err) {
        logger.debug(`[Integrity] check #${dbPosition.coin} failed: ${err.message}`);
      }
    }
    for (const dbPosition of reopened) {
      try {
        if (await closeIfVanished(dbPosition, exchangePositions, equity, withdrawable, true)) {
          anyClosed = true;
        }
      } catch (err) {
        logger.debug(`[Integrity] reopen-close #${dbPosition.coin} failed: ${err.message}`);
      }
    }
    // Расхождение было и обработано — это механизм сработал, а не авария.
    // Именно здесь штатный выход по полу (target-trail закрывает биржевым
    // ордером) перестаёт выглядеть так же, как настоящий рассинхрон.
    _lagStreak = 0;
    const names = [...vanished, ...reopened].map((p) => `#${p.coin}`).join(', ');
    noteMirror(
      anyClosed ? 'pass' : 'warn',
      anyClosed
        ? `drift on ${names} closed in the DB`
        : `drift on ${names} did NOT close — the row is still open`,
    );
    return anyClosed;
  } catch (err) {
    logger.debug(`[Integrity] Check failed (non-critical): ${err.message}`);
    noteMirror('warn', `cross-check failed: ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────
//  Manual Position Check — hands-off режим
// ─────────────────────────────────────────────────
// Каждый тик проверяет: если на бирже есть позиция, которой нет в БД бота —
// это ты торгуешь вручную (LONG или SHORT). Бот в этом случае:
//   • НЕ усыновляет позицию (ты сам управляешь exit'ом)
//   • НЕ открывает свою параллельно (паузится)
//   • Шлёт уведомление ОДИН РАЗ при входе в hands-off режим
// Когда ручная позиция исчезает с биржи → бот автоматом возвращается к торговле.

let lastOrphanCheck = 0;
const ORPHAN_CHECK_INTERVAL_MS = 60_000;  // 60с — реже чем тик чтобы не спамить API

/**
 * @returns {Promise<'paused'|false>} 'paused' если бот должен пропустить тик
 */
export async function orphanCheck() {
  if (!config.isProduction) return false;

  const now = Date.now();
  // Adopt включён → проверяем каждый тик (~15с), чтобы стоп вешался на свежий
  // ручной вход почти сразу, а не через минуту незащищённого окна. Без adopt —
  // прежние 60с (детект нужен только для hands-off паузы, спешить некуда).
  const interval = config.trading.adoptEnabled ? 0 : ORPHAN_CHECK_INTERVAL_MS;
  if (now - lastOrphanCheck < interval) {
    // throttle активен, но если флаг уже стоит — продолжаем паузить тик
    return state.manualPositionActive ? 'paused' : false;
  }
  lastOrphanCheck = now;

  // Монеты, которыми бот ВЛАДЕЕТ в БД: single-slot позиция (Hunter/carry/...) +
  // ВСЕ adopt-позы (multi-slot). Их исключаем из «ручного» списка, иначе уже
  // усыновлённые adopt-монеты выглядели бы как новые ручные orphan'ы.
  const slotPos = getActivePosition();
  const adoptPositions = getActiveAdoptPositions();
  const ownedCoins = new Set();
  if (slotPos) ownedCoins.add(slotPos.coin);
  for (const p of adoptPositions) ownedCoins.add(p.coin);

  let exchangePositions;
  try {
    exchangePositions = await fetchExchangePositions();
  } catch (err) {
    logger.debug(`[Manual] fetchExchangePositions failed: ${err.message}`);
    return state.manualPositionActive ? 'paused' : false;
  }

  // Остаётся только «ручное» — позы на бирже, которых нет в БД бота
  const manualPositions = exchangePositions.filter((p) => !ownedCoins.has(p.coin));

  // 🚨 Крутим ДАЖЕ на пустом списке: усыновлённая монета уходит из manualPositions,
  // и ранний return ниже пропускал подрезку first-seen и бэкфилл entry_time —
  // протухшая запись доживала до следующего входа по той же монете.
  if (config.trading.adoptEnabled && manualPositions.length === 0) {
    try {
      await maybeAdoptManualPosition([]);   // подрезает first-seen
    } catch (err) {
      logger.debug(`[Adopt] first-seen housekeeping failed: ${err.message}`);
    }
    try {
      await reconcileProvisionalAdoptEntries();
    } catch (err) {
      logger.debug(`[Adopt] provisional entry backfill failed: ${err.message}`);
    }
  }

  // ── Ручных позиций нет ─────────────────────────
  if (manualPositions.length === 0) {
    if (state.manualPositionActive) {
      // Юзер закрыл всё руками → возврат в работу. Без пуша: спам про ручные
      // позиции не нужен, лога достаточно.
      const coins = [...state.manualPositionCoins].join(', ');
      logger.info(`[Manual] ✅ Manual position(s) gone (${coins}) — resuming normal trading`);
      state.manualPositionActive = false;
      state.manualPositionCoins.clear();
      state.manualWarningThrottle.clear();
    }
    return false;
  }

  // ── Adopt Mode (multi-slot, plans/adopt-mode-plan.md) ─────
  // Подхватываем ВСЕ свежие ручные позы в adopt-слоты (reduce-only стоп + ведение).
  // 🚨 Гейта «слот бота свободен» тут быть не должно: усыновление вешает только
  // защитный стоп на твою позу по ДРУГОЙ монете, экспозицию не растит и за слот
  // не конкурирует, а с гейтом ручной вход рядом с входом бота уходит без стопа.
  // Усыновлённые монеты перестают быть «ручными» — убираем их из списка и флагов.
  let activeManual = manualPositions;
  if (config.trading.adoptEnabled) {
    try {
      const adoptedCoins = await maybeAdoptManualPosition(manualPositions);
      if (adoptedCoins.length > 0) {
        const adoptedSet = new Set(adoptedCoins);
        activeManual = manualPositions.filter((p) => !adoptedSet.has(p.coin));
        for (const c of adoptedCoins) {
          state.manualPositionCoins.delete(c);
          state.manualWarningThrottle.delete(c);
        }
      }
    } catch (err) {
      // 🚨 warn, не debug: на LOG_LEVEL=info провал adopt иначе невидим.
      logger.warn(`[Manual] adopt attempt failed: ${err.message}`);
    }
    // Бэкфилл реального entry_time для поз, усыновлённых по провизорному first-seen
    // (fill долетел спустя ~30с после adopt) — точная классификация 'adopted'.
    try {
      await reconcileProvisionalAdoptEntries();
    } catch (err) {
      logger.debug(`[Adopt] provisional entry backfill failed: ${err.message}`);
    }
  }

  // Все ручные позы усыновлены → паузить тик не нужно: adopt-позы ведёт
  // superviseAdoptPositions(), а coordinator для adopt вернёт HOLD.
  if (activeManual.length === 0) {
    state.manualPositionActive = false;
    return false;
  }

  // ── Ручные позиции есть → hands-off режим ─────
  state.manualPositionActive = true;
  const currentCoins = new Set(activeManual.map((p) => p.coin));
  state.manualPositionCoins = currentCoins;

  // Уведомление шлём ОДИН РАЗ на коин — пока оператор не закроет позицию.
  // throttle Map используется как "notified set": если запись уже есть,
  // молчим. При закрытии всех ручных позиций map очищается (см. ветку выше),
  // следующая открытая поза снова получит уведомление.
  // Прошлая версия слала каждые 30 мин — раздражало без причины, оператор и так
  // видит позицию на бирже / дашборде.
  for (const exPos of activeManual) {
    if (!state.manualWarningThrottle.has(exPos.coin)) {
      state.manualWarningThrottle.set(exPos.coin, now);
      const side = exPos.szi < 0 ? 'SHORT' : 'LONG';
      const sizeUsd = Math.abs(exPos.szi) * exPos.entryPx;
      // TG-уведомление о ручной позиции убрано: ручная торговля —
      // основной режим оператора, поза и так видна на дашборде/бирже. Оставляем
      // только лог для диагностики.
      logger.warn(
        `[Manual] 🖐 Manual ${side} detected #${exPos.coin} szi=${exPos.szi} entry=$${exPos.entryPx} (~$${sizeUsd.toFixed(2)}) — bot paused`,
      );
    }
  }

  return 'paused';
}
