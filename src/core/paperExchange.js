// Бумажная биржа: цены и стакан настоящие, ордера и счёт виртуальные.
// Подменяет подписанный клиент SDK и ответы /info о своём счёте, поэтому остальной
// код торгует как обычно. Сброс счёта: удалить каталог config.accountDir.
// Цены опрашиваются дискретно: фитиль между опросами цель не нальёт, а стоп исполнится хуже.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { logger } from './logger.js';
import { coalesce, invalidateAccountState } from './accountState.js';
import { hlInfo, HL_PRIORITY, setInfoInterceptor } from './hlClient.js';
import { getLivePrice as feedLivePrice, isFeedFresh } from './priceFeed.js';
import { findAsset, resolveApiCoin } from './universe.js';
import {
  MAKER_FEE_RATE, TAKER_FEE_RATE,
  accrueFunding, clearinghouseView, createPaperState, executeFill,
  limitReached, liquidationHit, marginShortfall, nextOid, openOrdersView, spotView, triggerFired,
} from './paperAccount.js';

const STATE_FILE = 'paper_account.json';
const ENGINE_INTERVAL_MS = 2_000;
const PRICES_TTL_MS = 2_000;
const FILLS_PAGE_LIMIT = 2_000;
const FUNDING_PAGE_LIMIT = 500;
const MIN_ORDER_USD = 10;
const SIZE_EPSILON = 1e-9;

let state = null;
let engineTimer = null;
let engineBusy = false;
let queue = Promise.resolve();
const fillListeners = new Set();

function statePath() {
  return join(config.accountDir, STATE_FILE);
}

