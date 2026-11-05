// Бухгалтерия виртуального счёта: кэш, позиции, ордера, филлы. Без сети и диска.
// Формы ответов повторяют /info Hyperliquid, чтобы бот читал счёт тем же кодом.
// Маржа всегда изолированная: ticket и нянька другой не выставляют.

export const TAKER_FEE_RATE = 0.00045;
export const MAKER_FEE_RATE = 0.00015;
const DEFAULT_LEVERAGE = 1;
const FALLBACK_MAX_LEVERAGE = 20;
const SIZE_EPSILON = 1e-9;

export function createPaperState(startBalance, now) {
  return {
    version: 1,
    startBalance,
    createdAt: now,
    cash: startBalance,
    positions: {},
    leverage: {},
    orders: [],
    fills: [],
    funding: [],
    nextOid: 1,
    nextTid: 1,
    lastFundingHour: Math.floor(now / 3_600_000),
  };
}

export function leverageFor(state, coin) {
  return state.leverage[coin] ?? DEFAULT_LEVERAGE;
}

export function nextOid(state) {
  return state.nextOid++;
}

function unrealizedOf(position, price) {
  return (price - position.entryPx) * position.szi;
}

function markOf(position, marks) {
  const mark = marks[position.coin];
  return Number.isFinite(mark) && mark > 0 ? mark : position.entryPx;
}

/** Цена ликвидации изолированной позы; null — поза без плеча, ликвидировать нечему. */
export function liquidationPrice(position, maxLeverage = FALLBACK_MAX_LEVERAGE) {
  const size = Math.abs(position.szi);
  const notional = size * position.entryPx;
  if (!(notional > 0)) return null;
  const marginShare = position.margin / notional;
  const maintenance = 1 / (2 * maxLeverage);
  const price = position.szi > 0
    ? (position.entryPx * (1 - marginShare)) / (1 - maintenance)
    : (position.entryPx * (1 + marginShare)) / (1 + maintenance);
  return price > 0 ? price : null;
}

/** Маржа под позициями и под лимитками, способными открыть новую позицию. */
export function marginHeld(state) {
  const onPositions = Object.values(state.positions).reduce((sum, p) => sum + p.margin, 0);
  const onOrders = state.orders
    .filter((o) => !o.reduceOnly)
    .reduce((sum, o) => sum + (o.sz * o.px) / leverageFor(state, o.coin), 0);
  return onPositions + onOrders;
}

export function equityOf(state, marks) {
  const unrealized = Object.values(state.positions)
    .reduce((sum, p) => sum + unrealizedOf(p, markOf(p, marks)), 0);
  return state.cash + unrealized;
}

export function availableOf(state, marks) {
  return Math.max(0, equityOf(state, marks) - marginHeld(state));
}

/** Сколько свободной маржи нужно ордеру, с учётом разворота позиции. */
export function marginShortfall(state, { coin, isBuy, sz, px }, marks) {
  const position = state.positions[coin];
  const signed = isBuy ? sz : -sz;
  const current = position?.szi ?? 0;
  const reversing = current !== 0 && Math.sign(current) !== Math.sign(signed);
  const opening = reversing ? Math.max(0, sz - Math.abs(current)) : sz;
  if (opening <= SIZE_EPSILON) return 0;
  const released = reversing && opening > 0 ? position.margin : 0;
  const required = (opening * px) / leverageFor(state, coin);
  return Math.max(0, required - availableOf(state, marks) - released);
}

function pushFill(state, fill) {
  const record = {
    coin: fill.coin,
    px: String(fill.px),
    sz: String(fill.sz),
    side: fill.isBuy ? 'B' : 'A',
    time: fill.now,
    startPosition: String(fill.startPosition),
    dir: fill.dir,
    closedPnl: String(fill.closedPnl),
    hash: `0xpaper${fill.tid.toString(16)}`,
    oid: fill.oid,
    crossed: fill.crossed,
    fee: String(fill.fee),
    feeToken: 'USDC',
    tid: fill.tid,
    ...(fill.liquidation ? { liquidation: fill.liquidation } : {}),
  };
  state.fills.push(record);
  return record;
}

