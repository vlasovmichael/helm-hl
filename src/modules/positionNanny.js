// ─────────────────────────────────────────────────
//  Нянька — разбор ОТКРЫТЫХ позиций против их плана
// ─────────────────────────────────────────────────
// Модуль НИЧЕГО не предсказывает и входов не предлагает. Он берёт позицию,
// открытую руками, и её ордера с биржи, и говорит факт: защищена ли позиция,
// сколько стоит стоп в долларах, где ты сейчас в R.
//
// 🚨 План читается с БИРЖИ, а не из нашей БД: в БД стопы могут быть, когда на
// бирже их уже нет (протухший API-ключ).

const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);

/**
 * Защитные ордера позиции из frontendOpenOrders. Стоп — trigger + reduceOnly,
 * цель — обычная reduce-only лимитка по ходу сделки (на HL «TP» пользователя
 * почти всегда именно лимитка, а не trigger-ордер).
 *
 * @param {Array} orders — сырой frontendOpenOrders
 * @param {string} coin
 * @param {'LONG'|'SHORT'} side
 * @param {number} price — текущая цена
 */
export function protectiveOrders(orders, coin, side, price) {
  const isShort = side === 'SHORT';
  const want = String(coin).toUpperCase();
  const mine = (orders || []).filter(
    (o) => String(o?.coin || '').toUpperCase() === want && o?.reduceOnly,
  );

  // Стоп: предикат 1:1 с setupScannerAlerts и tradeTicket — обязателен isTrigger,
  // иначе под «стоп» попадёт обычный reduce-only лимитник (то есть цель).
  const stops = mine
    .filter((o) => o.isTrigger && /stop/i.test(o.orderType || ''))
    .map((o) => ({ px: Number(o.triggerPx), sz: Math.abs(Number(o.sz) || 0) }))
    .filter((o) => Number.isFinite(o.px) && o.px > 0);

  // Цель: не-trigger reduce-only лимитка, стоящая по ходу сделки от цены.
  // Проверка стороны обязательна — reduce-only лимитка ПРОТИВ хода это не цель,
  // а попытка выйти в убыток лимитом, и мерить по ней прогресс нельзя.
  const targets = mine
    .filter((o) => !o.isTrigger)
    .map((o) => ({ px: Number(o.limitPx), sz: Math.abs(Number(o.sz) || 0) }))
    .filter((o) => Number.isFinite(o.px) && o.px > 0)
    .filter((o) => (isShort ? o.px < price : o.px > price));

  // Из нескольких берём ближайший к цене: он сработает первым, и именно он
  // описывает ближайшее будущее позиции.
  const nearest = (arr) =>
    arr.length ? arr.slice().sort((a, b) => Math.abs(a.px - price) - Math.abs(b.px - price))[0] : null;

  const sumSz = (arr) => arr.reduce((s, o) => s + o.sz, 0);

  return {
    stop: nearest(stops),
    target: nearest(targets),
    stopCount: stops.length,
    targetCount: targets.length,
    stopSz: sumSz(stops),
    targetSz: sumSz(targets),
  };
}

/**
 * Разбор одной открытой позиции. Чистая функция: цена, позиция и ордера
 * инжектятся вызывающим.
 *
 * @param {Object} p
 * @param {string} p.coin
 * @param {{side:'LONG'|'SHORT', entryPx:number, szi:number, notionalUsd:number, unrealizedPnl:number}} p.position
 * @param {number} p.price
 * @param {Array} p.orders — frontendOpenOrders (сырой)
 * @param {boolean} [p.ordersKnown] — удалось ли прочитать ордера с биржи
 */
