// Бумажная биржа через настоящие примитивы exchange.js; сеть подменена.
// Настройка до импорта: конфиг читается один раз, путь счёта относителен рабочему каталогу.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

const workDir = mkdtempSync(join(tmpdir(), 'paper-exchange-'));
process.chdir(workDir);
delete process.env.NODE_ENV;
process.env.PAPER_TRADING = 'true';
process.env.PAPER_START_BALANCE = '100';
process.env.HL_PRIVATE_KEY = '0xshould-be-ignored';

const { config } = await import('../src/core/config.js');
const exchange = await import('../src/modules/exchange.js');
const paper = await import('../src/core/paperExchange.js');
const { hlInfo } = await import('../src/core/hlClient.js');
const { invalidateAccountState } = await import('../src/core/accountState.js');
const { fetchUserFills } = await import('../src/modules/userFills.js');
const { paperTitle } = await import('../src/core/notifyLog.js');

let mid = 50_000;
const FUNDING_RATE = '0.0001';
const networkBodies = [];

mock.method(axios, 'post', async (_url, body) => {
  networkBodies.push(body);
  if (body.type === 'allMids') return { data: { BTC: String(mid) }, headers: {} };
  if (body.type === 'l2Book') {
    return {
      data: {
        levels: [
          [{ px: String(mid - 1), sz: '10', n: 1 }],
          [{ px: String(mid + 1), sz: '10', n: 1 }],
        ],
      },
      headers: {},
    };
  }
  if (body.type === 'metaAndAssetCtxs') {
    return { data: [{ universe: [{ name: 'BTC' }] }, [{ funding: FUNDING_RATE }]], headers: {} };
  }
  throw new Error(`unexpected network read: ${body.type}`);
});

const statuses = (result) => result.response.data.statuses;
const accountFile = () => join(config.accountDir, 'paper_account.json');

function reset() {
  paper.stopPaperExchange();
  rmSync(config.accountDir, { recursive: true, force: true });
  paper.startPaperExchange();
  invalidateAccountState();
  networkBodies.length = 0;
  mid = 50_000;
}

async function setMid(value) {
  mid = value;
  invalidateAccountState();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function moveAndMatch(value) {
  await setMid(value);
  // Кэш цен движка живёт две секунды: в тесте его сбрасывает invalidateAccountState.
  return paper.runEngineOnce();
}

beforeEach(reset);

test('флаг отключает ключи, подменяет адрес и уводит счёт в отдельный каталог', () => {
  assert.equal(config.mode, 'PAPER_TRADING');
  assert.equal(config.wallet.privateKey, null);
  assert.equal(config.wallet.address, '0x0000000000000000000000000000000000000000');
  assert.equal(config.accountDir, 'data/paper');
});

test('новый счёт стартует со ста долларов, чтения счёта в сеть не ходят', async () => {
  const { total } = await exchange.fetchSpotUsdcBalance();
  assert.equal(total, 100);
  assert.deepEqual(await exchange.getPositions(), []);
  assert.deepEqual(await exchange.getFrontendOpenOrders(), []);
  assert.deepEqual(networkBodies, []);
});

test('маркет исполняется по стакану, а не по миду', async () => {
  const result = await exchange.openMarket('BTC', true, 0.001, 0.03);
  const { filled } = statuses(result)[0];
  assert.equal(parseFloat(filled.avgPx), 50_001);
  assert.equal(parseFloat(filled.totalSz), 0.001);

  const [{ position }] = await exchange.getPositions();
  assert.equal(position.coin, 'BTC');
  assert.equal(parseFloat(position.szi), 0.001);
});

test('филл виден в истории и прилетает подписчику', async () => {
  const seen = [];
  paper.onPaperFills((fills) => seen.push(...fills));
  await exchange.openMarket('BTC', false, 0.001, 0.03);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].dir, 'Open Short');

  const history = await fetchUserFills(0, { force: true });
  assert.equal(history.length, 1);
  assert.equal(history[0].dir, 'Open Short');
  assert.equal(typeof history[0].closedPnl, 'number');
});

