// ─────────────────────────────────────────────────
//  Fade-high-ER — чистое ядро сигнала «fade выдохшегося хвоста»
// ─────────────────────────────────────────────────
// Правило выбрано бэктестами (scripts/backtest*.js, 52д 15m-OHLC, 178 монет) —
// см. memory darkknight_backtest_2026_06_19 / fadehot_build_plan. Это обобщённый
// Hunter: фейдим выдохшийся ХВОСТ протяжённого (high-ER) движения, НЕ ловим нож.
//
//   Вход:  |ход за 30м (2×15m)| ≥ MOVE_THR (3%)  И  Kaufman ER за 4ч (16×15m) ≥ ER_MIN (0.47)
//   Сторона: FADE против хода — памп→SHORT, дамп→LONG.
//   Выход: по ВРЕМЕНИ ~2ч + ШИРОКИЙ защитный стоп ~3% (тесный 1.5% убивает эдж).
//
// ⚠️ Эдж МАРГИНАЛЬНЫЙ (+0.1-0.5%/сделку в хороших окнах, ~0 в 2 из 5 OOS).
// Цель — forward-валидация на живых данных ~месяц, не доход. Решение через месяц.
//
// Чистый модуль (без I/O): свечи инжектятся вызывающим (candleCache 15m). ER/move
// зеркалят scripts/backtestExits.js 1:1, чтобы live совпадал с бэктестом.

// ── Параметры (env-overrideable, дефолты = выбранные бэктестом) ──
export const FADEHOT_MOVE_LB       = parseInt(process.env.FADEHOT_MOVE_LB || '2', 10);        // 30м = 2×15m бара
export const FADEHOT_ER_WIN        = parseInt(process.env.FADEHOT_ER_WIN || '16', 10);        // 4ч = 16×15m баров
export const FADEHOT_MOVE_THR      = parseFloat(process.env.FADEHOT_MOVE_THR || '3');         // |ход| ≥ 3%
export const FADEHOT_ER_MIN        = parseFloat(process.env.FADEHOT_ER_MIN || '0.47');        // Kaufman ER ≥ 0.47 (≈p66)
export const FADEHOT_STOP_PCT      = parseFloat(process.env.FADEHOT_STOP_PCT || '3');         // широкий защитный стоп
export const FADEHOT_TIME_STOP_MIN = parseInt(process.env.FADEHOT_TIME_STOP_MIN || '120', 10); // выход по времени ~2ч

// ── Классификатор режима «рынок горячий» (общий для paper-слота и alert-feed) ──
// Бэктест scripts/backtestMarketRegime.js (см. memory darkknight_backtest): fade-high-ER
// прибылен НЕ всегда, а когда рынок энергичен. Самый OOS-устойчивый признак — Kaufman ER
// самого BTC за 4ч (bounded [0,1]; высокий ER → +1.42%/74% vs низкий +0.27%/58%; разделение
// пережило old/fresh-split). Гейтим на нём. Порог ≈ p66 теста (0.57), чуть ниже для запаса.
export const FADEHOT_REGIME_GATE = (process.env.FADEHOT_REGIME_GATE || 'true').toLowerCase() === 'true';
export const FADEHOT_BTC_ER_MIN  = parseFloat(process.env.FADEHOT_BTC_ER_MIN || '0.55'); // BTC 4ч ER ≥ → «горячо»
export const FADEHOT_BTC_COIN    = process.env.FADEHOT_BTC_COIN || 'BTC';

/**
 * Kaufman Efficiency Ratio по закрытиям: |net change| / Σ|bar change| на окне win.
 * 1 = идеально-направленное движение, ~0 = чоп. Зеркало er() в backtestExits.js.
 *
 * @param {number[]} closes — closes oldest→newest
 * @param {number} win — длина окна (баров)
 * @returns {number|null} ER в [0,1] или null если данных мало / нулевая волатильность
 */
export function kaufmanER(closes, win) {
  const n = closes.length;
  if (!Number.isFinite(win) || win < 1 || n < win + 1) return null;
  const last = n - 1;
  const net = Math.abs(closes[last] - closes[last - win]);
  let vol = 0;
  for (let k = last - win + 1; k <= last; k++) vol += Math.abs(closes[k] - closes[k - 1]);
  return vol > 0 ? net / vol : null;
}

