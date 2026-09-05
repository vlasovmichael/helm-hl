// ─────────────────────────────────────────────────
//  Монета дня — форвард-скоринг сетапа «выдохшийся хвост»
// ─────────────────────────────────────────────────
// Находит монету, которая за сутки сильно сходила, упёрлась в край диапазона,
// уже развернулась на 4ч и теряет объём — и предлагает фейд этого хвоста с
// конкретным стопом и целью.
//
// Устройство:
// • сторона по умолчанию SHORT — эдж оператора это шорт мид-кап альтов;
// • обязателен ГЕЙТ R:R ≥ 1.5 — без него зелёный вердикт выдаётся и при
// R:R 0.04;
// • стоп считается ДО входа (правило №2 из docs/TRADING_RULES.md);
// • контр-трендовость к 1ч сетап не убивает, но выносится во флаги.
//
// ⚠️ Forward-эдж НЕ доказан: все прошлые оракулы входа дали exp≈0. Каждый пик
// пишется в coin_of_day_picks и резолвится по свечам (coinOfDayLog.js) —
// решает цифра, а не убедительность карточки.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { HL_PRIORITY } from '../core/hlClient.js';
import { getHourlyCandles, getFifteenMinCandles } from './candleCache.js';

// ── пороги (все в одном месте, чтобы калибровать не роясь по коду) ──
export const COD = {
  MIN_VOL_USD:      3_000_000,  // ниже — стакан тонкий, стоп проскользнёт
  THIN_VOL_USD:     8_000_000,  // ниже — флаг «тонко», но не дисквалификация
  CANDIDATES:       6,          // сколько монет тянем свечами (2 запроса на монету)
  MIN_MOVE_PCT:     8,          // «сильно сходила» за 24ч
  EDGE_POS:         0.80,       // доля диапазона 72ч: ≥0.80 верх / ≤0.20 низ
  ROLLOVER_PCT:     0.5,        // разворот на 4ч, % против хода
  MIN_STRUCT_LEGS:  3,          // сколько lower-highs / higher-lows подряд
  VOL_DECAY_MAX:    0.40,       // текущий объём / пиковый объём спайка
  CROWD_OI_VOL_MAX: 0.5,        // OI$ / vol24h — низкий = памп не на плече
  // Не гейт, а минимальная дистанция до цели: ближайший пивот берётся не ближе
  // 1.5 риска. Вердикт «сделки нет из-за R:R» снят — он отбрасывал сетап по
  // арифметике цели, которой всё равно мешал таймаут.
  MIN_RR:           1.5,
  MAX_RR:           3.5,        // выше — артефакт тесного стопа, не эдж (урок Whale Trade Club)
  MIN_RISK_PCT:     1.5,        // уже — стоп в шуме
  MAX_RISK_PCT:     4.0,        // шире — сделка не по размеру депозита
  // 🚨 Таймаута больше нет. TIME_STOP_MIN = 120 в паре с целью в 1.5 риска и
  // сделал прошлую версию неработающей: цель бралась 1 раз из 103, потому что
  // сетап закрывался через 2ч. Юзер смотрел совсем другие горизонты — «нужно
  // было подождать 4-6-8 часов». Их и логируем.
  HORIZONS_H:       [4, 8, 24],
  // Пороги пересчитаны под шкалу 0–5 (был балл-дубликат `move`, стало 5
  // независимых признаков). Прежние 4/6 и 5/6 на новой шкале — это 3/5 и 4/5.
  SHOW_MIN_SCORE:   3,          // с какого score монета получает таб
  LOG_MIN_SCORE:    4,          // с какого score пик уходит в форвард-лог
};

// Монеты, забаненные декомпозицией журнала (16.07): системно сливали.
// Держим отдельно от config.coinBlacklist — та про нерабочие контракты HL,
// эта про личную статистику оператора.
export const JOURNAL_BANNED = new Set(['HMSTR', 'KAITO', 'AERO', 'JTO', 'CASHCAT']);

