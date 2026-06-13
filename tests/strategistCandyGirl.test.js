// Тесты радара Candy Girl: лента сигналов, дедуп, кап за тик, никогда не торгует.
// TG-алерты выключаем через env ДО импорта модуля (config читается один раз).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── ENV до импорта модуля (config читается один раз) ─────────────────────
process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.ENTRY_APY_THRESHOLD   = '40';
process.env.MIN_APY_THRESHOLD     = '20';
process.env.EXIT_BUFFER           = '5';
process.env.MIN_HOLD_TIME_MINUTES = '60';
process.env.BREATHING_MINUTES     = '30';
process.env.LEVERAGE              = '1';
process.env.CANDY_GIRL_ENABLED = 'true';
process.env.CANDY_GIRL_ALERT_ENABLED = 'false';   // не дёргать reporter/сеть
process.env.CANDY_GIRL_HTF_CONFLUENCE = 'false';  // 4h-фильтр тестим на уровне детектора (без сети)
process.env.CANDY_GIRL_SIGNAL_LOG_ENABLED = 'false'; // без БД в этих тестах

const {
  scanCandyGirlRadar, getCandyGirlSignals, getCandyGirlHeartbeat, resetCandyGirlState,
  scoreCandySignal, getCandyGirlRankedHits, analyzeCandyGirl,
} = await import('../src/modules/strategistCandyGirl.js');

// ── Helpers: фабрики свечей под нужный сигнал ───
function candle(close, spread = 1.5) {
  return { high: close + spread / 2, low: close - spread / 2, close };
}
function fromCloses(closes) { return closes.map((c) => candle(c)); }
function rising(n, start, step) { return Array.from({ length: n }, (_, i) => start + i * step); }

// 1h up-тренд + 5m pullback-reclaim → LONG-сигнал для монеты.
function longSetup1h() { return fromCloses(rising(230, 100, 0.5)); }
function longSetup5m() {
  const base = rising(23, 200, 0.4);
  return fromCloses([...base, 206, 204, 203, 202, 212]);
}
// Нет сетапа: плоский 1h → trend none.
function flat1h() { return fromCloses(Array(230).fill(100)); }

beforeEach(() => resetCandyGirlState());

test('radar: пишет LONG-сигнал в ленту при up-тренде + reclaim', async () => {
  const scoutData = [{ coin: 'AAA', price: 215.5 }];
  const ret = await scanCandyGirlRadar(
    scoutData, Date.now(),
    async () => longSetup1h(),
    async () => longSetup5m(),
  );
  assert.equal(ret, undefined, 'радар НИКОГДА не возвращает торговое решение (OPEN)');
  const sigs = getCandyGirlSignals();
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].coin, 'AAA');
  assert.equal(sigs[0].direction, 'LONG');
  assert.ok(sigs[0].sl < sigs[0].entry);
  assert.ok(sigs[0].tp > sigs[0].entry);
});

test('radar: нет сетапа (плоский 1h) → лента пуста', async () => {
  const scoutData = [{ coin: 'BBB', price: 100 }];
  await scanCandyGirlRadar(scoutData, Date.now(), async () => flat1h(), async () => longSetup5m());
  assert.equal(getCandyGirlSignals().length, 0);
});

test('radar: дедуп per-coin внутри cooldown — повторный скан не плодит дубль', async () => {
  const scoutData = [{ coin: 'AAA', price: 215.5 }];
  const now = Date.now();
  await scanCandyGirlRadar(scoutData, now, async () => longSetup1h(), async () => longSetup5m());
  await scanCandyGirlRadar(scoutData, now + 1000, async () => longSetup1h(), async () => longSetup5m());
  assert.equal(getCandyGirlSignals().length, 1, 'дедуп должен подавить повторную запись');
});

test('radar: кап MAX_SIGNALS_PER_TICK ограничивает число записей за тик', async () => {
  // 5 монет с валидным сетапом, дефолтный кап = 3.
  const coins = ['C1', 'C2', 'C3', 'C4', 'C5'];
  const scoutData = coins.map((coin) => ({ coin, price: 215.5 }));
  await scanCandyGirlRadar(scoutData, Date.now(), async () => longSetup1h(), async () => longSetup5m());
  assert.equal(getCandyGirlSignals().length, 3);
});

test('radar: heartbeat отражает tracked/trending/signals', async () => {
  const scoutData = [{ coin: 'AAA', price: 215.5 }, { coin: 'BBB', price: 100 }];
  await scanCandyGirlRadar(
    scoutData, Date.now(),
    async (coin) => (coin === 'AAA' ? longSetup1h() : flat1h()),
    async () => longSetup5m(),
  );
  const hb = getCandyGirlHeartbeat();
  assert.equal(hb.tracked, 2);
  assert.equal(hb.trending, 1);
  assert.equal(hb.signals, 1);
});

