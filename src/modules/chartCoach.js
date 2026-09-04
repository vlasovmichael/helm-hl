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

// ── Риск-калькулятор размера ────────────────────────────────────────────────
// Из дистанции до стопа (riskPct) и риск-бюджета (% от депо) считает, каким
// ДОЛЖЕН быть размер позиции, чтобы потеря на стопе = бюджету. Учит «сначала
// риск, потом размер» (антидот к $70-номиналу на $48-депо).
export function sizeForRisk({ equity, riskBudgetPct, riskPct }) {
  if (!(equity > 0) || !(riskBudgetPct > 0) || !(riskPct > 0)) return null;
  const riskUsd = equity * (riskBudgetPct / 100);
  const suggestedSizeUsd = riskUsd / (riskPct / 100); // номинал, теряющий riskUsd на стопе
  return {
    equity,
    riskBudgetPct,
    riskUsd: Math.round(riskUsd * 100) / 100,
    suggestedSizeUsd: Math.round(suggestedSizeUsd * 100) / 100,
  };
}

// ── Санити стопа против ATR ─────────────────────────────────────────────────
// Стоп ближе ~1 ATR = внутри обычного шума свечей → выбьет на ровном месте.
export function stopSanity({ stop, price, atr }) {
  if (!(atr > 0) || stop == null || !(price > 0)) return null;
  const dist = Math.abs(price - stop);
  const mult = dist / atr;
  let level, note;
  if (mult < 0.8) {
    level = "tight";
    note = `Stop ${mult.toFixed(1)}×ATR — inside the noise, it will get taken out for nothing. Use ~1 ATR minimum.`;
  } else if (mult > 3) {
    level = "wide";
    note = `Stop ${mult.toFixed(1)}×ATR — very wide: either size down or find a closer level.`;
  } else {
    level = "ok";
    note = `Stop ${mult.toFixed(1)}×ATR — outside the noise, sensible.`;
  }
  return { mult: Math.round(mult * 10) / 10, level, note };
}

// ── Order-flow: что под движением (OI / объём / funding) ────────────────────
// HL-native чтение потока. priceUp + OI up = новые позиции (реальный ход);
// priceUp + OI down = закрытие противоположных (слабее, топливо иссякает).
export function readOrderFlow({ priceMovePct, oiDeltaPct, volMult, funding }) {
  const lines = [];
  if (oiDeltaPct != null && priceMovePct != null && Math.abs(priceMovePct) >= 0.2) {
    const up = priceMovePct > 0;
    const oiUp = oiDeltaPct > 0.3;
    const oiDn = oiDeltaPct < -0.3;
    if (up && oiUp) lines.push(`Price ↑ + OI ↑ ${fmtSigned(oiDeltaPct)}% — new longs coming in, positions confirm the move.`);
    else if (up && oiDn) lines.push(`Price ↑ + OI ↓ ${fmtSigned(oiDeltaPct)}% — shorts covering (a squeeze), the fuel is running out.`);
    else if (!up && oiUp) lines.push(`Price ↓ + OI ↑ ${fmtSigned(oiDeltaPct)}% — new shorts coming in, the pressure is real.`);
    else if (!up && oiDn) lines.push(`Price ↓ + OI ↓ ${fmtSigned(oiDeltaPct)}% — longs exiting or being liquidated (capitulation, can reverse).`);
  }
  if (volMult != null) {
    if (volMult >= 1.5) lines.push(`Volume ${volMult.toFixed(1)}× average — there is conviction.`);
    else if (volMult <= 0.7) lines.push(`Volume ${volMult.toFixed(1)}× average — thin, do not trust the move.`);
  }
  if (funding != null && Math.abs(funding) >= 0.0002) {
    const apr = funding * 24 * 365 * 100; // часовая ставка → ~годовых, грубо
    if (funding > 0) lines.push(`Funding +${(funding * 100).toFixed(3)}% (~${apr.toFixed(0)}% APR) — longs are paying, the crowd is long (risk for a long).`);
    else lines.push(`Funding ${(funding * 100).toFixed(3)}% — shorts are paying, the crowd is short (risk for a short).`);
  }
  return lines;
}