const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** ATR в % от цены по массиву свечей. */
function atrPct(candles, period, price) {
  if (!Array.isArray(candles) || candles.length < period + 1 || !(price > 0)) return null;
  const win = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < win.length; i++) {
    sum += Math.max(
      win[i].high - win[i].low,
      Math.abs(win[i].high - win[i - 1].close),
      Math.abs(win[i].low - win[i - 1].close),
    );
  }
  return ((sum / period) / price) * 100;
}

/** Efficiency ratio: |нетто-ход| / сумма|шагов|. 1 = прямая линия, 0 = пила. */
function efficiencyRatio(closes) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const net = Math.abs(closes.at(-1) - closes[0]);
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
  return path > 0 ? net / path : null;
}

/** Простой поиск свинг-пивотов (left=right=strength баров). */
function pivots(candles, strength = 2) {
  const highs = [];
  const lows = [];
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  return { highs, lows };
}

/**
 * Считает, сколько 15m-баров подряд от экстремума идут ниже/выше предыдущего.
 * Для SHORT: серия lower-highs после хая. Для LONG: higher-lows после лоу.
 */
function structureLegs(c15, side) {
  if (!Array.isArray(c15) || c15.length < 6) return { legs: 0, since: null };
  const key = side === 'SHORT' ? 'high' : 'low';
  // Индекс экстремума в окне
  let ext = 0;
  for (let i = 1; i < c15.length; i++) {
    const better = side === 'SHORT' ? c15[i][key] > c15[ext][key] : c15[i][key] < c15[ext][key];
    if (better) ext = i;
  }
  // Экстремум в самом конце окна — разворота ещё не было
  if (ext >= c15.length - 2) return { legs: 0, since: c15[ext].time };
  let legs = 0;
  let ref = c15[ext][key];
  for (let i = ext + 1; i < c15.length; i++) {
    const v = c15[i][key];
    const lower = side === 'SHORT' ? v < ref : v > ref;
    if (lower) {
      legs++;
      ref = v;
    }
  }
  return { legs, since: c15[ext].time, extreme: c15[ext][key], extIdx: ext };
}

/** Распад объёма: средний объём последних 3 баров / пиковый средний-по-3 в окне. */
function volumeDecay(c15) {
  const vols = (c15 || []).map((c) => c.vol).filter((v) => Number.isFinite(v));
  if (vols.length < 9) return null;
  const avg3 = (arr, i) => (arr[i] + arr[i - 1] + arr[i - 2]) / 3;
  const now = avg3(vols, vols.length - 1);
  let peak = 0;
  for (let i = 2; i < vols.length; i++) peak = Math.max(peak, avg3(vols, i));
  return peak > 0 ? now / peak : null;
}

/** 1ч-тренд по EMA (для флага контр-трендовости). */
function emaTrend(closes, fast = 9, slow = 21) {
  if (!Array.isArray(closes) || closes.length < slow + 1) return 'flat';
  const ema = (arr, p) => {
    const k = 2 / (p + 1);
    let e = arr[0];
    for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  };
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const d = ((f - s) / s) * 100;
  return d > 0.15 ? 'up' : d < -0.15 ? 'down' : 'flat';
}

/**
 * Считает уровни сделки: вход, стоп за структуру, цель до ближайшего пивота.
 * Возвращает null, если геометрия не сложилась (нет стопа/цели).
 */