/** Битый файл не заменяем новым счётом: молча обнулил бы всю бумажную историю. */
function loadState() {
  let raw;
  try {
    raw = readFileSync(statePath(), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return createPaperState(config.trading.paperStartBalance, Date.now());
  }
  return JSON.parse(raw);
}

function saveState() {
  mkdirSync(config.accountDir, { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath());
}

function account() {
  if (!state) throw new Error('[PaperExchange] not started');
  return state;
}

/** Мутации идут строго по одной: между await цены иначе вклинился бы чужой филл. */
function serialized(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function maxLeverageOf(coin) {
  const value = Number(findAsset(coin)?.maxLeverage);
  return Number.isFinite(value) && value >= 1 ? value : undefined;
}

function apiCoin(symbol) {
  return resolveApiCoin(String(symbol).replace(/-PERP$/i, ''));
}

async function fetchAllMids() {
  const mids = await hlInfo({ type: 'allMids' }, { label: 'paper/allMids', priority: HL_PRIORITY.HIGH });
  const map = {};
  for (const [coin, px] of Object.entries(mids ?? {})) {
    const value = parseFloat(px);
    if (value > 0) map[coin.toUpperCase()] = value;
  }
  return map;
}

/** Текущие цены монет: свежий WS-фид, иначе один лёгкий allMids на всех. */
async function pricesFor(coins) {
  const marks = {};
  const missing = [];
  for (const coin of coins) {
    const live = isFeedFresh() ? feedLivePrice(coin)?.price : null;
    if (live > 0) marks[coin] = live;
    else missing.push(coin);
  }
  if (missing.length) {
    const mids = await coalesce('paperMids', fetchAllMids, PRICES_TTL_MS);
    for (const coin of missing) {
      const value = mids[coin.toUpperCase()];
      if (value > 0) marks[coin] = value;
    }
  }
  return marks;
}

function accountCoins() {
  const current = account();
  return [...new Set([...Object.keys(current.positions), ...current.orders.map((o) => o.coin)])];
}

async function accountMarks() {
  return pricesFor(accountCoins());
}

async function readBook(coin) {
  const book = await hlInfo({ type: 'l2Book', coin }, { label: 'paper/l2Book', priority: HL_PRIORITY.HIGH });
  const parse = (levels) => (levels ?? [])
    .map((level) => ({ px: parseFloat(level.px), sz: parseFloat(level.sz) }))
    .filter((level) => level.px > 0 && level.sz > 0);
  return { bids: parse(book?.levels?.[0]), asks: parse(book?.levels?.[1]) };
}

/** VWAP прохода по стакану; объём сверх видимой глубины идёт по её последнему уровню. */
export function walkBook(levels, size) {
  if (!levels.length) return null;
  let left = size;
  let cost = 0;
  for (const level of levels) {
    const taken = Math.min(left, level.sz);
    cost += taken * level.px;
    left -= taken;
    if (left <= SIZE_EPSILON) break;
  }
  if (left > SIZE_EPSILON) cost += left * levels[levels.length - 1].px;
  return cost / size;
}

async function takerPrice(coin, isBuy, size) {
  try {
    const book = await readBook(coin);
    const price = walkBook(isBuy ? book.asks : book.bids, size);
    if (price > 0) return price;
  } catch (err) {
    logger.warn(`[PaperExchange] стакан #${coin} не прочитан: ${err.message}`);
  }
  const marks = await pricesFor([coin]);
  if (marks[coin] > 0) return marks[coin];
  throw new Error(`no price for ${coin}`);
}

function publishFills(fills) {
  if (!fills.length) return;
  invalidateAccountState('balance', 'positions');
  for (const listener of fillListeners) {
    try {
      listener(fills);
    } catch (err) {
      logger.warn(`[PaperExchange] обработчик филла упал: ${err.message}`);
    }
  }
}

function filledResponse(oid, fills) {
  const size = fills.reduce((sum, f) => sum + parseFloat(f.sz), 0);
  const cost = fills.reduce((sum, f) => sum + parseFloat(f.sz) * parseFloat(f.px), 0);
  return orderResponse({ filled: { oid, totalSz: String(size), avgPx: String(cost / size) } });
}

function orderResponse(status) {
  return { status: 'ok', response: { type: 'order', data: { statuses: [status] } } };
}

/** Проверки биржи на ордер, способный открыть позицию. Отказ — строка, как у HL. */
async function openingRejection(coin, isBuy, size, price) {
  if (size * price < MIN_ORDER_USD) return `Order must have minimum value of $${MIN_ORDER_USD}.`;
  const marks = await accountMarks();
  const shortfall = marginShortfall(account(), { coin, isBuy, sz: size, px: price }, marks);
  return shortfall > 0 ? 'Insufficient margin to place order.' : null;
}

function marketOpen(symbol, isBuy, size) {
  return serialized(async () => {
    const coin = apiCoin(symbol);
    const sz = parseFloat(size);
    const px = await takerPrice(coin, isBuy, sz);
    const rejection = await openingRejection(coin, isBuy, sz, px);
    if (rejection) return orderResponse(rejection);

    const oid = nextOid(account());
    const fills = executeFill(account(), { coin, isBuy, sz, px, oid, crossed: true, now: Date.now() });
    saveState();
    logger.info(`[PaperExchange] market ${isBuy ? 'BUY' : 'SELL'} #${coin} ${sz} @ ${px}`);
    publishFills(fills);
    return filledResponse(oid, fills);
  });
}

function marketClose(symbol, size) {
  return serialized(async () => {
    const coin = apiCoin(symbol);
    const position = account().positions[coin];
    if (!position) throw new Error(`No position found for ${symbol}`);

    const held = Math.abs(position.szi);
    const sz = size == null ? held : Math.min(parseFloat(size), held);
    const isBuy = position.szi < 0;
    const px = await takerPrice(coin, isBuy, sz);

    const oid = nextOid(account());
    const fills = executeFill(account(), {
      coin, isBuy, sz, px, oid, crossed: true, now: Date.now(), reduceOnly: true,
    });
    saveState();
    logger.info(`[PaperExchange] market close #${coin} ${sz} @ ${px}`);
    publishFills(fills);
    return filledResponse(oid, fills);
  });
}

async function crossesBook(coin, isBuy, price) {
  const book = await readBook(coin);
  const opposite = isBuy ? book.asks[0]?.px : book.bids[0]?.px;
  if (!(opposite > 0)) return false;
  return isBuy ? price >= opposite : price <= opposite;
}

/** Gtc, пересёкший книгу, исполняется сразу тейкером, но не хуже своей цены. */
async function fillCrossingLimit({ coin, isBuy, sz, px, reduceOnly }) {
  const position = account().positions[coin];
  const size = reduceOnly ? Math.min(sz, Math.abs(position.szi)) : sz;
  const taker = await takerPrice(coin, isBuy, size);
  const price = isBuy ? Math.min(taker, px) : Math.max(taker, px);
  const oid = nextOid(account());
  const fills = executeFill(account(), { coin, isBuy, sz: size, px: price, oid, crossed: true, reduceOnly, now: Date.now() });
  saveState();
  publishFills(fills);
  return filledResponse(oid, fills);
}

function placeOrder({ coin: symbol, is_buy: isBuy, sz: size, limit_px: limitPx, order_type: orderType, reduce_only: reduceOnly }) {
  return serialized(async () => {
    const coin = apiCoin(symbol);
    const sz = parseFloat(size);
    const px = parseFloat(limitPx);
    const position = account().positions[coin];

    if (reduceOnly && (!position || (position.szi > 0) === isBuy)) {
      return orderResponse('Reduce only order would increase position.');
    }
    if (!reduceOnly) {
      const rejection = await openingRejection(coin, isBuy, sz, px);
      if (rejection) return orderResponse(rejection);
    }

    const order = { coin, isBuy, sz, px, reduceOnly: !!reduceOnly, placedAt: Date.now() };
    if (orderType?.trigger) {
      order.kind = 'trigger';
      order.tpsl = orderType.trigger.tpsl;
    } else {
      order.kind = 'limit';
      order.tif = orderType?.limit?.tif;
      if (order.tif !== 'Alo' && order.tif !== 'Gtc') {
        return orderResponse(`Paper exchange supports only Alo and Gtc limits, got ${order.tif}.`);
      }
      if (await crossesBook(coin, isBuy, px)) {
        if (order.tif === 'Alo') return orderResponse('Post only order would have immediately matched.');
        return fillCrossingLimit(order);
      }
    }

    order.oid = nextOid(account());
    account().orders.push(order);
    saveState();
    logger.info(`[PaperExchange] ордер ${order.kind} ${isBuy ? 'BUY' : 'SELL'} #${coin} ${sz} @ ${px} oid=${order.oid}`);
    invalidateAccountState('balance');
    return orderResponse({ resting: { oid: order.oid } });
  });
}

function cancelOrder({ coin: symbol, o: oid }) {
  return serialized(async () => {
    const coin = apiCoin(symbol);
    const current = account();
    const index = current.orders.findIndex((order) => order.oid === oid && order.coin === coin);
    if (index === -1) {
      return { status: 'ok', response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled.' }] } } };
    }
    current.orders.splice(index, 1);
    saveState();
    invalidateAccountState('balance');
    return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
  });
}

function updateLeverage(symbol, _marginMode, leverage) {
  return serialized(async () => {
    account().leverage[apiCoin(symbol)] = Number(leverage);
    saveState();
    return { status: 'ok', response: { type: 'default' } };
  });
}

/** Тот же интерфейс, что signing-методы SDK Hyperliquid. */
export const paperClient = {
  custom: {
    marketOpen: (symbol, isBuy, size) => marketOpen(symbol, isBuy, size),
    marketClose: (symbol, size) => marketClose(symbol, size),
  },
  exchange: { placeOrder, cancelOrder, updateLeverage },
};

async function fillOrder(order, marks) {
  const current = account();
  const position = current.positions[order.coin];
  const closable = position && (position.szi > 0) !== order.isBuy;
  if (order.reduceOnly && !closable) return [];

  const sz = order.reduceOnly ? Math.min(order.sz, Math.abs(position.szi)) : order.sz;
  const isTrigger = order.kind === 'trigger';
  const px = isTrigger ? await takerPrice(order.coin, order.isBuy, sz) : order.px;
  if (!(px > 0) || !(marks[order.coin] > 0)) return [];

  return executeFill(current, {
    coin: order.coin,
    isBuy: order.isBuy,
    sz,
    px,
    oid: order.oid,
    crossed: isTrigger,
    reduceOnly: order.reduceOnly,
    now: Date.now(),
  });
}

function liquidate(position, price) {
  logger.warn(`[PaperExchange] ликвидация #${position.coin} @ ${price}`);
  const isBuy = position.szi < 0;
  return executeFill(account(), {
    coin: position.coin,
    isBuy,
    sz: Math.abs(position.szi),
    px: price,
    oid: nextOid(account()),
    crossed: true,
    reduceOnly: true,
    now: Date.now(),
    liquidation: { method: 'market', markPx: String(price) },
  });
}

/** Осматривает ордера и позиции по текущим ценам. Стоп идёт первым: порядок внутри прохода неизвестен, берём худший. */
async function matchOnce(marks) {
  const current = account();
  const produced = [];

  for (const position of Object.values(current.positions)) {
    const price = marks[position.coin];
    if (price > 0 && liquidationHit(position, price, maxLeverageOf(position.coin))) {
      produced.push(...liquidate(position, price));
    }
  }

  const rank = (order) => (order.kind === 'trigger' && order.tpsl === 'sl' ? 0 : 1);
  for (const order of [...current.orders].sort((a, b) => rank(a) - rank(b))) {
    const price = marks[order.coin];
    if (!(price > 0)) continue;
    const reached = order.kind === 'trigger' ? triggerFired(order, price) : limitReached(order, price);
    if (!reached) continue;

    const fills = await fillOrder(order, marks);
    current.orders = current.orders.filter((other) => other.oid !== order.oid);
    produced.push(...fills);
  }
  return produced;
}

async function fetchFundingRates() {
  const [meta, contexts] = await hlInfo(
    { type: 'metaAndAssetCtxs' },
    { label: 'paper/funding', priority: HL_PRIORITY.LOW },
  );
  const rates = {};
  (meta?.universe ?? []).forEach((asset, index) => {
    const rate = parseFloat(contexts?.[index]?.funding);
    if (Number.isFinite(rate)) rates[asset.name] = rate;
  });
  return rates;
}

/** Фандинг за прошедшие часы простоя не догоняется: ставок за них нет. */
async function fundingOnce(marks) {
  const current = account();
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour <= current.lastFundingHour) return false;
  if (Object.keys(current.positions).length) {
    const rates = await fetchFundingRates();
    accrueFunding(current, rates, marks, hour * 3_600_000);
  }
  current.lastFundingHour = hour;
  return true;
}

/** Один проход движка. Экспорт для тестов. */
export function runEngineOnce() {
  return serialized(async () => {
    if (accountCoins().length === 0) {
      account().lastFundingHour = Math.floor(Date.now() / 3_600_000);
      return [];
    }
    const marks = await accountMarks();
    const ordersBefore = account().orders.length;
    const fills = await matchOnce(marks);
    const funded = await fundingOnce(marks);
    if (fills.length || funded || account().orders.length !== ordersBefore) {
      saveState();
      invalidateAccountState('balance', 'positions');
    }
    publishFills(fills);
    return fills;
  });
}

function answerOwnAccount(body) {
  const current = account();
  const now = Date.now();
  switch (body.type) {
    case 'clearinghouseState':
      // Бумажные позиции живут только на основном перп-DEX: на сторонних счёт пуст.
      if (body.dex) return { marginSummary: {}, assetPositions: [], time: now };
      return accountMarks().then((marks) => clearinghouseView(current, marks, maxLeverageOf, now));
    case 'spotClearinghouseState':
      return accountMarks().then((marks) => spotView(current, marks));
    case 'frontendOpenOrders':
      return openOrdersView(current);
    case 'userFillsByTime':
      return current.fills.filter((f) => f.time >= (body.startTime ?? 0)).slice(0, FILLS_PAGE_LIMIT);
    case 'userFunding':
      return current.funding.filter((f) => f.time >= (body.startTime ?? 0)).slice(0, FUNDING_PAGE_LIMIT);
    case 'userFees':
      return { userCrossRate: String(TAKER_FEE_RATE), userAddRate: String(MAKER_FEE_RATE) };
    case 'portfolio':
      return [];
    default:
      return undefined;
  }
}

/** Подписка на бумажные филлы: замена WS-канала userFills. @returns отписка */
export function onPaperFills(listener) {
  fillListeners.add(listener);
  return () => fillListeners.delete(listener);
}

/** Поднимает счёт и перехват чтений. Движок цен стартует отдельно: тестам он не нужен. */
export function startPaperExchange() {
  state = loadState();
  saveState();
  setInfoInterceptor((body) => (body?.user === config.wallet.address ? answerOwnAccount(body) : undefined));
  logger.info(
    `[PaperExchange] виртуальный счёт: кэш $${state.cash.toFixed(2)}, ` +
      `позиций ${Object.keys(state.positions).length}, ордеров ${state.orders.length}`,
  );
}

export function startPaperEngine() {
  if (engineTimer) return;
  engineTimer = setInterval(async () => {
    if (engineBusy) return;
    engineBusy = true;
    try {
      await runEngineOnce();
    } catch (err) {
      logger.warn(`[PaperExchange] проход движка упал: ${err.message}`);
    } finally {
      engineBusy = false;
    }
  }, ENGINE_INTERVAL_MS);
  engineTimer.unref?.();
}

export function stopPaperExchange() {
  if (engineTimer) clearInterval(engineTimer);
  engineTimer = null;
  setInfoInterceptor(null);
  fillListeners.clear();
  state = null;
}

