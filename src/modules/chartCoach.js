// ─────────────────────────────────────────────────────────────────────────
//  Chart Coach — честный РАЗБОР графика (не «проверенный сигнал»)
// ─────────────────────────────────────────────────────────────────────────
//
// Зачем: кнопка What-if отвечала «нет сигнала» почти всегда (гейт по редкому
// fade-эджу ~0.3% времени — это by design). Юзер хочет другое: по любой монете
// + стороне получить РАЗБОР как от коуча — тренд/структура/уровни/RSI, бычий и
// медвежий сценарий и главное «где ты неправ» (инвалидация/стоп).
//
// ВАЖНО (честность): это РАЗБОР, а не сигнал с доказанным forward-эджем. Наши
// бэктесты (darkknight) показали, что continuation теряет, а fade регимо-зависим.
// Поэтому coach НЕ говорит «входи» — он раскладывает структуру и риск, чтобы
// решение принимал человек. Числа считаются по правилам (детерминированно), без
// LLM — нечего галлюцинировать, уровни реальные.
//
// Вход: 15m-свечи (структура/RSI/ATR), 1h-свечи (старший тренд), текущая цена,
// опц. сторона оператора. Выход: структурированный объект для модалки whatif.

/** Wilder RSI по массиву close. Возвращает последнее значение или null. */
export function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  // Первичное среднее по первым `period` изменениям.
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  // Сглаживание Уайлдера по остатку.
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** EMA-последовательность (без зависимостей — coach самодостаточен). */
function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** Тренд по EMA fast/slow + положению цены. 'up'|'down'|'flat'. */
function trendFromEma(closes, price, fast, slow) {
  if (!Array.isArray(closes) || closes.length < slow + 1) return "flat";
  const f = ema(closes, fast).at(-1);
  const s = ema(closes, slow).at(-1);
  if (f == null || s == null) return "flat";
  const sep = ((f - s) / s) * 100;
  if (sep > 0.15 && price >= s) return "up";
  if (sep < -0.15 && price <= s) return "down";
  return "flat";
}

/**
 * Фрактальные свинг-пивоты → ближайшие поддержка/сопротивление от текущей цены.
 * Пивот-хай: high[i] строго ≥ соседей в окне ±k. Пивот-лоу зеркально.
 * Возвращает { support, resistance, supports[], resistances[] }.
 */
export function findLevels(candles, k = 2, price) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  // Поддержка = ближайший пивот-лоу НИЖЕ цены; сопротивление = пивот-хай ВЫШЕ.
  const supports = lows.filter((l) => l < price).sort((a, b) => b - a);
  const resistances = highs.filter((h) => h > price).sort((a, b) => a - b);
  return {
    support: supports[0] ?? null,
    resistance: resistances[0] ?? null,
    supports,
    resistances,
  };
}

const pct = (a, b) => ((a - b) / b) * 100;

/**
 * Главный разбор. Чистая функция (никаких сетевых вызовов).
 * @param {{candles15m:Array, candles1h:Array, price:number, userSide?:('LONG'|'SHORT'|null)}} p
 * @returns {Object} разбор для модалки
 */
export function analyzeChart({ candles15m, candles1h, price, userSide = null }) {
  if (!Array.isArray(candles15m) || candles15m.length < 20 || !(price > 0)) {
    return { ok: false, reason: "not_enough_data" };
  }
  const closes15 = candles15m.map((c) => c.close);
  const closes1h = Array.isArray(candles1h) ? candles1h.map((c) => c.close) : [];

  const htfTrend = closes1h.length >= 51 ? trendFromEma(closes1h, price, 20, 50) : "flat";
  const ltfTrend = trendFromEma(closes15, price, 20, 50);
  const rsi14 = rsi(closes15, 14);
  const atr14 = atr15(candles15m, 14);
  const { support, resistance, supports, resistances } = findLevels(candles15m, 2, price);

  const distToSupport = support != null ? pct(price, support) : null;     // +% выше поддержки
  const distToResistance = resistance != null ? pct(resistance, price) : null; // +% до сопротивления
  const atrPct = atr14 != null ? (atr14 / price) * 100 : null;
  // «Близко к уровню» = в пределах ~0.75 ATR.
  const nearSupport = support != null && atr14 != null && (price - support) <= 0.75 * atr14;
  const nearResistance = resistance != null && atr14 != null && (resistance - price) <= 0.75 * atr14;

  const bull = [], bear = [];
  if (htfTrend === "up") bull.push("Старший тренд (1h) вверх — попутный ветер для лонга.");
  if (htfTrend === "down") bear.push("Старший тренд (1h) вниз — попутный ветер для шорта.");
  if (ltfTrend === "up") bull.push("Локальный тренд (15m) вверх.");
  if (ltfTrend === "down") bear.push("Локальный тренд (15m) вниз.");
  if (nearSupport) bull.push(`Цена у поддержки $${fmt(support)} — зона отскока вверх.`);
  if (nearResistance) bear.push(`Цена у сопротивления $${fmt(resistance)} — зона отбоя вниз.`);
  if (rsi14 != null && rsi14 <= 30) bull.push(`RSI ${rsi14.toFixed(0)} — перепродан (отскок вероятнее).`);
  if (rsi14 != null && rsi14 >= 70) bear.push(`RSI ${rsi14.toFixed(0)} — перекуплен (откат вероятнее).`);

  // План под сторону оператора: стоп за ближайший защищающий уровень, цель — следующий
  // встречный уровень, R = reward/risk. Если уровня нет — стоп по ATR.
  let plan = null, verdict = null;
  if (userSide === "LONG" || userSide === "SHORT") {
    plan = buildPlan({ userSide, price, support, resistance, resistances, supports, atr14 });
    verdict = verdictFor({ userSide, htfTrend, ltfTrend, nearSupport, nearResistance, rsi14, plan });
  }

  return {
    ok: true,
    price,
    htfTrend, ltfTrend,
    rsi14: rsi14 != null ? Math.round(rsi14 * 10) / 10 : null,
    atrPct: atrPct != null ? Math.round(atrPct * 100) / 100 : null,
    support, resistance, distToSupport, distToResistance,
    nearSupport, nearResistance,
    bull, bear,
    userSide, plan, verdict,
    disclaimer:
      "Это разбор структуры, не сигнал с доказанным эджем. Решение и риск — на тебе.",
  };
}

