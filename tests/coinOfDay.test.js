// Монета дня — скоринг фейда выдохшегося хвоста + резолвер исходов.
//
// Запуск: npm test
//
// Скоринг (первые два — регрессии на дефекты, найденные живым прогоном 26.07):
//  - край диапазона НЕ гейт: отработавший сетап не исчезает из скана
//  - R:R обрезается: тесный стоп + далёкий пивот не рисуют «R:R 6.8»
//  - вердикт «сетап сложился» требует разворота 4ч и слома структуры
//  - инвариант R:R ≥ 1.5 на сетке сценариев (урок kBONK)
//  - забаненные журналом монеты и неликвид не проходят скан
//
// Резолвер (ядро замера — от него зависит, будет ли форвард-статистика честной):
//  - target / stop / timeout, R-исход, MFE/MAE
//  - стоп и цель в одном баре → консервативно СТОП
//  - свечи до входа игнорируются, незакрытый горизонт оставляет пик open

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

// Динамический импорт — статический ESM-импорт поднимается выше присваиваний
// env, и config.js падает на старте (паттерн остальных тестов репо).
const { analyzeCoin, scanCoinOfDay, COD, JOURNAL_BANNED } = await import(
  '../src/modules/coinOfDay.js'
);

const HOUR = 3_600_000;

/**
 * Синтетический памп по трём фазам: плоская база → вертикальный ход lift% →
 * откат pullback% от хая. Памп должен уместиться ВНУТРИ последних суток, иначе
 * chg24h выходит мизерным и монета не проходит MIN_MOVE_PCT.
 *
 * @param {number} flat — доля баров на плоскую базу
 * @param {number} rise — доля баров на памп (остаток идёт на откат)
 */
function pumpCandles({
  bars = 72, stepMs = HOUR, base = 100, lift = 0.35, pullback = 0.06,
  flat = 0.62, rise = 0.28, wick = 0.004, volDrop = true,
} = {}) {
  const flatEnd = Math.floor(bars * flat);
  const peakIdx = Math.floor(bars * (flat + rise));
  const peak = base * (1 + lift);
  const out = [];
  for (let i = 0; i < bars; i++) {
    let px;
    if (i <= flatEnd) px = base * (1 + 0.002 * Math.sin(i));         // база с лёгким шумом
    else if (i <= peakIdx) px = base + (peak - base) * ((i - flatEnd) / (peakIdx - flatEnd));
    else if (peakIdx < bars - 1) px = peak * (1 - pullback * ((i - peakIdx) / (bars - 1 - peakIdx)));
    else px = peak;
    out.push({
      time: Date.now() - (bars - i) * stepMs,
      open: px * (1 - wick / 4),
      high: px * (1 + wick),
      low: px * (1 - wick),
      close: px,
      // Объём распадается после хая — иначе hits.volDecay не сработает.
      vol: !volDrop || i <= peakIdx ? 1000 : 60,
    });
  }
  return out;
}

/** Собирает аргументы analyzeCoin по одному набору параметров пампа. */
function coinArgs(opts = {}, extra = {}) {
  const c1h = pumpCandles(opts);
  const c15 = pumpCandles({ ...opts, bars: 56, stepMs: 15 * 60_000 });
  return {
    coin: 'TESTC', price: c1h.at(-1).close, oiUsd: 5e6, fundingRate: 0.00001,
    volume24hUsd: 5e7, c1h, c15, ...extra,
  };
}

test('край диапазона — балл, а не гейт: отработавший сетап остаётся в скане', () => {
  // База держится до отметки −24ч, потом памп +40% и откат 15% от хая: ход за
  // сутки всё ещё большой (+19%), но цена уже НЕ у края диапазона.
  const a = analyzeCoin(coinArgs({ flat: 0.68, rise: 0.22, lift: 0.4, pullback: 0.15 }));

  assert.ok(a, 'монета не должна выпадать из скана после отработки хода');
  assert.equal(a.side, 'SHORT');
  assert.ok(a.features.chg24h >= COD.MIN_MOVE_PCT, 'ход за сутки остаётся большим');
  assert.ok(a.features.rangePos < COD.EDGE_POS, 'сценарий должен быть ниже порога края');
  assert.equal(a.hits.edge, false, 'край не сошёлся — но это только минус балл');
});

test('R:R обрезается до MAX_RR — тесный стоп с далёкой целью не рисует эдж', () => {
  const c1h = pumpCandles({ lift: 0.35, pullback: 0.04 });
  const last = c1h.at(-1).close;
  // 15m-хвост с крошечным размахом → структурный стоп много уже MIN_RISK_PCT,
  // а ближайший пивот 1ч лежит под всем пампом = очень далеко.
  const c15 = Array.from({ length: 56 }, (_, i) => ({
    time: Date.now() - (56 - i) * 15 * 60_000,
    open: last, high: last * 1.0008, low: last * 0.9992, close: last, vol: i < 40 ? 1000 : 50,
  }));
  const a = analyzeCoin({
    coin: 'TESTC', price: last, oiUsd: 1e6, fundingRate: 0, volume24hUsd: 5e7, c1h, c15,
  });

  assert.ok(a?.levels, 'уровни должны построиться');
  assert.ok(a.levels.rr <= COD.MAX_RR + 1e-9, `R:R ${a.levels.rr} должен быть обрезан до ${COD.MAX_RR}`);
  assert.ok(a.levels.farTarget != null, 'дальний уровень сохраняется отдельным полем');
  assert.ok(
    a.flags.some((f) => f.key === 'rr_capped'),
    'обрезка обязана быть видна флагом, а не молча',
  );
});

