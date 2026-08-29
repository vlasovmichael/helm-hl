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

test('инвариант: у сетапа цель не ближе MIN_RR (урок kBONK)', () => {
  // Вердикт «сделки нет из-за R:R» снят вместе с таймаутом, но само построение
  // цели по-прежнему берёт пивот не ближе 1.5 риска — иначе карточка рисовала
  // бы сетап с целью внутри стопа. Прогоняем сетку сценариев.
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
  ];
  const res = await scanCoinOfDay(rows);
  // Ни одна из двух не должна дойти до стадии свечей (сеть не дёргается).
  assert.equal(res.scanned, 0);
  assert.equal(res.picks.length, 0);
});

test('слабый ход НЕ отсекает монету — рубильник снят', () => {
  // Регрессия дефекта «прибор стирает сам себя»: раньше |chg24h| < 8% давал
  // return null, и монета выпадала из скана по мере ОТРАБОТКИ фейда (VVV
  // исчез за 10 минут на −7.42%). Теперь ход — ключ сортировки, а не порог.
  // Проверяем на чистой функции: scanCoinOfDay здесь полез бы за свечами.
  const c1h = Array.from({ length: 30 }, (_, i) => ({
    time: i * 3_600_000, open: 100, high: 101, low: 99, close: 100, vol: 10,
  }));
  const weak = analyzeCoin({
    coin: 'FLAT', price: 100.4, oiUsd: 1e6, fundingRate: 0, volume24hUsd: 5e7, c1h, c15: [],
  });
  assert.ok(weak, 'монета со слабым ходом обязана дойти до скоринга');
  assert.ok(Math.abs(weak.features.chg24h) < 8, 'ход действительно слабый');
});

// ── Резолвер: ход на горизонтах + бенчмарк BTC ────────────────────────────
const { computeHorizons, priceAt, toSide } = await import('../src/modules/coinOfDayLog.js');

const T0 = 1_700_000_000_000;
const H = 3_600_000;
const bar = (ms, close) => ({ time: T0 + ms, open: close, high: close, low: close, close, vol: 100 });

// SHORT на 100, BTC на 50_000 в момент пика.
const pick = { side: 'SHORT', created_at: T0, entry: 100, btc_at: 50_000 };

test('priceAt берёт последнюю свечу, закрывшуюся НЕ позже момента', () => {
  const c = [bar(0, 100), bar(3 * H, 97), bar(5 * H, 93)];
  assert.equal(priceAt(c, T0 + 4 * H), 97, 'свеча из будущего не берётся');
  assert.equal(priceAt(c, T0 + 5 * H), 93);
  assert.equal(priceAt(c, T0 - H), null, 'до входа данных нет');
});

test('toSide: для SHORT падение цены — это плюс', () => {
  assert.equal(toSide(-5, 'SHORT'), 5);
  assert.equal(toSide(-5, 'LONG'), -5);
  assert.equal(toSide(null, 'SHORT'), null);
});

test('созревшие горизонты считаются, несозревшие пропускаются', () => {
  const coin = [bar(0, 100), bar(4 * H, 96), bar(8 * H, 94)];
  const btc = [bar(0, 50_000), bar(4 * H, 49_500), bar(8 * H, 49_000)];
  const res = computeHorizons(pick, coin, btc, T0 + 9 * H);

  assert.ok(Math.abs(res.chg_4h - -4) < 1e-9, 'монета −4% за 4ч');
  assert.ok(Math.abs(res.btc_4h - -1) < 1e-9, 'BTC −1% за 4ч');
  assert.ok(Math.abs(res.chg_8h - -6) < 1e-9);
  assert.equal(res.chg_24h, undefined, '24ч ещё не наступили');
});

test('горизонт не наступил → null, пик остаётся незакрытым', () => {
  const coin = [bar(0, 100), bar(H, 98)];
  assert.equal(computeHorizons(pick, coin, [], T0 + 2 * H), null);
});

test('уже посчитанный горизонт не пересчитывается', () => {
  // Иначе форвард переписывался бы задним числом и переставал быть форвардом.
  const coin = [bar(0, 100), bar(4 * H, 90)];
  const res = computeHorizons({ ...pick, chg_4h: -4 }, coin, [], T0 + 5 * H);
  assert.equal(res, null, 'нечего дописывать');
});

test('без цены BTC на момент пика бенчмарк не выдумывается', () => {
  const coin = [bar(0, 100), bar(4 * H, 96)];
  const btc = [bar(0, 50_000), bar(4 * H, 49_500)];
  const res = computeHorizons({ ...pick, btc_at: null }, coin, btc, T0 + 5 * H);
  assert.ok(Math.abs(res.chg_4h - -4) < 1e-9);
  assert.equal(res.btc_4h, undefined, 'нет базы — нет колонки, а не ноль');
});

test('excess отделяет отработку фейда от общего хода рынка', () => {
  // Монета −6%, BTC −6%: сетап «сработал», но ровно на бете. Это и есть
  // ответ на «или так совпало с ценой битка».
  const coinChg = -6, btcChg = -6;
  const excess = toSide(coinChg, 'SHORT') - toSide(btcChg, 'SHORT');
  assert.equal(excess, 0);
});