test('radar: монета без свечей (fetch=null) → пропуск, без падения', async () => {
  const scoutData = [{ coin: 'AAA', price: 215.5 }];
  await scanCandyGirlRadar(scoutData, Date.now(), async () => null, async () => null);
  assert.equal(getCandyGirlSignals().length, 0);
});

// ── Ранжировщик одновременных сигналов (scoreCandySignal) ──────────────────

test('score: 4h-confluence доминирует над силой 1h-тренда', () => {
  // Выровненный 4h, но слабый 1h-разрыв...
  const aligned = scoreCandySignal({ signal: 'long', trend4h: 'up', emaFast1h: 101, emaSlow1h: 100 });
  // ...vs не-выровненный 4h с очень сильным 1h-разрывом.
  const notAligned = scoreCandySignal({ signal: 'long', trend4h: 'none', emaFast1h: 130, emaSlow1h: 100 });
  assert.ok(aligned > notAligned, `aligned ${aligned} должен быть выше ${notAligned}`);
});

test('score: при равном confluence — шире EMA-разрыв выигрывает', () => {
  const wide = scoreCandySignal({ signal: 'short', trend4h: 'down', emaFast1h: 95, emaSlow1h: 100 });
  const narrow = scoreCandySignal({ signal: 'short', trend4h: 'down', emaFast1h: 99, emaSlow1h: 100 });
  assert.ok(wide > narrow);
});

test('score: нет сигнала → -Infinity', () => {
  assert.equal(scoreCandySignal({ signal: null }), -Infinity);
  assert.equal(scoreCandySignal(null), -Infinity);
});

test('score: short выровнен только с trend4h=down (не up)', () => {
  const right = scoreCandySignal({ signal: 'short', trend4h: 'down', emaFast1h: 99, emaSlow1h: 100 });
  const wrong = scoreCandySignal({ signal: 'short', trend4h: 'up', emaFast1h: 99, emaSlow1h: 100 });
  assert.ok(right > wrong);
});

test('rank: getCandyGirlRankedHits отдаёт сигналы отсортированными по score', () => {
  resetCandyGirlState();
  // Два LONG-сетапа на разных монетах: у BBB разрыв EMA шире → должен быть первым.
  const hourlyByCoin = {
    AAA: fromCloses(rising(230, 100, 0.3)),   // умеренный наклон
    BBB: fromCloses(rising(230, 100, 0.9)),   // крутой наклон → шире EMA-разрыв
  };
  const scoutData = [{ coin: 'AAA', price: 215.5 }, { coin: 'BBB', price: 290 }];
  return scanCandyGirlRadar(
    scoutData, Date.now(),
    async (coin) => hourlyByCoin[coin],
    async () => longSetup5m(),
  ).then(() => {
    const { hits } = getCandyGirlRankedHits();
    assert.ok(hits.length >= 1, 'должен быть хотя бы один сигнал');
    if (hits.length === 2) {
      assert.ok(hits[0].score >= hits[1].score, 'первый score ≥ второго');
    }
  });
});

// ── Iter 2: paper-слот decision (analyzeCandyGirl) ─────────────────────────

/** Прогнать радар по одному LONG-сетапу, вернуть now скана. */
async function seedLongHit(coin = 'AAA', price = 215.5) {
  const now = Date.now();
  await scanCandyGirlRadar(
    [{ coin, price }], now,
    async () => longSetup1h(),
    async () => longSetup5m(),
  );
  return now;
}

test('analyze: слот свободен + свежий хит → OPEN лучшего сигнала', async () => {
  resetCandyGirlState();
  const now = await seedLongHit('AAA', 215.5);
  const sig = analyzeCandyGirl([{ coin: 'AAA', price: 215.5 }], null, now);
  assert.equal(sig.action, 'OPEN');
  assert.equal(sig.strategy_id, 'candy_girl');
  assert.equal(sig.coin, 'AAA');
  assert.equal(sig.direction, 'LONG');
  assert.ok(sig.sl < sig.price && sig.tp > sig.price);
});

// 1h down-тренд + 5m bounce-reclaim вниз → SHORT-сигнал.
function shortSetup1h() { return fromCloses(rising(230, 420, -1)); }   // down-тренд, заканчивается ~191
function shortSetup5m() {
  const base = rising(23, 200, -0.4);                                   // 200 → ~191
  return fromCloses([...base, 194, 196, 197, 198, 188]);               // bounce вверх → reclaim вниз
}

