// ─────────────────────────────────────────────────
//  Integrity Check — детектор внешнего закрытия позиций
// ─────────────────────────────────────────────────
// Каждые 60с проверяет: если в БД есть OPEN-позиция, но на бирже
// по этому тикеру позиция отсутствует, значит она была закрыта
// внешне (ADL, ликвидация, ручное действие).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition, getActiveAdoptPositions, closePosition as dbClosePosition } from '../core/database.js';
import { getPositionsCached, getAccountSummary } from '../modules/exchange.js';
import { sendMessage } from '../modules/reporter.js';
import { fetchExchangePositions } from '../modules/sync.js';
import { fetchUserFills, classifyClose, findRoundTripForPosition } from '../modules/userFills.js';
import { maybeAdoptManualPosition, reconcileProvisionalAdoptEntries } from './adoptReconcile.js';
import { clearAdoptState, consumeAdoptMfeMae } from '../modules/strategistAdopt.js';
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
 * наша DB-поза фактически закрыта и подлежит закрытию/перезаписи. Side-aware:
 * без сверки стороны флип short→long не детектился (adopt flip-merge баг 2026-06-18).
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
 * Проверяет ОДНУ позицию: если её нет на бирже — закрывает в БД с классификацией
 * причины и шлёт уведомление. exchangePositions/equity/withdrawable передаются
 * сверху (один fetch на весь проход, multi-position).
 * @returns {Promise<boolean>} true если позиция была закрыта внешне
 */
async function closeIfVanished(dbPosition, exchangePositions, equity, withdrawable) {
  const now = Date.now();

  // Grace period после ОТКРЫТИЯ позиции (даём 10с на индексацию API)
  if (now - dbPosition.entry_time < 10_000) return false;

  // «На месте» = живая поза той же монеты И ТОЙ ЖЕ СТОРОНЫ. Поза противоположной
  // стороны на бирже = ФЛИП (оператор закрыл и развернулся) → наша DB-поза закрыта →
  // проваливаемся в закрытие (fix #1 запишет реальную ногу, adopt усыновит новую).
  if (liveMatchesPosition(dbPosition, exchangePositions)) {
    // Поза снова на месте (был лаг API) — сбрасываем defer-метку, чтобы реальное
    // исчезновение позже получило свежее окно ожидания close-fill.
    state.vanishedSince.delete(dbPosition.id);
    return false;
  }

  // ── Позиция исчезла ──────────────
  // Точный PnL/цену даёт close-fill (classifyClose ниже). Equity-diff
  // (equity_now − equity_at_open) — лишь грубый fallback: он загрязнён плавающим
  // PnL других открытых поз и фандингом с момента входа, поэтому используем его
  // ТОЛЬКО когда fills так и не показали закрытие после defer-окна (RESOLV-
  // инцидент 2026-06-24: equity-diff записал +$1.22 вместо реальных +$0.46).
  const holdHours = (Date.now() - dbPosition.entry_time) / 3_600_000;

  let estimatedPnl  = 0;
  let pnlAccurate   = false;
  let pnlFromFills  = false;   // true → PnL взят из реального close-fill
  let closeReason   = 'external_close';
  let closePx       = 0;
  let closedAtOverride = null;

  // Classify cause через userFills. force:true — обходим 30с-кэш: close-fill мог
  // проиндексироваться только что (лаг HL 10-30с), а stale-кэш раньше отдавал
  // пустоту и ронял нас в мусорный equity-diff.
  try {
    const fills = await fetchUserFills(dbPosition.entry_time - 60_000, { force: true });
    const coinFills = fills.filter(
      (f) => f.coin.toUpperCase() === dbPosition.coin.toUpperCase(),
    );
    const c = classifyClose(dbPosition, coinFills);
    if (c.reason !== 'external_unknown') closeReason = c.reason;
    if (Number.isFinite(c.pnl)) {
      estimatedPnl = c.pnl;
      pnlAccurate  = true;  // fills дают точное число
      pnlFromFills = true;
    }
    if (Number.isFinite(c.closePx)) closePx = c.closePx;

    // ── Анти-мердж при флипе ──────────────────────────────────────────────
    // classifyClose суммирует ВСЕ close-fills с момента входа. Если оператор флипнул
    // монету (short→long) до того, как integrity поймал исчезновение, сумма
    // схлопывала обе ноги в одну цифру, и минусовая нога пропадала из history
    // (adopt flip-merge баг 2026-06-18). Берём конкретную ногу по стороне+входу.
    const leg = findRoundTripForPosition(dbPosition, coinFills);
    if (leg && Number.isFinite(leg.pnl)) {
      if (Math.abs((leg.pnl ?? 0) - (c.pnl ?? 0)) > 1e-6) {
        logger.warn(
          `[Integrity] #${dbPosition.coin} FLIP detected: merged pnl=$${(c.pnl ?? 0).toFixed(4)} ` +
            `→ real ${dbPosition.side}-leg pnl=$${leg.pnl.toFixed(4)} (остальные ноги учтутся отдельно)`,
        );
      }
      estimatedPnl = leg.pnl;
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
    fee_paid:     0,
    reason:       closeReason,
    closed_at:    closedAtOverride,  // реальное время ноги (флип) — иначе Date.now()
    exitFeatures,
  });

  // Adopt: внешнее/ручное закрытие — частый путь выхода для adopted-позы.
  // Чистим per-position trail-state, иначе peak-Map копит мусор.
  if (dbPosition.strategy_id === 'adopt') clearAdoptState(dbPosition.id);

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
      ? `${pnlEmoji} PnL: <b>${pnlSign}$${estimatedPnl.toFixed(4)}</b>\n`
      : `📊 PnL: <i>точная оценка недоступна (нет entry_equity для этой позиции)</i>\n` +
        `   Смотри Hyperliquid UI или сравни с предыдущим equity вручную.\n`;

    await sendMessage(
      `⚠️ <b>ВНЕШНЕЕ ЗАКРЫТИЕ ПОЗИЦИИ</b>\n` +
        `<code>═════════════════════</code>\n` +
        `🔍 Обнаружено расхождение:\n` +
        `<b>#${dbPosition.coin}</b> закрыт на стороне биржи\n` +
        `<i>(ADL, ликвидация или ручное действие)</i>\n` +
        `<code>─────────────────────</code>\n` +
        `💰 Размер: <b>$${dbPosition.size_usd.toFixed(2)}</b>\n` +
        `💵 Entry: <b>$${dbPosition.entry_price}</b>\n` +
        `⏳ Удержание: <b>${holdHours.toFixed(1)}ч</b>\n` +
        pnlLine +
        `💰 Equity: <b>$${equity.toFixed(2)}</b> | Withdrawable: <b>$${withdrawable.toFixed(2)}</b>\n` +
        `<code>═════════════════════</code>\n` +
        `🤖 Слот освобождён.`,
      true,
    );
  }

  return true;
}