function buildLevels({ side, price, c1h, c15, atr15Pct }) {
  const isShort = side === 'SHORT';
  // Стоп — за экстремум последних 6 баров 15m + буфер 0.15 ATR15.
  const tail = c15.slice(-6);
  if (!tail.length) return null;
  const buf = price * ((atr15Pct ?? 1) / 100) * 0.15;
  let stop = isShort
    ? Math.max(...tail.map((c) => c.high)) + buf
    : Math.min(...tail.map((c) => c.low)) - buf;

  let riskPct = Math.abs(pct(stop, price));
  if (!Number.isFinite(riskPct) || riskPct <= 0) return null;
  // Слишком тесный стоп ловит ножи, слишком широкий не по размеру депозита.
  const structuralRiskPct = riskPct;
  const clamped = clamp(riskPct, COD.MIN_RISK_PCT, COD.MAX_RISK_PCT);
  const clampedRisk = clamped !== riskPct;
  if (clampedRisk) {
    stop = isShort ? price * (1 + clamped / 100) : price * (1 - clamped / 100);
    riskPct = clamped;
  }

  // Цель — ближайший пивот 1ч по ходу сделки, но не ближе 1.5R.
  const { highs, lows } = pivots(c1h, 2);
  const minDist = price * ((riskPct * COD.MIN_RR) / 100);
  let target;
  let targetProjected = false;
  if (isShort) {
    const cands = lows.filter((l) => l <= price - minDist).sort((a, b) => b - a);
    target = cands[0] ?? null;
  } else {
    const cands = highs.filter((h) => h >= price + minDist).sort((a, b) => a - b);
    target = cands[0] ?? null;
  }
  if (target == null) {
    // Пивота нет (цена в пустоте / свежий диапазон) — проецируем 2.5R и честно
    // помечаем: это арифметика, а не уровень с рынка.
    target = isShort ? price * (1 - (riskPct * 2.5) / 100) : price * (1 + (riskPct * 2.5) / 100);
    targetProjected = true;
  }

  // Обрезка нереального R:R. После вертикального пампа под ценой нет структуры,
  // и ближайший пивот 1ч может лежать в 10% — с клампнутым до 1.5% стопом это
  // рисует «R:R 6.8», хотя удержать такую сделку до цели нереально. Ровно этот
  // артефакт (тесный стоп + далёкий таргет) надул «+11R» в бэктесте Whale Trade
  // Club. Показываем достижимую цель, а дальний пивот выносим отдельным полем.
  let farTarget = null;
  const rawRr = Math.abs(pct(target, price)) / riskPct;
  if (rawRr > COD.MAX_RR) {
    farTarget = target;
    target = isShort
      ? price * (1 - (riskPct * COD.MAX_RR) / 100)
      : price * (1 + (riskPct * COD.MAX_RR) / 100);
  }

  const rewardPct = Math.abs(pct(target, price));
  return {
    entry: price,
    stop,
    target,
    targetProjected,
    farTarget,
    farTargetRr: farTarget ? rawRr : null,
    riskPct,
    structuralRiskPct,
    clampedRisk,
    rewardPct,
    rr: riskPct > 0 ? rewardPct / riskPct : null,
    horizonsH: COD.HORIZONS_H,
  };
}

/**
 * Разбирает одну монету: фичи → сторона → score → уровни → флаги.
 * @returns {Object|null} null, если данных не хватило
 */