function buildPlan({ userSide, price, support, resistance, resistances, supports, atr14 }) {
  const atrStop = atr14 != null ? atr14 : price * 0.01;
  if (userSide === "LONG") {
    // Стоп под ближайшую поддержку (или −1 ATR), цель — ближайшее сопротивление.
    const stop = support != null ? support - 0.25 * atrStop : price - 1.5 * atrStop;
    const target = resistance ?? (resistances?.[0] ?? null);
    const riskPct = pct(price, stop);                       // >0
    const rewardPct = target != null ? pct(target, price) : null; // >0
    const rr = rewardPct != null && riskPct > 0 ? rewardPct / riskPct : null;
    return { side: "LONG", stop, target, riskPct, rewardPct, rr, invalidation: support };
  }
  // SHORT: стоп над ближайшим сопротивлением, цель — ближайшая поддержка.
  const stop = resistance != null ? resistance + 0.25 * atrStop : price + 1.5 * atrStop;
  const target = support ?? (supports?.[0] ?? null);
  const riskPct = pct(stop, price);                         // >0
  const rewardPct = target != null ? pct(price, target) : null;
  const rr = rewardPct != null && riskPct > 0 ? rewardPct / riskPct : null;
  return { side: "SHORT", stop, target, riskPct, rewardPct, rr, invalidation: resistance };
}

function verdictFor({ userSide, htfTrend, ltfTrend, nearSupport, nearResistance, rsi14, plan }) {
  const wantUp = userSide === "LONG";
  const withHtf = (wantUp && htfTrend === "up") || (!wantUp && htfTrend === "down");
  const againstHtf = (wantUp && htfTrend === "down") || (!wantUp && htfTrend === "up");
  const atGoodLevel = wantUp ? nearSupport : nearResistance;
  const overextended = wantUp ? (rsi14 != null && rsi14 >= 70) : (rsi14 != null && rsi14 <= 30);

  // Тон вердикта: совпадение со старшим трендом + хороший уровень = «разумно».
  // Против тренда без уровня = «ловишь нож». RR < 1 ослабляет любой вердикт.
  let tone, headline, detail;
  if (withHtf && atGoodLevel) {
    tone = "reasonable";
    headline = `${userSide} по тренду от уровня — структурно разумно`;
    detail = `Старший тренд за тебя, цена у защищающего уровня. Стоп за уровень, дальше пусть бежит.`;
  } else if (againstHtf && !atGoodLevel) {
    tone = "knife";
    headline = `${userSide} против тренда без уровня — ловишь нож`;
    detail = `Старший тренд против тебя, и опоры рядом нет. Это контр-тренд в пустоте — высокий риск.`;
  } else if (againstHtf && atGoodLevel) {
    tone = "counter";
    headline = `${userSide} — контр-тренд отскок от уровня`;
    detail = `Против старшего тренда, но от реального уровня. Только быстрый отскок, не разворот: бери малый кусок, стоп жёсткий.`;
  } else {
    tone = "neutral";
    headline = `${userSide} — смешанная картина`;
    detail = `Чёткого попутного тренда или уровня под ${userSide} нет. Преимущество не выражено.`;
  }
  if (overextended) detail += wantUp
    ? " ⚠️ RSI перекуплен — гонишься за уже ушедшим движением."
    : " ⚠️ RSI перепродан — шортишь в дыру.";
  if (plan?.rr != null && plan.rr < 1)
    detail += ` ⚠️ R:R ≈ ${plan.rr.toFixed(2)} — цель ближе стопа, математика против тебя.`;
  return { tone, headline, detail };
}

// Локальные хелперы (без внешних зависимостей для тестируемости).
function atr15(candles, period) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const w = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < w.length; i++) {
    const tr = Math.max(
      w[i].high - w[i].low,
      Math.abs(w[i].high - w[i - 1].close),
      Math.abs(w[i].low - w[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

function fmt(p) {
  if (p == null) return "—";
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}
