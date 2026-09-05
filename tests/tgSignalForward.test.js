// Форвард по чужим прогнозам: отбор сигналов и арифметика бумажного выхода.
//
// Why: замер по чужому каналу ломается двумя способами — торгуем несвежий пост
// (исход уже известен) или считаем результат не тем, чем он есть. Оба разреза
// закрыты здесь; сеть и БД в тестах не участвуют.
//
// Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { judgeSignal } = await import('../src/app/tgSignalWatch.js');
const { planPaperExit } = await import('../src/modules/paperEntry.js');
const { blendPaperResult } = await import('../src/app/manualPaperSupervise.js');
const { parseChannelHtml } = await import('../src/modules/tgSignalFeed.js');
const { FEE_RATE, MAKER_FEE_RATE } = await import('../src/modules/executor/math.js');

const NOW = Date.parse('2026-09-05T12:00:00Z');
const base = {
  now: NOW,
  maxAgeMin: 30,
  tradable: true,
  duplicate: false,
  openSameCoin: false,
  slotsUsed: 0,
  maxSlots: 10,
};
const freshPost = { postedAt: NOW - 2 * 60_000 };

// ── Отбор сигнала ───────────────────────────────────────────────────────────

test('свежий пост по монете с HL проходит', () => {
  assert.deepEqual(judgeSignal(freshPost, base), { ok: true });
});

// 🚨 Главный предохранитель: лента канала отдаёт два десятка постов разом, и
// без потолка первый запуск открыл бы позы по прогнозам с известным исходом.
test('несвежий пост не торгуется — это подглядывание, а не замер', () => {
  const v = judgeSignal({ postedAt: NOW - 3 * 3_600_000 }, base);
  assert.equal(v.ok, false);
  assert.match(v.reason, /stale \(180 min\)/);
});

test('пост из будущего тоже отвергается — часы канала врут', () => {
  const v = judgeSignal({ postedAt: NOW + 30 * 60_000 }, base);
  assert.equal(v.ok, false);
  assert.match(v.reason, /future/);
});

test('монеты нет на Hyperliquid — торговать нечем', () => {
  const v = judgeSignal(freshPost, { ...base, tradable: false });
  assert.equal(v.ok, false);
  assert.match(v.reason, /Hyperliquid/);
});

test('повтор того же прогноза не даёт каналу двойной вес', () => {
  const v = judgeSignal(freshPost, { ...base, duplicate: true });
  assert.equal(v.ok, false);
  assert.match(v.reason, /already open/);
});

test('слоты кончились — отказ с явной причиной, а не тихий пропуск', () => {
  const v = judgeSignal(freshPost, { ...base, slotsUsed: 10 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /slot limit \(10\)/);
});

// ── План выхода ─────────────────────────────────────────────────────────────

test('LONG: стоп ниже входа, цель выше, RR=1 держит симметрию', () => {
  const p = planPaperExit({ side: 'long', entry: 100, stopDistPct: 3, sizeUsd: 10 });
  assert.equal(p.slPrice, 97);
  assert.equal(p.tpPrice, 103);
});

test('SHORT: стоп и цель зеркальны', () => {
  const p = planPaperExit({ side: 'short', entry: 100, stopDistPct: 4, sizeUsd: 10 });
  assert.equal(p.slPrice, 104);
  assert.equal(p.tpPrice, 96);
});

test('сетка выключена по умолчанию — ступеней нет', () => {
  assert.deepEqual(planPaperExit({ side: 'long', entry: 100, stopDistPct: 3, sizeUsd: 10 }).rungs, []);
});

// ── Итог сделки ─────────────────────────────────────────────────────────────

const pos = { side: 'long', entry_price: 100, size_usd: 10, entry_apy: 0 };

test('без ступеней итог равен обычному расчёту по всей позе', () => {
  const r = blendPaperResult({ pos, legs: [], fillPrice: 103, holdHours: 1, exitFeeRate: MAKER_FEE_RATE });
  assert.equal(r.remaining, 10);
  // +3% от $10 = $0.30 минус комиссии входа (taker) и выхода (maker).
  const expectedFee = 10 * (FEE_RATE + MAKER_FEE_RATE);
  assert.ok(Math.abs(r.totalFee - expectedFee) < 1e-12);
  assert.ok(Math.abs(r.realizedPnl - (0.3 - expectedFee)) < 1e-12);
});

// 🚨 Двойной счёт комиссии входа — ровно та ошибка, из-за которой бумага
// рисовала бы лучше или хуже биржи. Сумма по кускам обязана сойтись с целым.
test('ступени и остаток вместе платят комиссию входа ровно один раз', () => {
  const legs = [{ r: 1, usd: 4, px: 103, pnl: 0.12 - 4 * (FEE_RATE + MAKER_FEE_RATE) }];
  const r = blendPaperResult({ pos, legs, fillPrice: 106, holdHours: 1, exitFeeRate: MAKER_FEE_RATE });
  assert.equal(r.remaining, 6);
  const entryFeeTotal = 10 * FEE_RATE;
  const exitFeeTotal = 10 * MAKER_FEE_RATE;
  assert.ok(Math.abs(r.totalFee - (entryFeeTotal + exitFeeTotal)) < 1e-12);
});

test('забранная ступень не считается ещё раз в остатке', () => {
  const legPnl = 0.2;
  const legs = [{ r: 1, usd: 5, px: 104, pnl: legPnl }];
  const r = blendPaperResult({ pos, legs, fillPrice: 100, holdHours: 1 });
  // Остаток $5 закрыт по входу → его ценовой PnL 0, остаётся только его комиссия.
  const tailFee = 5 * (FEE_RATE + FEE_RATE);
  assert.ok(Math.abs(r.realizedPnl - (legPnl - tailFee)) < 1e-12);
});

// ── Разбор страницы канала ──────────────────────────────────────────────────

test('страница канала режется по постам, время берётся из <time>', () => {
  const html = `
    <div data-post="chan/10"><time datetime="2026-09-05T10:00:00+00:00"></time>
      <div class="tgme_widget_message_text js-message_text">#LA/USDT<br>#SHORT</div>
      <div class="tgme_widget_message_footer"></div></div>
    <div data-post="chan/11"><time datetime="2026-09-05T11:00:00+00:00"></time>
      <div class="tgme_widget_message_text js-message_text">gm</div>
      <div class="tgme_widget_message_footer"></div></div>`;
  const posts = parseChannelHtml(html);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, 10);
  assert.equal(posts[0].ts, '2026-09-05T10:00:00+00:00');
  assert.match(posts[0].text, /#LA\/USDT/);
});

test('пост без текста не роняет разбор — картинка тоже пост', () => {
  const posts = parseChannelHtml('<div data-post="chan/12"><time datetime="2026-09-05T10:00:00+00:00"></time></div>');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, '');
});