export function analyzeCoin({ coin, price, oiUsd, fundingRate, volume24hUsd, c1h, c15 }) {
  if (!(price > 0) || !Array.isArray(c1h) || c1h.length < 26) return null;

  const closes = c1h.map((c) => c.close);
  const chg = (n) => (c1h.length > n ? pct(price, closes.at(-1 - n)) : null);
  const chg4h = chg(4);
  const chg24h = chg(24);
  const chg48h = c1h.length > 48 ? chg(48) : null;

  const hi72 = Math.max(...c1h.map((c) => c.high));
  const lo72 = Math.min(...c1h.map((c) => c.low));
  const rangePos = hi72 > lo72 ? (price - lo72) / (hi72 - lo72) : 0.5;

  // Сторона = против суточного хода: фейдим того, кто уже сходил.
  //
  // Край диапазона НЕ гейт, а один из шести баллов. Когда он был гейтом, сетап
  // стирал сам себя по мере отработки: цена уходит с хая на −6%, позиция в
  // диапазоне падает ниже порога — и монета, сходившая за сутки +29%, пропадает
  // из скана целиком (kSHIB 26.07 выпал на 79.9% против порога 80.0). Скор
  // должен просаживаться плавно, а не отрубать монету по рубильнику.
  // 🚨 Ход за сутки БОЛЬШЕ НЕ ОТСЕКАЕТ. Раньше здесь стоял
  // `if (|chg24h| < MIN_MOVE_PCT) return null`, и монета выпадала из скана по
  // мере ОТРАБОТКИ фейда: цена возвращается → суточный ход падает → сетап
  // исчезает с экрана. Юзер видел это на VVV — карточка пропала за 10 минут,
  // хотя ход был −7.42%. Тот же класс, что чинили на крае диапазона (kSHIB
  // 26.07, 79.9 против порога 80.0).
  // Теперь ход — величина для сортировки, а не рубильник: слабые монеты просто
  // уезжают вниз списка и остаются видимыми.
  if (chg24h == null) return null;
  const side = chg24h > 0 ? 'SHORT' : 'LONG';

  const isShort = side === 'SHORT';
  const struct = structureLegs(c15 || [], side);
  const decay = volumeDecay(c15);
  const atr1h = atrPct(c1h, 14, price);
  const atr15 = atrPct(c15 || [], 14, price);
  const er24 = efficiencyRatio(closes.slice(-25));
  const oiVol = oiUsd > 0 && volume24hUsd > 0 ? oiUsd / volume24hUsd : null;
  const trend1h = emaTrend(closes);
  const fundingApr = Number.isFinite(fundingRate) ? fundingRate * 24 * 365 * 100 : null;

  // ── score: 6 независимых признаков, каждый = 1 балл ──
  // Балла `move` здесь больше нет: он повторял отсечку выше и потому
  // начислялся всем, кто до сюда дошёл — «5 из 6» на деле было 4 из 5.
  // Осталось 5 независимых признаков.
  const hits = {
    edge:      isShort ? rangePos >= COD.EDGE_POS : rangePos <= 1 - COD.EDGE_POS,
    rollover:  chg4h != null && (isShort ? chg4h <= -COD.ROLLOVER_PCT : chg4h >= COD.ROLLOVER_PCT),
    structure: struct.legs >= COD.MIN_STRUCT_LEGS,
    volDecay:  decay != null && decay <= COD.VOL_DECAY_MAX,
    notCrowded: oiVol != null && oiVol <= COD.CROWD_OI_VOL_MAX,
  };
  const score = Object.values(hits).filter(Boolean).length;

  const levels = c15?.length ? buildLevels({ side, price, c1h, c15, atr15Pct: atr15 }) : null;

  // ── флаги «что против» — не режут score, но обязаны быть на карточке ──
  const flags = [];
  if (isShort && trend1h === 'up') {
    flags.push({
      key: 'counter_trend',
      severity: 'high',
      text: 'The 1h trend is still up — this is a counter-trend entry; the bot’s HTF anti-trend gate would have blocked it',
    });
  }
  if (!isShort && trend1h === 'down') {
    flags.push({ key: 'counter_trend', severity: 'high', text: 'The 1h trend is down — this is catching a falling knife' });
  }
  if (!isShort) {
    flags.push({
      key: 'long_side',
      severity: 'high',
      text: 'LONG against the journal: payoff on longs is 0.44 vs 0.70 on shorts (decomposition, Jul 16)',
    });
  }
  if (volume24hUsd != null && volume24hUsd < COD.THIN_VOL_USD) {
    flags.push({ key: 'thin', severity: 'med', text: 'Turnover < $8M — the book is thin, the stop can slip' });
  }
  if (oiVol != null && oiVol > 1.5) {
    flags.push({
      key: 'crowded',
      severity: 'med',
      text: `OI ${oiVol.toFixed(1)}× turnover — the crowd is leveraged, squeeze risk against the entry`,
    });
  }
  if (fundingApr != null && isShort && fundingApr < -20) {
    flags.push({ key: 'funding_vs', severity: 'med', text: 'Funding is negative — you pay to hold the short' });
  }
  if (levels?.targetProjected) {
    flags.push({ key: 'target_projected', severity: 'low', text: 'The target is projected from risk (no 1h pivot along the way), not taken off the chart' });
  }
  if (levels?.clampedRisk) {
    flags.push({
      key: 'risk_clamped',
      severity: 'med',
      text: `The structural stop was ${levels.structuralRiskPct.toFixed(2)}% — tightened to ${levels.riskPct.toFixed(2)}%. The stop follows the risk cap, not a level`,
    });
  }
  if (levels?.farTarget) {
    flags.push({
      key: 'rr_capped',
      severity: 'med',
      text: `No structure below price: the nearest 1h pivot gives R:R ${levels.farTargetRr.toFixed(1)} — an artefact of a tight stop, not an edge. Target truncated`,
    });
  }
  if (!hits.rollover) {
    flags.push({
      key: 'no_rollover',
      severity: 'high',
      text: `4h momentum has NOT rolled over yet (${chg4h?.toFixed(2)}%) — you would be fading a live move, not an exhausted one. The key difference from the setup`,
    });
  }
  if (atr1h != null && atr1h > 3) {
    flags.push({ key: 'wild', severity: 'low', text: `ATR(1h) ${atr1h.toFixed(1)}% — wide range, cut the position size` });
  }

  // ── вердикт ──
  let verdict;
  if (!levels) {
    verdict = { tone: 'none', headline: 'No trade', detail: 'Could not build levels — no 15m structure.' };
  } else if (score >= 4 && hits.rollover && hits.structure) {
    // Разворот 4ч + слом структуры 15м — обязательны. Без них это не «хвост
    // выдохся», а фейд живого импульса: другая сделка с другой статистикой.
    verdict = {
      tone: 'setup',
      headline: `${side} — setup is in place (${score}/5)`,
      detail: `The tail is exhausted: ${chg24h.toFixed(1)}% over 24h, ${(rangePos * 100).toFixed(0)}% of the 72h range, 4h already at ${chg4h?.toFixed(2)}%. Place the stop before the entry.`,
    };
  } else {
    verdict = {
      tone: 'watch',
      headline: `${side} — watchlist only (${score}/5)`,
      detail: 'Some conditions did not line up. A watchlist candidate, not a ready entry — read the chart yourself.',
    };
  }

  return {
    coin,
    side,
    score,
    hits,
    verdict,
    levels,
    flags,
    features: {
      price,
      chg4h,
      chg24h,
      chg48h,
      rangePos,
      hi72,
      lo72,
      atr1hPct: atr1h,
      er24,
      structLegs: struct.legs,
      structExtreme: struct.extreme ?? null,
      volDecay: decay,
      oiUsd,
      volume24hUsd,
      oiVolRatio: oiVol,
      fundingApr,
      trend1h,
    },
  };
}

