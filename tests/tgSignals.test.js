// Разбор постов сигнальных TG-каналов: монета, сторона, отсев витрины.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePost, parsePosts, normalizeCoin, knownChannels } from '../src/modules/tgSignals.js';

// ── normalizeCoin ───────────────────────────────────────────────────────────

test('снимает котируемую валюту, решётку и хвост перпа', () => {
  assert.equal(normalizeCoin('#KITE/USDT'), 'KITE');
  assert.equal(normalizeCoin('$ADA/USDT'), 'ADA');
  assert.equal(normalizeCoin('btc-perp'), 'BTC');
  assert.equal(normalizeCoin('SOLUSDT'), 'SOL');
});

test('1000-нотация каналов приводится к k-нотации Hyperliquid', () => {
  // 🚨 На HL строчная k (kSHIB, не KSHIB) — см. kcoin_api_naming.
  assert.equal(normalizeCoin('1000PEPE/USDT'), 'kPEPE');
  assert.equal(normalizeCoin('1000SHIB'), 'kSHIB');
});

test('мусор не превращается в монету', () => {
  assert.equal(normalizeCoin(''), null);
  assert.equal(normalizeCoin('B'), null);
  assert.equal(normalizeCoin('очень длинный тикер'), null);
});

// ── cryptoclubpumps ─────────────────────────────────────────────────────────

const CLUB_LONG = `#KITE/USDT
#LONG
ENTRY: 0.13730
LEVERAGE: ISOLATED 10X - 75X
TARGETS:
1) 0.13950
STOPLOSS: 0.12950`;

test('берёт монету и сторону, игнорируя вход/цели/стоп канала', () => {
  assert.deepEqual(parsePost('cryptoclubpumps', CLUB_LONG), { coin: 'KITE', side: 'long' });
});

test('SHORT и вариант с ZONE вместо ENTRY разбираются так же', () => {
  const short = '#LA/USDT\n#SHORT\nZONE: 0.06680 - 0.06710\nSTOPLOSS: 0.07110';
  assert.deepEqual(parsePost('cryptoclubpumps', short), { coin: 'LA', side: 'short' });
});

// 🚨 Главный отсев: канал цитирует исходный сигнал в посте-отчёте. Без него
// один сигнал открывал бы позу дважды, второй раз — задним числом.
test('пост-отчёт с процитированным сигналом не считается сигналом', () => {
  const showcase = `${CLUB_LONG}

#KITE/USDT
All targets achieved 😎
Profit: 155.8024% 📈
Period: 5 hr`;
  assert.equal(parsePost('cryptoclubpumps', showcase), null);
});

test('витрина без цитаты тоже отсеивается', () => {
  assert.equal(parsePost('cryptoclubpumps', '#INIT up 23% so far ✅'), null);
  assert.equal(parsePost('cryptoclubpumps', '#BTC Target 1: HIT ✅ (+43% gain)'), null);
});

// ── CryptoVIPsignal ─────────────────────────────────────────────────────────

test('повелительная форма даёт сторону, прогноз-рассуждение — нет', () => {
  assert.deepEqual(
    parsePost('CryptoVIPsignal', 'Buying #BICO here on Binance:\nShort-term targets: 10%-30%'),
    { coin: 'BICO', side: 'long' },
  );
  // «Мы откроем лонг после подтверждения» — намерения не торгуем.
  assert.equal(
    parsePost('CryptoVIPsignal', 'ZK analysis: Price is breaking out. We will open a long position after confirmation.'),
    null,
  );
});

// ── общее ───────────────────────────────────────────────────────────────────

test('незнакомый канал не разбирается вслепую чужим шаблоном', () => {
  assert.equal(parsePost('SomeOtherChannel', CLUB_LONG), null);
  assert.ok(knownChannels().includes('cryptoclubpumps'));
});

test('парсер пачки: только распознанное, по возрастанию id, с временем', () => {
  const posts = [
    { id: 3, ts: '2026-09-02T12:34:07+00:00', text: CLUB_LONG },
    { id: 2, ts: '2026-09-02T11:00:00+00:00', text: 'GM everyone, market looks nice' },
    { id: 1, ts: '2026-09-02T10:00:00+00:00', text: '#LA/USDT\n#SHORT\nENTRY: 0.0668' },
  ];
  const out = parsePosts('cryptoclubpumps', posts);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.postId), [1, 3]);
  assert.equal(out[0].coin, 'LA');
  assert.equal(out[1].postedAt, Date.parse('2026-09-02T12:34:07+00:00'));
});

test('пост без времени пропускается — время входа обязано быть настоящим', () => {
  assert.deepEqual(parsePosts('cryptoclubpumps', [{ id: 1, ts: null, text: CLUB_LONG }]), []);
});