export function buildPositionView({ coin, position, price, orders, ordersKnown = true }) {
  const side = position.side;
  const isShort = side === 'SHORT';
  const entry = position.entryPx;
  const sz = Math.abs(position.szi);
  // Доходность считается ОТ ВХОДА (делим на entry, не на текущую цену): это
  // процент, который сделка сделала на вложенном, и для шорта он не совпадает
  // с pct(entry, price) — та формула делит на цену и завышает результат.
  const gainPct = entry > 0 ? ((isShort ? entry - price : price - entry) / entry) * 100 : null;

  const found = ordersKnown
    ? protectiveOrders(orders, coin, side, price)
    : { stop: null, target: null, stopCount: 0, targetCount: 0, stopSz: 0, targetSz: 0 };

  const stopPx = found.stop?.px ?? null;
  const targetPx = found.target?.px ?? null;

  // Ход в деньгах от входа до уровня — то, что реально произойдёт со счётом.
  const moneyTo = (level) =>
    level == null ? null : (isShort ? entry - level : level - entry) * sz;

  const riskUsd = moneyTo(stopPx);       // отрицательный, если стоп по ту сторону входа
  const rewardUsd = moneyTo(targetPx);
  // Стоп, уводящий позицию в плюс (подтянутый в безубыток и дальше), — это не
  // риск, а зафиксированная прибыль. R от такого стопа не определён, и делить
  // на него нельзя: получилась бы бесконечность или отрицательный R.
  const stopLocksProfit = riskUsd != null && riskUsd >= 0;
  const riskAbsUsd = riskUsd != null && riskUsd < 0 ? Math.abs(riskUsd) : null;

  const riskPct = stopPx != null ? Math.abs(pct(stopPx, entry)) : null;
  const rewardPct = targetPx != null ? Math.abs(pct(targetPx, entry)) : null;
  const rr = riskAbsUsd != null && rewardUsd != null && rewardUsd > 0 ? rewardUsd / riskAbsUsd : null;

  const pnl = position.unrealizedPnl;
  // R и прогресс считаем ОТ ПОКАЗАННОЙ ЦЕНЫ, а не от биржевого uPnL. Они
  // приходят из разных источников: uPnL биржа считает от mark, а строка «Now» —
  // из mid. На дешёвых монетах расхождение давало «цена на входе, +0.00%, но
  // −0.07R» — панель спорила сама с собой. Деньги (Unrealized) остаются
  // биржевыми: это бухгалтерия. R — про то, где я между входом и стопом.
  const moveUsd = (isShort ? entry - price : price - entry) * sz;
  const rNow = riskAbsUsd != null && riskAbsUsd > 0 ? moveUsd / riskAbsUsd : null;
  const progressPct =
    rewardUsd != null && rewardUsd > 0
      ? Math.max(0, Math.min(100, (moveUsd / rewardUsd) * 100))
      : null;

  const toStopPct = stopPx != null ? Math.abs(pct(stopPx, price)) : null;
  const toTargetPct = targetPx != null ? Math.abs(pct(targetPx, price)) : null;

  // ── статус: только факт о защите позиции, никаких прогнозов ──
  let status;
  let headline;
  let detail;
  if (!ordersKnown) {
    status = 'orders_unknown';
    headline = 'Could not read orders from the exchange';
    detail =
      'The list of open orders could not be fetched. Whether the position is protected is unknown; ' +
      'staying quiet about that is worse than saying it. Check the stop by hand in the terminal.';
  } else if (stopPx == null) {
    status = 'unprotected';
    headline = 'There is NO stop on the exchange';
    detail =
      'The position has no protective trigger order. Rule 2 of TRADING_RULES: the stop goes in BEFORE the entry. ' +
      'Until it exists, the loss on this trade is unbounded.';
  } else if (targetPx == null) {
    status = 'stop_only';
    headline = 'Stop is set, target is not';
    detail =
      'The position is protected but has no profit exit. Without a target limit the exit gets decided in the moment — ' +
      'and in the journal that is exactly how green turns into flat.';
  } else {
    status = 'armed';
    headline = 'Stop and target are both in place';
    detail = 'The position is running to plan. While price sits between the levels there is nothing to do.';
  }

  // ── заметки: считанные факты, а не советы ──
  const notes = [];
  if (stopLocksProfit) {
    notes.push(
      `The stop ${stopPx} is already past the entry ${entry} — it locks in profit rather than capping ` +
        'a loss. There is no risk left on this trade, so there is no R to measure.',
    );
  }
  if (riskAbsUsd != null) {
    notes.push(
      `The stop costs $${riskAbsUsd.toFixed(2)} — that is what leaves the account if price touches it ` +
      `(${riskPct.toFixed(2)}% from entry).`,
    );
  }
  if (toStopPct != null && toStopPct < 1) {
    notes.push(`${toStopPct.toFixed(2)}% to the stop — that is one candle at current volatility.`);
  }
  if (rr != null && rr < 1) {
    notes.push(
      `Plan R:R ${rr.toFixed(2)} — the target is closer than the stop. For this to pay you would need to be right ` +
      `more than ${(100 / (1 + rr)).toFixed(0)}% of the time; the journal baseline is 59%.`,
    );
  }
  // Стоп/цель на часть объёма — самая тихая из ошибок: панель показывает
  // «защищено», а прикрыта половина позиции.
  if (found.stopSz > 0 && sz > 0 && found.stopSz < sz * 0.99) {
    notes.push(
      `Stops cover ${found.stopSz} of ${sz} — the rest of the position is unprotected, ` +
      `so the real risk is larger than shown.`,
    );
  }
  if (found.stopCount > 1) notes.push(`There are several stops (${found.stopCount}) — showing the one nearest to price.`);
  if (found.targetCount > 1) notes.push(`There are several targets (${found.targetCount}) — showing the one nearest to price.`);

  return {
    coin,
    side,
    status,
    headline,
    detail,
    notes,
    position: {
      entryPx: entry,
      price,
      sz,
      notionalUsd: position.notionalUsd,
      unrealizedPnl: pnl,
      gainPct,
    },
    plan: {
      stop: stopPx,
      target: targetPx,
      riskUsd: riskAbsUsd,
      rewardUsd: rewardUsd != null && rewardUsd > 0 ? rewardUsd : null,
      riskPct,
      rewardPct,
      rr,
      rNow,
      progressPct,
      toStopPct,
      toTargetPct,
      stopLocksProfit,
      stopCoverage: sz > 0 && found.stopSz > 0 ? found.stopSz / sz : null,
    },
  };
}