function closeLeg(state, { coin, isBuy, sz, px, oid, crossed, now, feeRate, liquidation }) {
  const position = state.positions[coin];
  const direction = position.szi > 0 ? 1 : -1;
  const closedPnl = (px - position.entryPx) * sz * direction;
  const fee = sz * px * feeRate;
  const startPosition = position.szi;
  const share = sz / Math.abs(position.szi);

  position.funding.sinceChange = 0;
  position.margin -= position.margin * share;
  position.szi -= sz * direction;
  state.cash = Math.max(0, state.cash + closedPnl - fee);
  if (Math.abs(position.szi) <= SIZE_EPSILON) delete state.positions[coin];

  return pushFill(state, {
    coin, isBuy, sz, px, oid, crossed, now, fee, closedPnl, startPosition, liquidation,
    dir: `Close ${direction > 0 ? 'Long' : 'Short'}`,
    tid: state.nextTid++,
  });
}

function openLeg(state, { coin, isBuy, sz, px, oid, crossed, now, feeRate }) {
  const direction = isBuy ? 1 : -1;
  const existing = state.positions[coin];
  const startPosition = existing?.szi ?? 0;
  const margin = (sz * px) / leverageFor(state, coin);
  const fee = sz * px * feeRate;

  if (existing) {
    const totalSize = Math.abs(existing.szi) + sz;
    existing.entryPx = (Math.abs(existing.szi) * existing.entryPx + sz * px) / totalSize;
    existing.szi += sz * direction;
    existing.margin += margin;
    existing.leverage = leverageFor(state, coin);
  } else {
    state.positions[coin] = {
      coin,
      szi: sz * direction,
      entryPx: px,
      margin,
      leverage: leverageFor(state, coin),
      openedAt: now,
      funding: { allTime: 0, sinceOpen: 0, sinceChange: 0 },
    };
  }
  state.cash = Math.max(0, state.cash - fee);

  return pushFill(state, {
    coin, isBuy, sz, px, oid, crossed, now, fee, closedPnl: 0, startPosition,
    dir: `Open ${isBuy ? 'Long' : 'Short'}`,
    tid: state.nextTid++,
  });
}

/**
 * Исполняет объём по цене и пишет филлы. Разворот — два филла: закрытие и открытие.
 * @returns {Array} новые филлы в формате userFills
 */
export function executeFill(state, { coin, isBuy, sz, px, oid, crossed, now, reduceOnly = false, liquidation }) {
  const feeRate = crossed ? TAKER_FEE_RATE : MAKER_FEE_RATE;
  const fills = [];
  const common = { coin, isBuy, px, oid, crossed, now, feeRate };
  let remaining = sz;

  const position = state.positions[coin];
  const closesPosition = position && (position.szi > 0) !== isBuy;
  if (closesPosition) {
    const closing = Math.min(remaining, Math.abs(position.szi));
    fills.push(closeLeg(state, { ...common, sz: closing, liquidation }));
    remaining -= closing;
  }
  if (!reduceOnly && remaining > SIZE_EPSILON) {
    fills.push(openLeg(state, { ...common, sz: remaining }));
  }
  return fills;
}

/** Начисляет фандинг; rates и marks — словари по имени монеты. */
export function accrueFunding(state, rates, marks, now) {
  const entries = [];
  for (const position of Object.values(state.positions)) {
    const rate = rates[position.coin];
    if (!Number.isFinite(rate)) continue;
    const mark = markOf(position, marks);
    const usdc = -position.szi * mark * rate;
    state.cash = Math.max(0, state.cash + usdc);
    position.funding.allTime -= usdc;
    position.funding.sinceOpen -= usdc;
    position.funding.sinceChange -= usdc;
    const entry = {
      time: now,
      hash: `0xpaperfunding${now.toString(16)}`,
      delta: {
        type: 'funding',
        coin: position.coin,
        usdc: String(usdc),
        szi: String(position.szi),
        fundingRate: String(rate),
      },
    };
    state.funding.push(entry);
    entries.push(entry);
  }
  return entries;
}