/**
 * Разбор монеты, в которой оператор УЖЕ сидит. Не «новый вход», а проверка тезиса:
 * жив ли ещё сетап, по которому заходили, и не пора ли выходить.
 *
 * Осознанно НЕ считает новых уровней входа. Карточка, предлагающая долить в
 * открытую позу, — это генератор усреднения, а усреднение в лося и есть тот
 * механизм, которым сливают депозит. Максимум, что мы делаем, — сверяем факт
 * с планом, с которым заходили.
 *
 * @param {Object} analysis — результат analyzeCoin для этой монеты (может быть null)
 * @param {Object} position — {side, entryPx, szi, notionalUsd, unrealizedPnl}
 * @param {Object|null} pick — строка coin_of_day_picks за сегодня, если вход был по карточке
 */
export function buildHeldView({ coin, analysis, position, pick, price }) {
  const side = position.side;
  const isShort = side === 'SHORT';
  const gainPct = position.entryPx > 0
    ? ((isShort ? position.entryPx - price : price - position.entryPx) / position.entryPx) * 100
    : null;

  // Прогресс по плану, с которым заходили (если пик за сегодня есть).
  let plan = null;
  if (pick && Number.isFinite(pick.stop) && Number.isFinite(pick.target)) {
    // R считаем от ТВОЕГО входа, а не от входа карточки: риск на позиции несёшь
    // ты, от своей цены до стопа плана. Раньше бралcя вход пика, и панель
    // показывала «0.09R» при живом +2.9% — цифра про сделку карточки, не про твою.
    const risk = Math.abs(pick.stop - position.entryPx);
    const gainAbs = isShort ? position.entryPx - price : price - position.entryPx;
    const stopHit = isShort ? price >= pick.stop : price <= pick.stop;
    const targetHit = isShort ? price <= pick.target : price >= pick.target;
    const span = Math.abs(pick.target - position.entryPx);
    // Стоп плана уже за спиной входа (вошёл хуже плана) — R не определён.
    const stopBehindEntry = isShort ? pick.stop <= position.entryPx : pick.stop >= position.entryPx;
    plan = {
      entry: pick.entry,
      entryDiffPct: pick.entry > 0 ? ((position.entryPx - pick.entry) / pick.entry) * 100 : null,
      stop: pick.stop,
      target: pick.target,
      rNow: risk > 0 && !stopBehindEntry ? gainAbs / risk : null,
      stopBehindEntry,
      progressPct: span > 0 ? Math.max(0, Math.min(100, (gainAbs / span) * 100)) : null,
      toStopPct: Math.abs(((pick.stop - price) / price) * 100),
      toTargetPct: Math.abs(((pick.target - price) / price) * 100),
      stopHit,
      targetHit,
    };
  }

  // ── статус тезиса ──
  let status;
  let headline;
  let detail;

  if (analysis && analysis.side !== side) {
    status = 'wrong_side';
    headline = `You are ${side}, the analysis says ${analysis.side}`;
    detail =
      'The position runs against what the structure shows now. This is not a signal to flip — ' +
      'it is a reason to reread your entry plan and decide whether it still holds.';
  } else if (plan?.stopHit) {
    status = 'thesis_invalidated';
    headline = 'Plan stop broken';
    detail =
      `Price went beyond the ${pick.stop} stop you entered with. The thesis is broken — from here it is no longer ` +
      'the trade you opened. Holding it requires a new, deliberate decision, not inertia.';
  } else if (plan?.targetHit) {
    status = 'target_reached';
    headline = 'Plan target reached';
    detail = `Price reached ${pick.target}. The plan is fully played out — anything beyond is a bonus, not the trade.`;
  } else if (!analysis) {
    status = 'thesis_faded';
    headline = 'The setup in this coin is gone';
    detail =
      'The coin no longer passes even the entry filter (24h move / structure). The reason you entered ' +
      'has dissolved — exit by plan, not by hope.';
  } else if (analysis.verdict.tone === 'setup') {
    status = 'thesis_intact';
    headline = `Thesis intact (${analysis.score}/5)`;
    detail = 'The analysis still describes the same setup. Nothing to do — run the position by plan.';
  } else {
    status = 'thesis_weakened';
    headline = `Thesis weakened (${analysis.score}/5)`;
    detail =
      'Some conditions have fallen apart — the engine would no longer enter on this picture. It does not ' +
      'invalidate your entry, but trailing the stop beats waiting for the target.';
  }

  const notes = [];
  if (analysis && !analysis.hits.rollover && side === 'SHORT') {
    notes.push('4h momentum points up again — the fade may not reach the target');
  }
  if (plan && plan.toStopPct < 1) {
    notes.push(`${plan.toStopPct.toFixed(2)}% to the stop — one candle at current volatility`);
  }
  if (!pick) {
    notes.push('The entry did not come from this card — there is no plan to measure progress against, use your own stop');
  }
  if (plan?.stopBehindEntry) {
    notes.push(
      `The plan stop ${pick.stop} already sits behind your entry ${position.entryPx} — you entered worse than the plan, ` +
        'so measure this trade with your own stop, not the card’s',
    );
  }
  if (plan && Math.abs(plan.entryDiffPct ?? 0) > 1) {
    const better = isShort ? plan.entryDiffPct > 0 : plan.entryDiffPct < 0;
    notes.push(
      `Your entry ${position.entryPx} vs the plan ${pick.entry} (${plan.entryDiffPct > 0 ? '+' : ''}${plan.entryDiffPct.toFixed(2)}%) — ` +
        `${better ? 'better than plan' : 'worse than plan'}; R is measured from your price`,
    );
  }

  return {
    coin,
    held: true,
    side,
    status,
    headline,
    detail,
    notes,
    position: {
      entryPx: position.entryPx,
      notionalUsd: position.notionalUsd,
      unrealizedPnl: position.unrealizedPnl,
      gainPct,
    },
    plan,
    // score/фичи оставляем для таблицы — но как диагностику позиции, не как вход
    score: analysis?.score ?? null,
    hits: analysis?.hits ?? null,
    features: analysis?.features ?? null,
    flags: analysis?.flags ?? [],
  };
}

