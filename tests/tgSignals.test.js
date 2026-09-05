// Разбор постов сигнальных TG-каналов: монета, сторона, отсев витрины.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePost, parsePosts, normalizeCoin, knownFormats } from '../src/modules/tgSignals.js';

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

// ── hashtag-block ───────────────────────────────────────────────────────────

const HASHTAG_BLOCK = `#KITE/USDT
#LONG
ENTRY: 0.13730
LEVERAGE: ISOLATED 10X - 75X
TARGETS:
1) 0.13950
STOPLOSS: 0.12950`;

test('берёт монету и сторону, игнорируя вход/цели/стоп канала', () => {
  assert.deepEqual(parsePost(HASHTAG_BLOCK), { coin: 'KITE', side: 'long', format: 'hashtag-block' });
});

test('SHORT и вариант с ZONE вместо ENTRY разбираются так же', () => {
  const short = '#LA/USDT\n#SHORT\nZONE: 0.06680 - 0.06710\nSTOPLOSS: 0.07110';
  assert.deepEqual(parsePost(short), { coin: 'LA', side: 'short', format: 'hashtag-block' });
});

// 🚨 Главный отсев: канал цитирует исходный сигнал в посте-отчёте. Без него
// один сигнал открывал бы позу дважды, второй раз — задним числом.
test('пост-отчёт с процитированным сигналом не считается сигналом', () => {
  const showcase = `${HASHTAG_BLOCK}

#KITE/USDT
All targets achieved 😎
Profit: 155.8024% 📈
Period: 5 hr`;
  assert.equal(parsePost(showcase), null);
});

test('витрина без цитаты тоже отсеивается', () => {
  assert.equal(parsePost('#INIT up 23% so far ✅'), null);
  assert.equal(parsePost('#BTC Target 1: HIT ✅ (+43% gain)'), null);
});

// ── imperative ──────────────────────────────────────────────────────────────

test('повелительная форма даёт сторону, прогноз-рассуждение — нет', () => {
  assert.deepEqual(
    parsePost('Buying #BICO here on Binance:\nShort-term targets: 10%-30%'),
    { coin: 'BICO', side: 'long', format: 'imperative' },
  );
  // «Мы откроем лонг после подтверждения» — намерения не торгуем.
  assert.equal(
    parsePost('ZK analysis: Price is breaking out. We will open a long position after confirmation.'),
    null,
  );
});

// ── общее ───────────────────────────────────────────────────────────────────

test('проза без структуры сигналом не считается', () => {
  assert.equal(parsePost('BTC is following Gold and looks ready for another leg up.'), null);
  assert.equal(parsePost('We are currently holding only swing shorts (BTC, ETH) due to the setup.'), null);
  assert.ok(knownFormats().length >= 4);
});

test('парсер пачки: только распознанное, по возрастанию id, с временем', () => {
  const posts = [
    { id: 3, ts: '2026-09-02T12:34:07+00:00', text: HASHTAG_BLOCK },
    { id: 2, ts: '2026-09-02T11:00:00+00:00', text: 'GM everyone, market looks nice' },
    { id: 1, ts: '2026-09-02T10:00:00+00:00', text: '#LA/USDT\n#SHORT\nENTRY: 0.0668' },
  ];
  const out = parsePosts('somechannel', posts);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.postId), [1, 3]);
  assert.equal(out[0].coin, 'LA');
  assert.equal(out[1].postedAt, Date.parse('2026-09-02T12:34:07+00:00'));
});

test('пост без времени пропускается — время входа обязано быть настоящим', () => {
  assert.deepEqual(parsePosts('somechannel', [{ id: 1, ts: null, text: HASHTAG_BLOCK }]), []);
});

// ── side-first: «➡️ SHORT ETHUSDT» ──────────────────────────────────────────

const SIDE_FIRST = `➡️ SHORT ETHUSDT

❇️ Entry: 2497.00000000 - 2625.00000000
☑️ Target 1: 2375.00000000
⛔ Stoploss: 2700.000000
💫 Leverage : 10x`;

test('сторона впереди тикера разбирается, эмодзи в начале не мешает', () => {
  assert.deepEqual(parsePost(SIDE_FIRST), { coin: 'ETH', side: 'short', format: 'side-first' });
});

// 🚨 USDT в тикере обязателен: иначе «short term bearish» из рыночной прозы
// открыло бы позу по монете TERM.
test('проза со словом short не становится сигналом', () => {
  assert.equal(parsePost('US Treasury yields jump.\nShort term bearish for all markets.'), null);
  assert.equal(parsePost('We are long term bullish on ETH here.'), null);
});

// Форматы опознаются автоматически, поэтому важно, что они не спорят друг с
// другом: пост одного формата не должен разбираться другим.
test('форматы не перехватывают чужие посты', () => {
  const LABELLED = 'COIN: $XRP/USDT\nDirection: LONG\nENTRY: 1.290 - 1.300';
  const cases = [
    [HASHTAG_BLOCK, 'hashtag-block'],
    [SIDE_FIRST, 'side-first'],
    [LABELLED, 'labelled-card'],
    ['Buying #BICO here on Binance', 'imperative'],
  ];
  for (const [text, format] of cases) assert.equal(parsePost(text).format, format);
});