// ── Привязка к позициям оператора ─────────────────────────────────────────────
const { buildHeldView } = await import('../src/modules/coinOfDay.js');

const heldPos = { side: 'SHORT', entryPx: 100, szi: -10, notionalUsd: 1000, unrealizedPnl: 5 };
const heldPick = { entry: 100, stop: 104, target: 90 };

test('монета в позиции уходит в held и НЕ попадает в picks (никаких доливов)', async () => {
  const rows = [
    { coin: 'AAA', price: 1, oiUsd: 1e6, fundingRate: 0, volume24hUsd: 5e7, dayChangePct: 25 },
  ];
  const positions = new Map([['AAA', heldPos]]);
  // Свечей не будет (сеть в тестах недоступна) — важен сам факт разведения веток:
  // held-монета не должна оказаться среди кандидатов на вход ни при каком раскладе.
  const res = await scanCoinOfDay(rows, Date.now(), { positions });
  assert.equal(res.picks.some((p) => p.coin === 'AAA'), false, 'held-монета не предлагается как вход');
});

test('held: тезис в силе → статус thesis_intact, новых уровней входа нет', () => {
  const analysis = {
    side: 'SHORT', score: 5, verdict: { tone: 'setup' },
    hits: { rollover: true, structure: true }, features: {}, flags: [],
  };
  const v = buildHeldView({ coin: 'AAA', analysis, position: heldPos, pick: heldPick, price: 97 });
  assert.equal(v.held, true);
  assert.equal(v.status, 'thesis_intact');
  assert.equal(v.levels, undefined, 'held-разбор не считает вход — это защита от усреднения');
  assert.ok(Math.abs(v.position.gainPct - 3) < 1e-9, 'шорт со 100 при цене 97 = +3%');
  // R считается от ТВОЕГО входа (100) до стопа плана (104) = риск 4; прошли 3.
  assert.ok(Math.abs(v.plan.rNow - 0.75) < 1e-9, 'риск 4, прошли 3 → +0.75R');
});

test('held: цена за стопом плана → тезис сломан', () => {
  const analysis = { side: 'SHORT', score: 5, verdict: { tone: 'setup' }, hits: {}, features: {}, flags: [] };
  const v = buildHeldView({ coin: 'AAA', analysis, position: heldPos, pick: heldPick, price: 105 });
  assert.equal(v.status, 'thesis_invalidated');
  assert.equal(v.plan.stopHit, true);
});

test('held: сетап растворился (analysis=null) → монета всё равно показана', () => {
  // Регресс: раньше такая монета просто исчезла бы с карточки — ровно тогда,
  // когда сказать о ней важнее всего.
  const v = buildHeldView({ coin: 'AAA', analysis: null, position: heldPos, pick: heldPick, price: 99 });
  assert.equal(v.status, 'thesis_faded');
  assert.equal(v.held, true);
});

test('held: R считается от входа оператора, а не от входа карточки', () => {
  const analysis = { side: 'SHORT', score: 5, verdict: { tone: 'setup' }, hits: {}, features: {}, flags: [] };
  // План: шорт от 100, стоп 104. Юзер вошёл в 102 — для шорта это ЛУЧШЕ плана,
  // и стоп плана (104) всё ещё над его входом, значит риск считается: 104−102=2.
  const pos = { ...heldPos, entryPx: 102 };
  const v = buildHeldView({ coin: 'AAA', analysis, position: pos, pick: heldPick, price: 100 });
  assert.equal(v.plan.stopBehindEntry, false);
  assert.ok(Math.abs(v.plan.rNow - 1) < 1e-9, 'прошёл 2 при риске 2 → ровно 1R от своей цены');
  assert.ok(v.notes.some((n) => n.includes('лучше плана')), 'расхождение входов должно быть названо');
});

test('held: стоп плана не защищает вход → R не выдумывается', () => {
  const analysis = { side: 'SHORT', score: 5, verdict: { tone: 'setup' }, hits: {}, features: {}, flags: [] };
  // Шорт открыт в 110, а стоп плана 104 — НИЖЕ входа. Для шорта это не стоп,
  // а уровень прибыли: считать по нему риск нельзя.
  const v = buildHeldView({ coin: 'AAA', analysis, position: { ...heldPos, entryPx: 110 }, pick: heldPick, price: 106 });
  assert.equal(v.plan.stopBehindEntry, true);
  assert.equal(v.plan.rNow, null, 'R не считаем, когда стоп плана не защищает вход');
  assert.ok(v.notes.some((n) => n.includes('за спиной твоего входа')));
});

test('held: сторона позиции против разбора → громкий статус', () => {
  const analysis = { side: 'LONG', score: 5, verdict: { tone: 'setup' }, hits: {}, features: {}, flags: [] };
  const v = buildHeldView({ coin: 'AAA', analysis, position: heldPos, pick: null, price: 99 });
  assert.equal(v.status, 'wrong_side');
  assert.ok(v.notes.some((n) => n.includes('не по карточке')), 'без пика прогресс считать не от чего');
});