/**
 * Монета, которую оператор сегодня отторговал и по которой сетап УЖЕ рассыпался.
 * Не вход и не позиция — напоминание, что день по этой монете закрыт.
 *
 * Показывается только когда движок больше не видит сетапа. Если ход не выдохся,
 * монета остаётся во входах с флагом traded_today: решает состояние рынка, а не
 * факт сделки — иначе карточка прятала бы живое продолжение движения.
 *
 * @param {Object} day — {pnl, count, lastCloseAt, side} итог дня по монете
 */
export function buildTradedTodayView({ coin, analysis, day, price }) {
  const won = day.pnl > 0;
  const notes = [];
  if (analysis?.verdict?.tone === 'setup') {
    notes.push(
      `The setup technically still holds (${analysis.score}/5) — but entering from here is worse: ` +
      'the easy part of the move is done and the stop has to sit further away',
    );
  }
  if (won) {
    notes.push('The trade closed green. A repeat on the same day is the most common way to give it back');
  } else {
    notes.push('The trade closed red. Getting even in the same coin is tilt, not a setup');
  }

  return {
    coin,
    held: true,          // фронт трактует как «не для входа»
    tradedToday: true,
    side: day.side || analysis?.side || null,
    status: 'traded_today',
    // Знак ПЕРЕД долларом: иначе минус уезжает внутрь ($-1.20).
    headline: `Already traded today: ${day.count} ${day.count === 1 ? 'trade' : 'trades'}, ${day.pnl < 0 ? '-' : '+'}$${Math.abs(day.pnl).toFixed(2)}`,
    detail:
      'The day is closed for this coin. The card will not offer another entry — ' +
      'that is protection against “just one more”, not a judgement on the setup.',
    notes,
    day,
    score: analysis?.score ?? null,
    hits: analysis?.hits ?? null,
    features: analysis?.features ?? null,
    flags: [],
  };
}

