// ─────────────────────────────────────────────────
//  Нянька — разбор ОТКРЫТЫХ позиций против их плана
// ─────────────────────────────────────────────────
// Пришла на смену «Монете дня» (снята 29.08.2026). Та карточка искала входы:
// скорила рынок по шести признакам и предлагала фейд выдохшегося хвоста.
// Её замерили дважды и оба раза получили ноль:
//
//   • реплей 14.08 (n=103, живая analyzeCoin по истории): −0.046R
//     [−0.209 … +0.116]. Бейзлайны рядом: случайная монета −0.027R,
//     случайное время −0.003R. Эдж не засчитан.
//   • форвард 26.07–29.08 (n=33): +0.09R — при разбросе ~0.83R это ±0.28R,
//     от нуля неотличимо.
//
// 🔑 Но снята она не за ноль, а за КОНСТРУКТИВНЫЙ дефект, который оба замера
// показали одинаково: гейт MIN_RR ≥ 1.5 требовал хода в полтора риска, а
// TIME_STOP_MIN = 120 закрывал позицию через два часа. Цель физически не
// успевала — 1 достижение из 103 в реплее, 2 из 33 на форварде. Карточка
// рисовала план «стоп 1.25% / цель 5.51%», а работала как «зайди и через два
// часа возьми что дают». Плюс два дефекта, найденных 29.08: жёсткий фильтр
// |chg24h| ≥ 8% стирал сетап по мере его же отработки (тот же класс, что
// чинили для края диапазона на kSHIB 26.07), а балл hits.move дублировал этот
// фильтр и потому начислялся всем — «5 из 6» на деле было 4 из 5.
//
// Что осталось. Этот модуль НИЧЕГО не предсказывает и не предлагает входов.
// Он берёт позицию, которую оператор открыл руками, и её же ордера с биржи, и
// говорит факт: защищена ли позиция, сколько стоит стоп в долларах, где ты
// сейчас в R. Это нянька из рестарта 23.08, а не оракул.
//
// ⚠️ План читается с БИРЖИ, а не из нашей БД — урок инцидента «API-кошелёк
// мёртв 4 дня»: в БД стопы были, на бирже их не было.

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
  const rNow = riskAbsUsd != null && riskAbsUsd > 0 ? pnl / riskAbsUsd : null;
  const progressPct =
    rewardUsd != null && rewardUsd > 0 ? Math.max(0, Math.min(100, (pnl / rewardUsd) * 100)) : null;

  const toStopPct = stopPx != null ? Math.abs(pct(stopPx, price)) : null;
  const toTargetPct = targetPx != null ? Math.abs(pct(targetPx, price)) : null;

  // ── статус: только факт о защите позиции, никаких прогнозов ──
  let status;
  let headline;
  let detail;
  if (!ordersKnown) {
    status = 'orders_unknown';
    headline = 'Ордера с биржи не прочитались';
    detail =
      'Не удалось получить список открытых ордеров. Защищена позиция или нет — неизвестно; ' +
      'молчать об этом хуже, чем сказать. Проверь стоп руками в терминале.';
  } else if (stopPx == null) {
    status = 'unprotected';
    headline = 'Стопа на бирже НЕТ';
    detail =
      'У позиции нет защитного trigger-ордера. Правило №2 из TRADING_RULES: стоп ставится ДО входа. ' +
      'Пока его нет, размер убытка по этой сделке ничем не ограничен.';
  } else if (targetPx == null) {
    status = 'stop_only';
    headline = 'Стоп есть, цели нет';
    detail =
      'Позиция защищена, но выхода в плюс не задано. Без лимитки-цели выход решается в моменте — ' +
      'а по журналу именно так плюс превращается в ноль.';
  } else {
    status = 'armed';
    headline = 'Стоп и цель на месте';
    detail = 'Позиция ведётся по плану. Пока цена между уровнями, делать нечего.';
  }

  // ── заметки: считанные факты, а не советы ──
  const notes = [];
  if (stopLocksProfit) {
    notes.push(
      `Стоп ${stopPx} уже по ту сторону входа ${entry} — он фиксирует прибыль, а не ограничивает ` +
      'убыток. Риска по этой сделке больше нет, R считать не от чего.',
    );
  }
  if (riskAbsUsd != null) {
    notes.push(
      `Стоп стоит $${riskAbsUsd.toFixed(2)} — столько списывается со счёта, если цена его коснётся ` +
      `(${riskPct.toFixed(2)}% от входа).`,
    );
  }
  if (toStopPct != null && toStopPct < 1) {
    notes.push(`До стопа ${toStopPct.toFixed(2)}% — это одна свеча на текущей волатильности.`);
  }
  if (rr != null && rr < 1) {
    notes.push(
      `R:R плана ${rr.toFixed(2)} — цель ближе стопа. Чтобы такая сделка окупалась, попадать надо ` +
      `чаще ${(100 / (1 + rr)).toFixed(0)}% раз, а бейзлайн журнала — 59%.`,
    );
  }
  // Стоп/цель на часть объёма — самая тихая из ошибок: панель показывает
  // «защищено», а прикрыта половина позиции.
  if (found.stopSz > 0 && sz > 0 && found.stopSz < sz * 0.99) {
    notes.push(
      `Стопы прикрывают ${found.stopSz} из ${sz} — остаток позиции без защиты, ` +
      `реальный риск больше показанного.`,
    );
  }
  if (found.stopCount > 1) notes.push(`Стопов несколько (${found.stopCount}) — показан ближайший к цене.`);
  if (found.targetCount > 1) notes.push(`Целей несколько (${found.targetCount}) — показана ближайшая к цене.`);

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