test('вердикт «сетап сложился» требует разворота 4ч и слома структуры', () => {
  // Памп идёт прямо в текущий бар: отката нет → rollover не сошёлся.
  const a = analyzeCoin(coinArgs({ flat: 0.5, rise: 0.5, pullback: 0, volDrop: false }));

  assert.ok(a, 'монета в живом пампе всё равно попадает в разбор');
  assert.equal(a.hits.rollover, false);
  assert.notEqual(a.verdict.tone, 'setup', 'без разворота 4ч это не «сетап сложился»');
  assert.ok(
    a.flags.some((f) => f.key === 'no_rollover'),
    'отсутствие разворота обязано быть красным флагом',
  );
});

test('инвариант: всё, что зовётся сетапом, прошло гейт R:R (урок kBONK)', () => {
  // Прогоняем сетку сценариев — ни один не должен дать «сетап» с R:R < гейта.
  for (const lift of [0.12, 0.25, 0.4]) {
    for (const pullback of [0, 0.03, 0.08, 0.2]) {
      const a = analyzeCoin(coinArgs({ lift, pullback }));
      if (a?.verdict.tone !== 'setup') continue;
      assert.ok(
        a.levels && a.levels.rr >= COD.MIN_RR,
        `сетап с R:R ${a.levels?.rr} при lift=${lift} pullback=${pullback}`,
      );
      assert.ok(a.hits.rollover && a.hits.structure, 'сетап обязан иметь разворот и слом структуры');
    }
  }
});

test('скан отсеивает забаненные журналом монеты и неликвид', async () => {
  const banned = [...JOURNAL_BANNED][0];
  const rows = [
    { coin: banned, price: 1, oiUsd: 1e6, fundingRate: 0, volume24hUsd: 5e7, dayChangePct: 25 },
    { coin: 'THIN', price: 1, oiUsd: 1e6, fundingRate: 0, volume24hUsd: 100, dayChangePct: 25 },
    { coin: 'FLAT', price: 1, oiUsd: 1e6, fundingRate: 0, volume24hUsd: 5e7, dayChangePct: 0.4 },
  ];
  const res = await scanCoinOfDay(rows);
  // Ни одна из трёх не должна дойти до стадии свечей (сеть не дёргается).
  assert.equal(res.scanned, 0);
  assert.equal(res.picks.length, 0);
});

// ── Резолвер исходов ──────────────────────────────────────────────────────
const { simulateOutcome } = await import('../src/modules/coinOfDayLog.js');

const T0 = 1_700_000_000_000;
const bar = (i, { high, low, close }) => ({
  time: T0 + i * 15 * 60_000, open: close, high, low, close, vol: 100,
});
const shortPick = { side: 'SHORT', created_at: T0, entry: 100, stop: 104, target: 90 };

test('резолвер: цель достигнута → status=target, R положительный', () => {
  const res = simulateOutcome(shortPick, [
    bar(0, { high: 101, low: 98, close: 99 }),
    bar(1, { high: 99, low: 89, close: 90 }),
  ]);
  assert.equal(res.status, 'target');
  assert.equal(res.exit_price, 90);
  assert.ok(Math.abs(res.outcome_r - 2.5) < 1e-9, 'риск 4, профит 10 → 2.5R');
  assert.ok(res.mfe_pct > 0 && res.mae_pct <= 0);
});

test('резолвер: стоп достигнут → status=stop, R = −1', () => {
  const res = simulateOutcome(shortPick, [
    bar(0, { high: 101, low: 99, close: 100 }),
    bar(1, { high: 105, low: 100, close: 104 }),
  ]);
  assert.equal(res.status, 'stop');
  assert.ok(Math.abs(res.outcome_r + 1) < 1e-9, 'стоп обязан давать ровно −1R');
});

test('резолвер: стоп и цель в одном баре → консервативно засчитывается СТОП', () => {
  // Иначе статистика красится: реальный порядок тиков внутри бара неизвестен.
  const res = simulateOutcome(shortPick, [bar(0, { high: 106, low: 88, close: 95 })]);
  assert.equal(res.status, 'stop');
  assert.ok(res.outcome_r < 0);
});

test('резолвер: горизонт не истёк и уровни не задеты → null (пик остаётся open)', () => {
  const res = simulateOutcome(shortPick, [
    bar(0, { high: 101, low: 99, close: 100 }),
    bar(1, { high: 101, low: 99, close: 100 }),
  ]);
  assert.equal(res, null);
});

test('резолвер: истёк time-stop → status=timeout по цене бара', () => {
  const bars = [];
  // TIME_STOP_MIN=120 мин = 8 баров по 15м
  for (let i = 0; i <= 9; i++) bars.push(bar(i, { high: 101, low: 99, close: 99.5 }));
  const res = simulateOutcome(shortPick, bars);
  assert.equal(res.status, 'timeout');
  assert.equal(res.exit_price, 99.5);
  assert.ok(res.outcome_r > 0, 'шорт закрылся ниже входа → небольшой плюс');
});

test('резолвер: свечи ДО входа игнорируются', () => {
  const res = simulateOutcome(shortPick, [
    { time: T0 - 3_600_000, open: 100, high: 120, low: 80, close: 100, vol: 1 }, // задела бы всё
    bar(0, { high: 101, low: 89, close: 90 }),
  ]);
  assert.equal(res.status, 'target', 'бар до входа не должен закрывать сделку');
});