/**
 * Полный скан: берёт рыночный снапшот бота, отбирает кандидатов, тянет свечи
 * только для них и возвращает разборы, отсортированные по score.
 *
 * Монеты, в которых оператор уже сидит, НЕ попадают в picks — они уходят в held
 * с разбором позиции (см. buildHeldView). Тот же принцип, что у owned-coin
 * guard координатора: не предлагать вход туда, где вход уже сделан.
 *
 * @param {Array} marketRows — state.latestHunter: {coin, price, oiUsd, fundingRate, volume24hUsd, dayChangePct}
 * @param {number} [now]
 * @param {Object} [opts]
 * @param {Map<string,Object>} [opts.positions] — COIN → {side, entryPx, szi, notionalUsd, unrealizedPnl}
 * @param {Map<string,Object>} [opts.picks] — COIN → строка coin_of_day_picks за сегодня
 * @param {Map<string,Object>} [opts.tradedToday] — COIN → {pnl, count, lastCloseAt, side}
 */
export async function scanCoinOfDay(marketRows, now = Date.now(), opts = {}) {
  const positions = opts.positions instanceof Map ? opts.positions : new Map();
  const todayPicks = opts.picks instanceof Map ? opts.picks : new Map();
  const tradedToday = opts.tradedToday instanceof Map ? opts.tradedToday : new Map();
  const rows = Array.isArray(marketRows) ? marketRows : [];
  const banned = config.trading.coinBlacklist;

  // Префильтр без единого сетевого запроса: ликвидность + бан-листы.
  //
  // 🚨 Ход за сутки здесь тоже НЕ фильтр, а ключ сортировки — второй экземпляр
  // того же рубильника, что снят в scoreCoin. Пока он стоял и тут, монета с
  // отработавшим фейдом выпадала из пула ещё до скоринга, и правка внутри
  // scoreCoin ничего бы не изменила.
  // Слоты кандидатов всё равно ограничены (свечи стоят запросов), поэтому топ
  // забирают самые сходившие монеты — но по убыванию, а не по порогу.
  const pool = rows
    .filter((r) => {
      const c = String(r.coin || '').toUpperCase();
      if (!c || banned.has(c) || JOURNAL_BANNED.has(c)) return false;
      if (!(r.price > 0)) return false;
      return r.volume24hUsd >= COD.MIN_VOL_USD;
    })
    .sort((a, b) => Math.abs(b.dayChangePct ?? 0) - Math.abs(a.dayChangePct ?? 0))
    .slice(0, COD.CANDIDATES);

  // Монеты в позиции разбираем ВСЕГДА, даже если они выпали из префильтра
  // (бан-лист, ход выдохся, оборот просел). Иначе позиция, по которой сетап
  // рассыпался, просто исчезла бы с карточки — ровно в тот момент, когда о ней
  // важнее всего сказать. Их анализ не занимает слоты кандидатов.
  const poolCoins = new Set(pool.map((r) => r.coin.toUpperCase()));
  for (const r of rows) {
    const c = String(r.coin || '').toUpperCase();
    if (!c || poolCoins.has(c) || !(r.price > 0)) continue;
    if (!positions.has(c) && !tradedToday.has(c)) continue;
    pool.push(r);
    poolCoins.add(c);
  }

  const analyzed = [];
  const held = [];
  const signals = [];
  for (const r of pool) {
    try {
      // LOW priority: карточка дашборда не должна конкурировать за слоты пула
      // с торговыми чтениями.
      const [c1h, c15] = await Promise.all([
        getHourlyCandles(r.coin, 72, now, HL_PRIORITY.LOW),
        getFifteenMinCandles(r.coin, 14 * 60, now, HL_PRIORITY.LOW),
      ]);
      if (!c1h?.length) continue;
      const a = analyzeCoin({ ...r, c1h, c15: c15 || [] });
      const coinUpper = r.coin.toUpperCase();
      // Форвард-лог пишется из signals, а НЕ из picks. Иначе из замера выпадали
      // бы ровно те сигналы, по которым оператор успел войти (монета уходит в held),
      // — то есть лучшие. Выборка стала бы смещённой, а вся ценность лога в том,
      // что он несмещённый.
      if (a) signals.push(a);
      if (positions.has(coinUpper)) {
        // В позиции: разбор позиции, не вход. analyzeCoin может вернуть null
        // (сетап рассыпался) — buildHeldView это обрабатывает отдельным статусом.
        held.push(
          buildHeldView({
            coin: r.coin,
            analysis: a,
            position: positions.get(coinUpper),
            pick: todayPicks.get(coinUpper) ?? null,
            price: r.price,
          }),
        );
      } else if (tradedToday.has(coinUpper)) {
        // Уже торговал сегодня и вышел. Решает СОСТОЯНИЕ СЕТАПА, а не факт
        // сделки: если ход не выдохся — вход показываем (с пометкой про
        // сегодняшнюю сделку, чтобы это было осознанное решение, а не
        // «карточка снова подсветила»). Если сетап рассыпался — монета
        // сворачивается в «день закрыт» и из входов уходит.
        const day = tradedToday.get(coinUpper);
        if (a && a.verdict.tone === 'setup') {
          a.dayContext = day;
          a.flags = [
            {
              key: 'traded_today',
              severity: 'high',
              text:
                `You already traded this coin today (${day.count} ${day.count === 1 ? 'trade' : 'trades'}, ` +
                `${day.pnl < 0 ? '-' : '+'}$${Math.abs(day.pnl).toFixed(2)}). The setup is still alive, but entering here ` +
                'is a second go in one day: in the journal, losses come from multi-entry days, not single trades',
            },
            ...a.flags,
          ];
          analyzed.push(a);
        } else {
          held.push(
            buildTradedTodayView({ coin: r.coin, analysis: a, day, price: r.price }),
          );
        }
      } else if (a) {
        analyzed.push(a);
      }
    } catch (err) {
      logger.warn(`[CoinOfDay] #${r.coin} analyze failed: ${err.message}`);
    }
  }

  analyzed.sort((a, b) => b.score - a.score || (b.levels?.rr ?? 0) - (a.levels?.rr ?? 0));
  return {
    generatedAt: now,
    scanned: pool.length,
    universe: rows.length,
    held,
    // signals = ВСЕ разборы, включая монеты в позиции. Источник форвард-лога.
    signals,
    picks: analyzed.filter((a) => a.score >= COD.SHOW_MIN_SCORE),
    others: analyzed.filter((a) => a.score < COD.SHOW_MIN_SCORE),
  };
}
