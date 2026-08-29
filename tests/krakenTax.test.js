// Kraken → PIT-38: нормализация ассетов, сборка пар из ledger'а, классификация.
//
// Why (29.08.2026): Binance ушёл из Польши 1.07, ledger не пополнялся с 6 июня,
// и записи пришлось бы вбивать руками. Здесь проверяется то, что ломается молча
// и обнаруживается только в апреле у księgowej:
//   • legacy-коды Kraken (ZEUR/XXBT) и стейкинг-суффиксы,
//   • пара нога-к-ноге по refid, включая частичные исполнения,
//   • знак комиссии: на покупке она увеличивает расход, на продаже режет выручку,
//   • крипта↔крипта не попадает в PIT-38.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

// krakenClient тянет config (ключи биржи), а тот отказывается грузиться без
// приватного ключа вне NODE_ENV=test. npm test его выставляет, но одиночный
// `node --test tests/krakenTax.test.js` — нет; заполняем сами, как в hunterSizing.
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.HL_PRIVATE_KEY        = '0x0000000000000000000000000000000000000000000000000000000000000001';

const { normalizeAsset, pairLedgerEntries, sign } = await import('../src/modules/taxCollector/krakenClient.js');
const { classifyEvent, FIAT_CURRENCIES } = await import('../src/modules/taxCollector/classifier.js');

// ── Нормализация ассетов ──────────────────────────
test('legacy-префиксы Kraken срезаются только у 4-символьных кодов', () => {
  assert.equal(normalizeAsset('ZEUR'), 'EUR');
  assert.equal(normalizeAsset('ZUSD'), 'USD');
  assert.equal(normalizeAsset('XETH'), 'ETH');
  assert.equal(normalizeAsset('USDC'), 'USDC');
});

test('XXBT → BTC (Kraken зовёт биткоин XBT)', () => {
  assert.equal(normalizeAsset('XXBT'), 'BTC');
  assert.equal(normalizeAsset('XBT'), 'BTC');
});

test('тикеры на X/Z длиной ≠4 НЕ калечатся', () => {
  // Регрессия: наивное «срезать первую букву» превратило бы ZRO в RO,
  // а XCN в CN — и монета уехала бы в отчёт под чужим именем.
  assert.equal(normalizeAsset('ZRO'), 'ZRO');
  assert.equal(normalizeAsset('XCN'), 'XCN');
  assert.equal(normalizeAsset('ZEUS'), 'ZEUS');
});

test('стейкинг-суффиксы отбрасываются', () => {
  assert.equal(normalizeAsset('USDC.S'), 'USDC');
  assert.equal(normalizeAsset('ETH.M'), 'ETH');
  assert.equal(normalizeAsset('DOT.S'), 'DOT');
});

// ── Сборка пар ────────────────────────────────────
const leg = (o) => ({ refid: 'R1', type: 'trade', time: 1_756_000_000, fee: '0', ...o });

test('покупка USDC за EUR → одна пара, isBuy=true', () => {
  const out = pairLedgerEntries([
    leg({ asset: 'ZEUR', amount: '-100.00', fee: '0.25' }),
    leg({ asset: 'USDC', amount: '107.94' }),
  ], FIAT_CURRENCIES);

  assert.equal(out.length, 1);
  assert.equal(out[0].fiatAsset, 'EUR');
  assert.equal(out[0].cryptoAsset, 'USDC');
  assert.equal(out[0].fiatAmount, 100);
  assert.equal(out[0].fiatFee, 0.25);
  assert.equal(out[0].isBuy, true);
});

test('продажа USDC за EUR → isBuy=false', () => {
  const out = pairLedgerEntries([
    leg({ asset: 'ZEUR', amount: '100.00', fee: '0.25' }),
    leg({ asset: 'USDC', amount: '-107.94' }),
  ], FIAT_CURRENCIES);

  assert.equal(out.length, 1);
  assert.equal(out[0].isBuy, false);
});

test('Instant Buy (spend/receive) ловится наравне с обычной сделкой', () => {
  // Ради этого и взят Ledgers вместо TradesHistory: TradesHistory такую
  // покупку не показывает вовсе.
  const out = pairLedgerEntries([
    leg({ type: 'spend', asset: 'ZEUR', amount: '-50.00', fee: '0.75' }),
    leg({ type: 'receive', asset: 'USDC', amount: '53.10' }),
  ], FIAT_CURRENCIES);

  assert.equal(out.length, 1);
  assert.equal(out[0].isBuy, true);
  assert.equal(out[0].fiatFee, 0.75);
});

test('частичные исполнения одного ордера складываются в ОДНУ сделку', () => {
  const out = pairLedgerEntries([
    leg({ asset: 'ZEUR', amount: '-60.00', fee: '0.15' }),
    leg({ asset: 'ZEUR', amount: '-40.00', fee: '0.10' }),
    leg({ asset: 'USDC', amount: '64.00' }),
    leg({ asset: 'USDC', amount: '43.00' }),
  ], FIAT_CURRENCIES);

  assert.equal(out.length, 1, 'один refid = одна сделка, а не четыре огрызка');
  assert.equal(out[0].fiatAmount, 100);
  assert.ok(Math.abs(out[0].fiatFee - 0.25) < 1e-9);
  assert.equal(out[0].cryptoAmount, 107);
});