function positionView(position, marks, maxLeverageOf) {
  const mark = markOf(position, marks);
  const unrealized = unrealizedOf(position, mark);
  const maxLeverage = maxLeverageOf(position.coin);
  const liquidation = liquidationPrice(position, maxLeverage);
  return {
    type: 'oneWay',
    position: {
      coin: position.coin,
      szi: String(position.szi),
      leverage: { type: 'isolated', value: position.leverage, rawUsd: String(position.margin) },
      entryPx: String(position.entryPx),
      positionValue: String(Math.abs(position.szi) * mark),
      unrealizedPnl: String(unrealized),
      returnOnEquity: String(position.margin > 0 ? unrealized / position.margin : 0),
      liquidationPx: liquidation == null ? null : String(liquidation),
      marginUsed: String(position.margin + unrealized),
      maxLeverage,
      cumFunding: {
        allTime: String(position.funding.allTime),
        sinceOpen: String(position.funding.sinceOpen),
        sinceChange: String(position.funding.sinceChange),
      },
    },
  };
}

/** Ответ clearinghouseState. totalUnrealizedPnl отсутствует и у настоящей биржи. */
export function clearinghouseView(state, marks, maxLeverageOf, now) {
  const equity = equityOf(state, marks);
  const held = marginHeld(state);
  const totalNtlPos = Object.values(state.positions)
    .reduce((sum, p) => sum + Math.abs(p.szi) * markOf(p, marks), 0);
  const summary = {
    accountValue: String(equity),
    totalNtlPos: String(totalNtlPos),
    totalRawUsd: String(state.cash),
    totalMarginUsed: String(held),
  };
  return {
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: '0',
    withdrawable: String(Math.max(0, equity - held)),
    assetPositions: Object.values(state.positions).map((p) => positionView(p, marks, maxLeverageOf)),
    time: now,
  };
}

/** Ответ spotClearinghouseState: в unified-счёте total уже включает uPnL. */
export function spotView(state, marks) {
  return {
    balances: [{
      coin: 'USDC',
      token: 0,
      hold: String(marginHeld(state)),
      total: String(equityOf(state, marks)),
      entryNtl: '0',
    }],
  };
}

/** Ответ frontendOpenOrders. */
export function openOrdersView(state) {
  return state.orders.map((order) => ({
    coin: order.coin,
    side: order.isBuy ? 'B' : 'A',
    limitPx: String(order.px),
    sz: String(order.sz),
    oid: order.oid,
    timestamp: order.placedAt,
    origSz: String(order.sz),
    reduceOnly: order.reduceOnly,
    isTrigger: order.kind === 'trigger',
    isPositionTpsl: false,
    triggerPx: order.kind === 'trigger' ? String(order.px) : '0.0',
    triggerCondition: order.kind === 'trigger' ? 'Triggered' : 'N/A',
    orderType: orderTypeLabel(order),
    tif: order.kind === 'trigger' ? null : order.tif,
    children: [],
    cloid: null,
  }));
}

function orderTypeLabel(order) {
  if (order.kind !== 'trigger') return 'Limit';
  return order.tpsl === 'sl' ? 'Stop Market' : 'Take Profit Market';
}

/** Сработал ли триггер: стоп идёт против позиции, цель — по ней. */
export function triggerFired(order, price) {
  const closingLong = !order.isBuy;
  if (order.tpsl === 'sl') return closingLong ? price <= order.px : price >= order.px;
  return closingLong ? price >= order.px : price <= order.px;
}

/** Лимитка считается налитой, только когда цена дошла до неё: очередь в книге неизвестна. */
export function limitReached(order, price) {
  return order.isBuy ? price <= order.px : price >= order.px;
}

export function liquidationHit(position, price, maxLeverage) {
  const level = liquidationPrice(position, maxLeverage);
  if (level == null) return false;
  return position.szi > 0 ? price <= level : price >= level;
}