test('биржевые отказы — строкой, как у Hyperliquid', async () => {
  const tooSmall = await exchange.openMarket('BTC', true, 0.0001, 0.03);
  assert.match(statuses(tooSmall)[0], /minimum value/);
  const tooBig = await exchange.openMarket('BTC', true, 0.01, 0.03);
  assert.match(statuses(tooBig)[0], /Insufficient margin/);
  const reduce = await exchange.placeLimit({ coin: 'BTC', isBuy: false, sz: 0.001, px: 51_000, reduceOnly: true });
  assert.match(statuses(reduce)[0], /Reduce only/);
});

test('закрытие без позиции бросает ожидаемую исполнителем ошибку', async () => {
  await assert.rejects(() => exchange.closeMarket('BTC', undefined, 0.03), /No position found/);
});

test('закрытие без размера закрывает всю позицию', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  const closed = await exchange.closeMarket('BTC', undefined, 0.03);
  assert.equal(parseFloat(statuses(closed)[0].filled.avgPx), 49_999);
  assert.deepEqual(await exchange.getPositions(), []);
});

test('плечо уменьшает маржу', async () => {
  await paper.paperClient.exchange.updateLeverage('BTC-PERP', 'isolated', 5);
  const result = await exchange.openMarket('BTC', true, 0.009, 0.03);
  assert.ok(statuses(result)[0].filled);
});

test('стоп висит в ордерах в формате биржи и срабатывает тейкером', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  const placed = await exchange.placeTrigger({ coin: 'BTC', isBuy: false, sz: 0.001, px: 49_000, tpsl: 'sl' });
  const { oid } = statuses(placed)[0].resting;

  const [order] = await exchange.getFrontendOpenOrders();
  assert.equal(order.oid, oid);
  assert.equal(order.orderType, 'Stop Market');
  assert.equal(order.isTrigger, true);
  assert.equal(order.reduceOnly, true);

  assert.deepEqual(await moveAndMatch(49_500), []);
  const fills = await moveAndMatch(48_900);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].dir, 'Close Long');
  assert.equal(fills[0].oid, oid);
  assert.equal(fills[0].crossed, true);
  assert.equal(parseFloat(fills[0].px), 48_899);
  assert.deepEqual(await exchange.getPositions(), []);
  assert.deepEqual(await exchange.getFrontendOpenOrders(), []);
});

test('post-only отбивается, если пересекает книгу', async () => {
  const crossing = await exchange.placeLimit({ coin: 'BTC', isBuy: true, sz: 0.001, px: 50_002, reduceOnly: false });
  assert.match(statuses(crossing)[0], /Post only/);
});

test('лимитка наливается мейкером по своей цене', async () => {
  const placed = await exchange.placeLimit({ coin: 'BTC', isBuy: true, sz: 0.001, px: 49_000, reduceOnly: false });
  assert.ok(statuses(placed)[0].resting.oid);
  assert.deepEqual(await moveAndMatch(49_500), []);
  const fills = await moveAndMatch(48_900);
  assert.equal(parseFloat(fills[0].px), 49_000);
  assert.equal(fills[0].crossed, false);
  assert.equal(parseFloat(fills[0].fee), 0.001 * 49_000 * 0.00015);
});

test('цель няньки: reduce-only Gtc висит и наливается мейкером', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  const placed = await exchange.placeLimit({ coin: 'BTC', isBuy: false, sz: 0.001, px: 51_000, tif: 'Gtc', reduceOnly: true });
  assert.ok(statuses(placed)[0].resting.oid);
  const [order] = await exchange.getFrontendOpenOrders();
  assert.equal(order.orderType, 'Limit');
  assert.equal(order.isTrigger, false);

  const fills = await moveAndMatch(51_100);
  assert.equal(parseFloat(fills[0].px), 51_000);
  assert.equal(fills[0].crossed, false);
  assert.deepEqual(await exchange.getPositions(), []);
});