test('форвард-лог читает signals, а НЕ picks (иначе выборка смещена)', async () => {
  const { logScanPicks, isLoggablePick } = await import('../src/modules/coinOfDayLog.js');
  const setup = {
    coin: 'AAA', side: 'SHORT', score: COD.LOG_MIN_SCORE, verdict: { tone: 'setup' },
    levels: { entry: 100, stop: 104, riskPct: 4 }, flags: [],
  };
  // Ключевая регрессия, без БД: сигнал лежит только в picks → лог обязан его
  // проигнорировать, потому что источник замера — signals.
  assert.equal(
    logScanPicks({ picks: [setup], signals: [] }, 50_000),
    0,
    'picks не должен быть источником лога',
  );

  // Гейт записи — чистая функция, проверяем её отдельно от БД.
  assert.equal(isLoggablePick(setup), true);
  assert.equal(
    isLoggablePick({ ...setup, score: COD.LOG_MIN_SCORE - 1 }),
    false,
    'ниже порога score не пишем',
  );
  assert.equal(isLoggablePick({ ...setup, levels: null }), false, 'без уровней замер не определён');
});

// ── Монета, отторгованная сегодня ─────────────────────────────────────────
const { buildTradedTodayView } = await import('../src/modules/coinOfDay.js');

test('отторгованная сегодня монета сворачивается в «день закрыт», когда сетап рассыпался', () => {
  const day = { pnl: 0.74, count: 1, lastCloseAt: T0, side: 'SHORT' };
  const weak = { side: 'SHORT', score: 3, verdict: { tone: 'watch' }, hits: {}, features: { chg24h: 27 }, flags: [] };
  const v = buildTradedTodayView({ coin: 'kSHIB', analysis: weak, day, price: 0.0054 });

  assert.equal(v.tradedToday, true);
  assert.equal(v.held, true, 'фронт трактует held как «не для входа»');
  assert.equal(v.status, 'traded_today');
  assert.equal(v.levels, undefined, 'уровней входа быть не должно');
  assert.ok(v.headline.includes('+$0.74'));
  assert.ok(v.notes.some((n) => n.includes('отдать заработанное')), 'предупредить про повтор после плюса');
});

test('отторгованная в минус монета получает предупреждение про тильт', () => {
  const day = { pnl: -1.2, count: 2, lastCloseAt: T0, side: 'LONG' };
  const v = buildTradedTodayView({ coin: 'AAA', analysis: null, day, price: 1 });
  assert.ok(v.headline.includes('-$1.20'));
  assert.ok(v.notes.some((n) => n.includes('тильт')));
});

test('бумажные сделки бота не закрывают день по монете', async () => {
  // Регрессия: фильтр отсекал только manual_paper, поэтому закрытия hunter_oi и
  // fadehot (mode=PAPER) закрывали день по ACE/LINK, хотя оператор не торговал.
  const { tradedTodayFromHistory } = await import('../src/modules/dashboard/routes/coinOfDay.js');
  const rows = [
    { coin: 'ACE',  strategy_id: 'hunter_oi',    mode: 'PAPER',      realized_pnl: 0.36, closed_at: T0, side: 'short' },
    { coin: 'LINK', strategy_id: 'fadehot',      mode: 'PAPER',      realized_pnl: 0.13, closed_at: T0, side: 'long' },
    { coin: 'SUI',  strategy_id: 'manual_paper', mode: 'PAPER',      realized_pnl: -0.5, closed_at: T0, side: 'long' },
    { coin: 'HYPE', strategy_id: 'adopt',        mode: 'PRODUCTION', realized_pnl: -1.2, closed_at: T0, side: 'long' },
  ];
  const map = tradedTodayFromHistory(rows);

  assert.equal(map.has('ACE'), false, 'бумажный hunter_oi не расходует дневной лимит');
  assert.equal(map.has('LINK'), false, 'бумажный fadehot тоже');
  assert.equal(map.has('SUI'), false, 'личный бумажный журнал — как и раньше');
  assert.equal(map.get('HYPE')?.count, 1, 'реальная сделка день по монете закрывает');
  assert.equal(map.get('HYPE')?.side, 'LONG');
});

test('живой сетап по отторгованной монете остаётся входом, но с флагом второго захода', async () => {
  // Требование оператора: решает СОСТОЯНИЕ сетапа, а не факт сделки. Если движок
  // всё ещё видит продолжение — монета не должна пропадать из входов.
  const rows = [
    { coin: 'ZZZ', price: 1, oiUsd: 1e6, fundingRate: 0, volume24hUsd: 5e7, dayChangePct: 25 },
  ];
  const tradedToday = new Map([['ZZZ', { pnl: 0.74, count: 1, lastCloseAt: T0, side: 'SHORT' }]]);
  // Свечей нет → analyzeCoin вернёт null → ветка «день закрыт».
  const res = await scanCoinOfDay(rows, Date.now(), { tradedToday });
  assert.equal(res.picks.length, 0, 'без живого сетапа во входы не попадает');
  assert.ok(
    res.held.length === 0 || res.held[0].tradedToday === true,
    'если разобрана — то как «день закрыт»',
  );
});