/**
 * Вердикт fade-high-ER по 15m-свечам. Считает ход за MOVE_LB баров и ER за ER_WIN
 * баров на ЗАКРЫТИЯХ (как бэктест). actionable, когда |ход| ≥ moveThr И ER ≥ erMin.
 *
 * @param {Array<{close:number}>} candles — 15m свечи oldest→newest (последняя = текущая)
 * @param {{moveLb?:number, erWin?:number, moveThr?:number, erMin?:number}} [opts]
 * @returns {{
 *   fired:boolean, side:'SHORT'|'LONG'|null, move:number|null, er:number|null,
 *   reason:string|null
 * }}
 *   fired = правило сработало (actionable fade-вход).
 *   reason = почему НЕ сработало ('warmup'|'flat-move'|'low-er') или null если fired.
 */
export function evaluateFadeHot(candles, opts = {}) {
  const moveLb  = opts.moveLb  ?? FADEHOT_MOVE_LB;
  const erWin   = opts.erWin   ?? FADEHOT_ER_WIN;
  const moveThr = opts.moveThr ?? FADEHOT_MOVE_THR;
  const erMin   = opts.erMin   ?? FADEHOT_ER_MIN;

  const none = (reason, extra = {}) => ({ fired: false, side: null, move: null, er: null, reason, ...extra });

  if (!Array.isArray(candles)) return none('warmup');
  const closes = candles.map((c) => c?.close).filter((c) => Number.isFinite(c) && c > 0);
  // Нужно ≥ max(moveLb, erWin)+1 валидных закрытий.
  if (closes.length < Math.max(moveLb, erWin) + 1) return none('warmup');

  const last = closes.length - 1;
  const past = closes[last - moveLb];
  if (!(past > 0)) return none('warmup');
  const move = ((closes[last] - past) / past) * 100;
  const er = kaufmanER(closes, erWin);
  if (er == null) return none('warmup', { move });

  if (Math.abs(move) < moveThr) return none('flat-move', { move, er });
  if (er < erMin) return none('low-er', { move, er });

  // Fade против хода: памп (move>0) → SHORT, дамп (move<0) → LONG.
  const side = move > 0 ? 'SHORT' : 'LONG';
  return { fired: true, side, move, er, reason: null };
}

/**
 * Режим рынка по свечам BTC: «горячо», когда Kaufman ER BTC за erWin баров ≥ порога.
 * Общий гейт для fade-high-ER (открываем/алертим только в горячем рынке).
 *
 * @param {Array<{close:number}>} btcCandles — 15m свечи BTC oldest→newest
 * @param {{erWin?:number, erMin?:number}} [opts]
 * @returns {{btcER:number|null, hot:boolean}}
 */
export function btcRegimeFromCandles(btcCandles, opts = {}) {
  const erWin = opts.erWin ?? FADEHOT_ER_WIN;
  const erMin = opts.erMin ?? FADEHOT_BTC_ER_MIN;
  const closes = (btcCandles ?? []).map((c) => c?.close).filter((c) => Number.isFinite(c) && c > 0);
  const btcER = kaufmanER(closes, erWin);
  return { btcER, hot: btcER != null && btcER >= erMin };
}

/**
 * Зона входа / защитный стоп от текущей цены для fade-вердикта. Зона = у текущей
 * цены (fade — вход против выдохшегося хвоста сразу), стоп — широкий ПРОТИВ нас.
 *
 * @param {'SHORT'|'LONG'} side
 * @param {number} price — текущая цена
 * @param {number} [stopPct=FADEHOT_STOP_PCT]
 * @returns {{zoneLo:number, zoneHi:number, stop:number, stopPct:number}}
 */
export function fadeHotZone(side, price, stopPct = FADEHOT_STOP_PCT) {
  // SHORT: стоп выше цены (ход против = вверх). LONG: зеркало.
  const stop = side === 'SHORT' ? price * (1 + stopPct / 100) : price * (1 - stopPct / 100);
  // Зона входа узкая вокруг текущей цены (вход «по рынку» у хвоста).
  const band = price * 0.0015; // ±0.15%
  return { zoneLo: price - band, zoneHi: price + band, stop, stopPct };
}