function fmtSigned(v) { return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`; }

/**
 * Главный разбор. Чистая функция (никаких сетевых вызовов).
 * @param {{candles15m:Array, candles1h:Array, price:number, userSide?:('LONG'|'SHORT'|null)}} p
 * @returns {Object} разбор для модалки
 */
export function analyzeChart({
  candles15m, candles1h, price, userSide = null,
  equity = null, riskBudgetPct = 1, flow = null,
}) {
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
  if (htfTrend === "up") bull.push("Higher timeframe (1h) is up — tailwind for a long.");
  if (htfTrend === "down") bear.push("Higher timeframe (1h) is down — tailwind for a short.");
  if (ltfTrend === "up") bull.push("Local trend (15m) is up.");
  if (ltfTrend === "down") bear.push("Local trend (15m) is down.");
  if (nearSupport) bull.push(`Price at support $${fmt(support)} — a bounce zone.`);
  if (nearResistance) bear.push(`Price at resistance $${fmt(resistance)} — a rejection zone.`);
  if (rsi14 != null && rsi14 <= 30) bull.push(`RSI ${rsi14.toFixed(0)} — oversold (a bounce is more likely).`);
  if (rsi14 != null && rsi14 >= 70) bear.push(`RSI ${rsi14.toFixed(0)} — overbought (a pullback is more likely).`);

  // План под сторону оператора: стоп за ближайший защищающий уровень, цель — следующий
  // встречный уровень, R = reward/risk. Если уровня нет — стоп по ATR.
  let plan = null, verdict = null, sizing = null, stop = null;
  if (userSide === "LONG" || userSide === "SHORT") {
    plan = buildPlan({ userSide, price, support, resistance, resistances, supports, atr14 });
    verdict = verdictFor({ userSide, htfTrend, ltfTrend, nearSupport, nearResistance, rsi14, plan });
    // Риск-калькулятор размера (если знаем депо).
    sizing = sizeForRisk({ equity, riskBudgetPct, riskPct: plan?.riskPct });
    // Санити стопа против ATR.
    stop = stopSanity({ stop: plan?.stop, price, atr: atr14 });
  }

  // Order-flow (OI/объём/funding) — независимо от стороны.
  const orderFlow = flow ? readOrderFlow(flow) : [];

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
    sizing, stopSanity: stop, orderFlow,
    disclaimer:
      "Structure analysis, not a proven-edge signal. The decision and the risk are yours.",
  };
}

/**
 * Мульти-ТФ разбор «куда и когда» для журнала. Три таймфрейма как РОЛИ, а не
 * три сигнала (важно — сигнал входа эджа не несёт, эдж в выходе):
 *   4h — направление: можно ли вообще искать вход в эту сторону (фильтр против
 *        контр-тренда, главный леак ловли ножей);
 *   1h — зона входа и где стоп (ближайшие уровни + ATR);
 *   5m — тайминг: сложился ли триггер в сторону старшего тренда, или ещё рано.
 * Bias берём из согласия 4h+1h. Если 4h и 1h спорят — лучший вход = не входить.
 * Чистая функция (никаких сетевых вызовов), детерминированно, без LLM.
 * @param {{candles4h:Array, candles1h:Array, candles5m:Array, price:number}} p
 */
export function analyzeMultiTF({ candles4h, candles1h, candles5m, price }) {
  if (!(price > 0) || !Array.isArray(candles1h) || candles1h.length < 20) {
    return { ok: false, reason: "not_enough_data" };
  }
  const closes = (arr) => (Array.isArray(arr) ? arr.map((c) => c.close) : []);
  const c4 = closes(candles4h), c1 = closes(candles1h), c5 = closes(candles5m);
  // Тренд по EMA: если баров хватает на 20/50 — берём их, иначе 9/21 (короткий 5m).
  const trend = (cl, px) =>
    cl.length >= 51 ? trendFromEma(cl, px, 20, 50)
      : cl.length >= 22 ? trendFromEma(cl, px, 9, 21) : "flat";

  const trend4h = trend(c4, price);
  const trend1h = trend(c1, price);
  const trend5m = trend(c5, price);
  const rsi1h = rsi(c1, 14);
  const rsi5m = rsi(c5, 14);
  const atr1h = atr15(candles1h, 14);
  const atrPct1h = atr1h != null ? (atr1h / price) * 100 : null;
  const { support, resistance, supports, resistances } = findLevels(candles1h, 2, price);
  const nearSupport = support != null && atr1h != null && (price - support) <= 0.75 * atr1h;
  const nearResistance = resistance != null && atr1h != null && (resistance - price) <= 0.75 * atr1h;

  // Bias = согласие старшего (4h) и среднего (1h) тренда. Спорят → в сторону.
  let bias;
  if (trend4h === "up" && trend1h !== "down") bias = "LONG";
  else if (trend4h === "down" && trend1h !== "up") bias = "SHORT";
  else if (trend4h === "flat" && trend1h === "up") bias = "LONG";
  else if (trend4h === "flat" && trend1h === "down") bias = "SHORT";
  else bias = "STAND_ASIDE";

  // 4h — направление (куда смотреть).
  const note4h =
    trend4h === "up" ? "uptrend — look for LONGS, a short fights the wind"
      : trend4h === "down" ? "downtrend — look for SHORTS, a long fights the wind"
        : "range — no direction, entering without an edge is a lottery";

  // 1h — зона входа и где стоп.
  let note1h;
  if (nearSupport && nearResistance) note1h = `squeezed between support $${fmt(support)} and resistance $${fmt(resistance)} — the range is tighter than ATR, no trade either way`;
  else if (nearSupport) note1h = `price at support $${fmt(support)} — long zone, stop BELOW it`;
  else if (nearResistance) note1h = `price at resistance $${fmt(resistance)} — short zone, stop ABOVE it`;
  else note1h = `between levels (support $${fmt(support)} / resistance $${fmt(resistance)}) — entering in the void, wait for an edge`;

  // 5m — тайминг: триггер в сторону bias.
  let triggerReady = false, triggerNote;
  if (bias === "LONG") {
    triggerReady = nearSupport && trend5m === "up";
    triggerNote = triggerReady
      ? "5m turned up at support — the trigger is there"
      : nearSupport ? "at support, but 5m has not turned up yet — too early"
        : "not at a level — wait for the long trigger at support";
  } else if (bias === "SHORT") {
    triggerReady = nearResistance && trend5m === "down";
    triggerNote = triggerReady
      ? "5m turned down at resistance — the trigger is there"
      : nearResistance ? "at resistance, but 5m has not turned down yet — too early"
        : "not at a level — wait for the short trigger at resistance";
  } else {
    triggerNote = "no direction — nothing to time against";
  }

  // Вердикт «куда и когда».
  let verdict, plan = null;
  if (bias === "STAND_ASIDE") {
    verdict = {
      tone: "neutral",
      headline: "Stand aside — 4h and 1h disagree",
      detail: `The higher (4h ${trTxt(trend4h)}) and middle (1h ${trTxt(trend1h)}) trends disagree. Direction is unclear; the best entry here is none — wait until they agree.`,
    };
  } else {
    plan = buildPlan({ userSide: bias, price, support, resistance, resistances, supports, atr14: atr1h });
    const atLevel = bias === "LONG" ? nearSupport : nearResistance;
    // 🚨 Жёсткие ворота на зелёный вердикт: триггер 5m сам по себе ≠ сделка.
    // · 4h flat → направления нет, bias от 1h — это наклон, не тренд;
    // · зона-конфликт → шорт прямо над поддержкой / лонг под сопротивлением;
    // · R:R < 1.5 → математика против, цель ближе стопа.
    const flat4h = trend4h === "flat";
    const zoneConflict = bias === "LONG" ? nearResistance : nearSupport;
    const rrOk = plan.rr != null && plan.rr >= 1.5;
    if (triggerReady && !flat4h && !zoneConflict && rrOk) {
      verdict = {
        tone: "reasonable",
        headline: `${bias} — conditions line up`,
        detail: `4h is with you, price is at a 1h level, 5m gave the trigger. Stop beyond the level ($${fmt(plan.invalidation ?? plan.stop)}), R:R ≈ ${plan.rr.toFixed(2)}. After that the exit goes to the bot (adopt).`,
      };
    } else if (triggerReady) {
      const why = [];
      if (flat4h) why.push("4h is ranging — no direction, the bias comes from 1h alone");
      if (zoneConflict) why.push(bias === "SHORT" ? `price sits right above support $${fmt(support)} — nowhere to short into` : `price sits under resistance $${fmt(resistance)} — nowhere to long into`);
      if (!rrOk) why.push(`R:R ≈ ${plan.rr != null ? plan.rr.toFixed(2) : "—"} < 1.5 — the target is closer than the stop`);
      verdict = {
        tone: "counter",
        headline: `${bias} trigger is there, but there is NO trade`,
        detail: `${why.join("; ")}. A trigger without location and maths is not an entry — skip it.`,
      };
    } else if (atLevel) {
      verdict = {
        tone: "counter",
        headline: `${bias} — wait for the 5m trigger`,
        detail: `Direction (4h) and zone (1h) are there, but 5m has not confirmed. Do not front-run it — enter on the 5m turn in the ${bias} direction.`,
      };
    } else {
      verdict = {
        tone: "neutral",
        headline: `${bias}, but early — price is not at a level`,
        detail: `The trend favours ${bias}, but price is in the void between 1h levels. Entering here means poor R:R. Wait for it to reach ${bias === "LONG" ? "support" : "resistance"}.`,
      };
    }
  }

  const round = (v, d = 1) => (v != null ? Math.round(v * 10 ** d) / 10 ** d : null);
  return {
    ok: true,
    price,
    bias,
    tf: {
      h4: { trend: trend4h, note: note4h },
      h1: { trend: trend1h, rsi: round(rsi1h), atrPct: round(atrPct1h, 2), support, resistance, nearSupport, nearResistance, note: note1h },
      m5: { trend: trend5m, rsi: round(rsi5m), triggerReady, note: triggerNote },
    },
    verdict,
    plan,
    disclaimer: "Structure analysis, not a proven-edge signal. The edge is in the exit (adopt). Enter via 4h→1h→5m so you do not catch a knife.",
  };
}

function trTxt(t) { return t === "up" ? "up" : t === "down" ? "down" : "range"; }

function buildPlan({ userSide, price, support, resistance, resistances, supports, atr14 }) {
  const atrStop = atr14 != null ? atr14 : price * 0.01;
  if (userSide === "LONG") {
    // Стоп под ближайшую поддержку (или −1 ATR).
    const stop = support != null ? support - 0.25 * atrStop : price - 1.5 * atrStop;
    // Цель — ближайшее сопротивление. Если выше нет (цена у вершины) — проекция:
    // measured-move от стопа (1:1) или ≥1.5 ATR, помечаем targetProjected.
    let target = resistance ?? (resistances?.[0] ?? null);
    let targetProjected = false;
    if (target == null) {
      target = price + Math.max(price - stop, 1.5 * atrStop);
      targetProjected = true;
    }
    const riskPct = pct(price, stop);                       // >0
    const rewardPct = pct(target, price);                  // >0
    const rr = riskPct > 0 ? rewardPct / riskPct : null;
    return { side: "LONG", stop, target, targetProjected, riskPct, rewardPct, rr, invalidation: support };
  }
  // SHORT: стоп над ближайшим сопротивлением, цель — ближайшая поддержка.
  const stop = resistance != null ? resistance + 0.25 * atrStop : price + 1.5 * atrStop;
  let target = support ?? (supports?.[0] ?? null);
  let targetProjected = false;
  if (target == null) {
    target = price - Math.max(stop - price, 1.5 * atrStop);
    targetProjected = true;
  }
  const riskPct = pct(stop, price);                         // >0
  const rewardPct = pct(price, target);
  const rr = riskPct > 0 ? rewardPct / riskPct : null;
  return { side: "SHORT", stop, target, targetProjected, riskPct, rewardPct, rr, invalidation: resistance };
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
    headline = `${userSide} with the trend off a level — structurally sound`;
    detail = `The higher trend is with you and price sits at a protecting level. Stop beyond the level, then let it run.`;
  } else if (againstHtf && !atGoodLevel) {
    tone = "knife";
    headline = `${userSide} against the trend with no level — catching a knife`;
    detail = `The higher trend is against you and there is no support nearby. Counter-trend in the void — high risk.`;
  } else if (againstHtf && atGoodLevel) {
    tone = "counter";
    headline = `${userSide} — counter-trend bounce off a level`;
    detail = `Against the higher trend but off a real level. A quick bounce, not a reversal: take a small piece, keep the stop tight.`;
  } else {
    tone = "neutral";
    headline = `${userSide} — mixed picture`;
    detail = `No clear tailwind trend or level supporting a ${userSide}. No pronounced advantage.`;
  }
  if (overextended) detail += wantUp
    ? " ⚠️ RSI overbought — you are chasing a move that already happened."
    : " ⚠️ RSI oversold — you are shorting into a hole.";
  if (plan?.rr != null && plan.rr < 1)
    detail += ` ⚠️ R:R ≈ ${plan.rr.toFixed(2)} — the target is closer than the stop, the maths is against you.`;
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