test('long-only: радар пишет SHORT, но paper-слот его НЕ открывает (HOLD)', async () => {
  resetCandyGirlState();
  const now = Date.now();
  await scanCandyGirlRadar(
    [{ coin: 'SSS', price: 188 }], now,
    async () => shortSetup1h(),
    async () => shortSetup5m(),
  );
  // Радар обязан зафиксировать SHORT (accuracy-логгер мерит обе стороны).
  const sigs = getCandyGirlSignals();
  assert.equal(sigs.length, 1, 'радар должен записать сигнал');
  assert.equal(sigs[0].direction, 'SHORT');
  // …но paper-слот при long-only короткую сторону пропускает.
  const sig = analyzeCandyGirl([{ coin: 'SSS', price: 188 }], null, now);
  assert.equal(sig.action, 'HOLD', 'long-only: short не открывается в paper-слот');
});

test('analyze: протухшие ранжированные хиты → HOLD', async () => {
  resetCandyGirlState();
  const now = await seedLongHit('AAA');
  // 5 минут спустя хиты считаются устаревшими (> RANKED_HITS_MAX_AGE_MS).
  const sig = analyzeCandyGirl([{ coin: 'AAA', price: 215.5 }], null, now + 5 * 60_000);
  assert.equal(sig.action, 'HOLD');
});

test('analyze: нет хитов вообще → HOLD', () => {
  resetCandyGirlState();
  const sig = analyzeCandyGirl([{ coin: 'AAA', price: 100 }], null, Date.now());
  assert.equal(sig.action, 'HOLD');
});

test('analyze: чужая поза в слоте → HOLD (не эвиктим)', () => {
  resetCandyGirlState();
  const sig = analyzeCandyGirl([], { strategy_id: 'trend_follow', coin: 'XXX' }, Date.now());
  assert.equal(sig.action, 'HOLD');
});

// LONG paper-поза: entry 100, sl 95, tp 110.
function longPos(overrides = {}) {
  return {
    strategy_id: 'candy_girl', coin: 'AAA', side: 'long',
    entry_price: 100, sl_price: 95, tp_price: 110,
    entry_time: Date.now(), ...overrides,
  };
}

test('exit: LONG цена ≥ TP → CLOSE candy_girl_tp по tp_price', () => {
  resetCandyGirlState();
  const sig = analyzeCandyGirl([{ coin: 'AAA', price: 111 }], longPos(), Date.now());
  assert.equal(sig.action, 'CLOSE');
  assert.equal(sig.reason, 'candy_girl_tp');
  assert.equal(sig.price, 110);
});

test('exit: LONG цена ≤ SL → CLOSE candy_girl_sl по sl_price', () => {
  resetCandyGirlState();
  const sig = analyzeCandyGirl([{ coin: 'AAA', price: 94 }], longPos(), Date.now());
  assert.equal(sig.action, 'CLOSE');
  assert.equal(sig.reason, 'candy_girl_sl');
  assert.equal(sig.price, 95);
});

test('exit: SHORT цена ≤ TP → CLOSE (зеркало long)', () => {
  resetCandyGirlState();
  const pos = longPos({ side: 'short', entry_price: 100, sl_price: 105, tp_price: 90 });
  const sig = analyzeCandyGirl([{ coin: 'AAA', price: 89 }], pos, Date.now());
  assert.equal(sig.action, 'CLOSE');
  assert.equal(sig.reason, 'candy_girl_tp');
});

test('exit: время вышло → CLOSE candy_girl_time_stop (даже без монеты в scoutData)', () => {
  resetCandyGirlState();
  // entry_time далеко в прошлом → past PAPER_TIMEOUT_MS (default 240 мин).
  const pos = longPos({ entry_time: Date.now() - 300 * 60_000 });
  const sig = analyzeCandyGirl([], pos, Date.now());
  assert.equal(sig.action, 'CLOSE');
  assert.equal(sig.reason, 'candy_girl_time_stop');
  assert.equal(sig.price, 100, 'fallback на entry_price когда монеты нет в scoutData');
});

test('exit: внутри уровней + монеты нет в scoutData → HOLD (ждём time-stop)', () => {
  resetCandyGirlState();
  const sig = analyzeCandyGirl([], longPos(), Date.now());
  assert.equal(sig.action, 'HOLD');
});

test('analyze: re-entry cooldown после exit блокирует ту же монету', async () => {
  resetCandyGirlState();
  const now = await seedLongHit('AAA', 215.5);
  // Закрываем позу по TP → ставит paperReentryCooldown на AAA.
  const close = analyzeCandyGirl([{ coin: 'AAA', price: 999 }], longPos({ tp_price: 110 }), now);
  assert.equal(close.action, 'CLOSE');
  // Слот снова свободен, хит ещё свежий — но монета на cooldown → HOLD.
  const reopen = analyzeCandyGirl([{ coin: 'AAA', price: 215.5 }], null, now + 1000);
  assert.equal(reopen.action, 'HOLD');
});