/**
 * Полный разбор всех открытых позиций + сводка по счёту.
 *
 * Сортировка НЕ по размеру и не по PnL, а по срочности: незащищённые позиции
 * идут первыми. Панель существует ради вопроса «что горит», а не «где больше
 * денег».
 *
 * @param {Map<string,Object>} positions — COIN → позиция с биржи
 * @param {Map<string,number>} prices — COIN → текущая цена
 * @param {Array} orders — frontendOpenOrders
 * @param {boolean} ordersKnown
 */
export function buildNannyView({ positions, prices, orders, ordersKnown = true, now = Date.now() }) {
  const views = [];
  for (const [coin, position] of positions) {
    const price = prices.get(coin) ?? position.entryPx;
    if (!(price > 0) || !(position.entryPx > 0)) continue;
    views.push(buildPositionView({ coin, position, price, orders, ordersKnown }));
  }

  const rank = { orders_unknown: 0, unprotected: 0, stop_only: 1, armed: 2 };
  views.sort(
    (a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || b.position.notionalUsd - a.position.notionalUsd,
  );

  // Суммарный риск = сколько уйдёт со счёта, если СЕЙЧАС сработают все стопы.
  // Позиции без стопа в эту сумму не входят и потому считаются отдельно: их
  // риск не «ноль», он неизвестен, и смешивать одно с другим нельзя.
  let riskUsd = 0;
  let unprotected = 0;
  let notionalUsd = 0;
  for (const v of views) {
    notionalUsd += v.position.notionalUsd || 0;
    if (v.plan.riskUsd != null) riskUsd += v.plan.riskUsd;
    if (v.status === 'unprotected' || v.status === 'orders_unknown') unprotected += 1;
  }

  return {
    generatedAt: now,
    positions: views,
    totals: {
      count: views.length,
      notionalUsd,
      riskUsd: views.some((v) => v.plan.riskUsd != null) ? riskUsd : null,
      unprotected,
    },
    ordersKnown,
  };
}