test('крипта↔крипта в PIT-38 не идёт', () => {
  const out = pairLedgerEntries([
    leg({ asset: 'USDC', amount: '-100.00' }),
    leg({ asset: 'XXBT', amount: '0.0015' }),
  ], FIAT_CURRENCIES);
  assert.equal(out.length, 0);
});

test('депозит фиата — не налоговое событие (нет второй ноги)', () => {
  const out = pairLedgerEntries([
    leg({ type: 'deposit', asset: 'ZEUR', amount: '500.00' }),
  ], FIAT_CURRENCIES);
  assert.equal(out.length, 0);
});

test('разные refid не склеиваются в одну сделку', () => {
  const out = pairLedgerEntries([
    leg({ refid: 'A', asset: 'ZEUR', amount: '-100.00' }),
    leg({ refid: 'A', asset: 'USDC', amount: '107.00' }),
    leg({ refid: 'B', asset: 'ZEUR', amount: '-50.00' }),
    leg({ refid: 'B', asset: 'USDC', amount: '53.00' }),
  ], FIAT_CURRENCIES);
  assert.equal(out.length, 2);
});

// ── Классификация ─────────────────────────────────
test('COST = сумма + комиссия (prowizja входит в koszt)', () => {
  const c = classifyEvent({
    _source: 'kraken_trade',
    refid: 'R1', time: 1_756_000_000,
    fiatAsset: 'EUR', fiatAmount: 100, fiatFee: 0.25,
    cryptoAsset: 'USDC', cryptoAmount: 107.94, isBuy: true,
  });

  assert.equal(c.type, 'COST');
  assert.equal(c.fiat_val, 100.25, 'на покупке из кармана уходит сумма + комиссия');
  assert.equal(c.fiat_currency, 'EUR');
  assert.equal(c.asset, 'USDC');
  assert.equal(c.tx_id, 'kraken_R1');
});

test('REVENUE = сумма − комиссия', () => {
  const c = classifyEvent({
    _source: 'kraken_trade',
    refid: 'R2', time: 1_756_000_000,
    fiatAsset: 'EUR', fiatAmount: 100, fiatFee: 0.25,
    cryptoAsset: 'USDC', cryptoAmount: 107.94, isBuy: false,
  });

  assert.equal(c.type, 'REVENUE');
  assert.equal(c.fiat_val, 99.75, 'на продаже комиссия режет выручку');
});

test('tx_id стабилен между прогонами — дедуп в ledger сработает', () => {
  const mk = () => classifyEvent({
    _source: 'kraken_trade',
    refid: 'SAME', time: 1_756_000_000,
    fiatAsset: 'EUR', fiatAmount: 10, fiatFee: 0,
    cryptoAsset: 'USDC', cryptoAmount: 10.8, isBuy: true,
  });
  assert.equal(mk().tx_id, mk().tx_id);
});

test('время Kraken в СЕКУНДАХ конвертируется в ISO корректно', () => {
  // Забыть ×1000 — классическая ошибка: дата уехала бы в 1970-й, и NBP-курс
  // подтянулся бы не тот (или не подтянулся вовсе).
  const c = classifyEvent({
    _source: 'kraken_trade',
    refid: 'R3', time: 1_756_000_000,
    fiatAsset: 'EUR', fiatAmount: 10, fiatFee: 0,
    cryptoAsset: 'USDC', cryptoAmount: 10.8, isBuy: true,
  });
  assert.equal(c.date, new Date(1_756_000_000_000).toISOString());
  assert.ok(c.date.startsWith('2025-'), `ожидали 2025 год, получили ${c.date}`);
});

test('неизвестный фиат (не USD/EUR/PLN) отбрасывается', () => {
  const c = classifyEvent({
    _source: 'kraken_trade',
    refid: 'R4', time: 1_756_000_000,
    fiatAsset: 'JPY', fiatAmount: 1000, fiatFee: 0,
    cryptoAsset: 'USDC', cryptoAmount: 6.7, isBuy: true,
  });
  assert.equal(c, null);
});

// ── Подпись ───────────────────────────────────────
test('API-Sign совпадает с официальным вектором Kraken', () => {
  // Вектор из документации Kraken (REST Authentication). Без живого ключа это
  // единственный способ отличить рабочую подпись от опечатки: сервер на любую
  // ошибку отвечает одинаковым 'EAPI:Invalid signature'.
  const apiSecret =
    'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
  const nonce = '1616492376594';
  const path = '/0/private/AddOrder';
  const postdata =
    'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';

  assert.equal(
    sign(path, postdata, nonce, apiSecret),
    '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==',
  );
});