/**
 * @returns {Promise<boolean>} true если хотя бы одна позиция была закрыта внешне
 */
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
  if (positionsToCheck.length === 0) return false;

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

    // Всё на месте → расхождения нет. Это НОРМА, пока открыты позиции — раньше
    // здесь срабатывал margin-guard и спамил варнингом каждые 60с (393×/9ч),
    // потому что withdrawable < 50% equity истинно всегда, когда деньги в позах.
    if (vanished.length === 0) return false;

    // Лаг-сигнатура индексатора: биржа вернула ПУСТО (ни одной живой позы), а
    // маржа заблокирована → позиции есть, просто API отстал. Гасим, чтобы не
    // закрыть всё ложно. Если хотя бы одна поза в ответе есть — это не общий лаг,
    // а реальное исчезновение конкретной монеты → обрабатываем ниже.
    if (
      liveOnExchange.length === 0 &&
      equity > 10 &&
      withdrawable < equity * 0.5
    ) {
      logger.warn(
        `[Integrity] ⚡ getPositions() пуст, но маржа заблокирована: ` +
          `withdrawable=$${withdrawable.toFixed(2)} vs equity=$${equity.toFixed(2)} ` +
          `(${((withdrawable / equity) * 100).toFixed(1)}%). Похоже на лаг API — skipping.`,
      );
      return false;
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
    return anyClosed;
  } catch (err) {
    logger.debug(`[Integrity] Check failed (non-critical): ${err.message}`);
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

  // ── Ручных позиций нет ─────────────────────────
  if (manualPositions.length === 0) {
    if (state.manualPositionActive) {
      // Юзер закрыл всё руками → возврат в работу. TG-уведомление убрано
      // (2026-06-13, запрос оператора): спам про ручные позиции не нужен, лог достаточно.
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
  // Adopt НЕ зависит от того, держит ли бот-стратегия (Hunter/carry/...) свой
  // single-slot: усыновление вешает только reduce-only защитный стоп на ТВОЮ
  // ручную позу по ДРУГОЙ монете — экспозицию не увеличивает и за слот бота не
  // конкурирует. Раньше здесь стоял гейт «слот свободен от бот-стратегии», из-за
  // которого ручной вход одновременно с входом бота (бот в NIL + ты в EIGEN)
  // молча уходил в hands-off без стопа (incident 2026-06-14). Монета, которой
  // владеет бот (slotPos.coin), уже исключена из manualPositions через ownedCoins,
  // так что её adopt не тронет. Усыновлённые монеты перестают быть «ручными»:
  // убираем из manual-списка и flag'ов, чтобы не словить ложное «ручные закрыты».
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
      // Видимый лог: раньше debug → при LOG_LEVEL=info провал adopt был невидим
      // и диагностировался только лазаньем в БД (incident 2026-06-14).
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
      // TG-уведомление о ручной позиции убрано (2026-06-09): ручная торговля —
      // основной режим оператора, поза и так видна на дашборде/бирже. Оставляем
      // только лог для диагностики.
      logger.warn(
        `[Manual] 🖐 Manual ${side} detected #${exPos.coin} szi=${exPos.szi} entry=$${exPos.entryPx} (~$${sizeUsd.toFixed(2)}) — bot paused`,
      );
    }
  }

  return 'paused';
}