test('Gtc, пересёкший книгу, исполняется сразу, но не хуже своей цены', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  const result = await exchange.placeLimit({ coin: 'BTC', isBuy: false, sz: 0.001, px: 49_000, tif: 'Gtc', reduceOnly: true });
  const { filled } = statuses(result)[0];
  assert.equal(parseFloat(filled.avgPx), 49_999);
  assert.deepEqual(await exchange.getPositions(), []);
});

test('ордер с другим tif получает отказ', async () => {
  const result = await exchange.placeLimit({ coin: 'BTC', isBuy: true, sz: 0.001, px: 49_000, tif: 'Ioc', reduceOnly: false });
  assert.match(statuses(result)[0], /only Alo and Gtc/);
});

test('отменённый ордер не срабатывает', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  const placed = await exchange.placeTrigger({ coin: 'BTC', isBuy: false, sz: 0.001, px: 49_000, tpsl: 'sl' });
  await exchange.cancelOrderFor('BTC', statuses(placed)[0].resting.oid);
  assert.deepEqual(await moveAndMatch(48_000), []);
  assert.equal((await exchange.getPositions()).length, 1);
});

test('цель при живом стопе: после стопа зависшая цель снимается без филла', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  await exchange.placeTrigger({ coin: 'BTC', isBuy: false, sz: 0.001, px: 51_000, tpsl: 'tp' });
  await exchange.placeTrigger({ coin: 'BTC', isBuy: false, sz: 0.001, px: 49_000, tpsl: 'sl' });
  const fills = await moveAndMatch(48_500);
  assert.equal(fills.length, 1);
  assert.deepEqual(await exchange.getPositions(), []);
});

test('ликвидация закрывает изолированную позу с плечом', async () => {
  await paper.paperClient.exchange.updateLeverage('BTC-PERP', 'isolated', 10);
  await exchange.openMarket('BTC', true, 0.01, 0.03);
  const fills = await moveAndMatch(44_000);
  assert.equal(fills.length, 1);
  assert.ok(fills[0].liquidation);
  assert.deepEqual(await exchange.getPositions(), []);
});

test('фандинг начисляется раз в час и виден в userFunding', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  const saved = JSON.parse(readFileSync(accountFile(), 'utf-8'));
  saved.lastFundingHour -= 1;
  writeFileSync(accountFile(), JSON.stringify(saved));
  paper.stopPaperExchange();
  paper.startPaperExchange();

  await paper.runEngineOnce();
  await paper.runEngineOnce();
  const entries = await hlInfo({ type: 'userFunding', user: config.wallet.address, startTime: 0 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].delta.coin, 'BTC');
  assert.ok(parseFloat(entries[0].delta.usdc) < 0);
});

test('счёт переживает рестарт, битый файл не обнуляется молча', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  paper.stopPaperExchange();
  paper.startPaperExchange();
  assert.equal((await exchange.getPositions()).length, 1);

  writeFileSync(accountFile(), '{broken');
  paper.stopPaperExchange();
  assert.throws(() => paper.startPaperExchange());
  assert.ok(existsSync(accountFile()));
  rmSync(accountFile());
  paper.startPaperExchange();
});

test('сторонний DEX показывает пустой счёт: поза не задваивается', async () => {
  await exchange.openMarket('BTC', true, 0.001, 0.03);
  const state = await hlInfo({ type: 'clearinghouseState', user: config.wallet.address, dex: 'mkts' });
  assert.deepEqual(state.assetPositions, []);
});

test('заголовок уведомления получает метку один раз', () => {
  assert.equal(paperTitle('LONG #BTC opened'), 'PAPER · LONG #BTC opened');
  assert.equal(paperTitle(paperTitle('LONG #BTC opened')), 'PAPER · LONG #BTC opened');
});

test('чужой адрес и рыночные чтения идут на биржу мимо счёта', async () => {
  const other = await hlInfo({ type: 'allMids' });
  assert.equal(other.BTC, '50000');
  assert.equal(networkBodies.at(-1).type, 'allMids');
});
