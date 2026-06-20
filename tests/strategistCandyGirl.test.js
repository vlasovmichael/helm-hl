// Тесты радара Candy Girl: лента сигналов, дедуп, кап за тик, никогда не торгует.
// TG-алерты выключаем через env ДО импорта модуля (config читается один раз).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── ENV до импорта модуля (config читается один раз) ─────────────────────
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
  scoreCandySignal,
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

