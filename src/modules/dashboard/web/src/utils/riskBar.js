// ─────────────────────────────────────────────────
//  Risk tint: risk-bar как ФОН PnL-карточки, ФАЗАМИ по ближайшей цели.
//  Карточка uPnL / Net(Mkt) сама несёт полосу: фон заливается слева направо,
//  длина = прогресс до СЛЕДУЮЩЕЙ вехи, а не до абстрактного 2R. Веха меняется:
//    · в убытке      → «до стопа»     (entry → stop, красный)
//    · в плюсе, до   → «до храповика» (entry → BE-arm, зелёный) — пока бот не
//      переставил стоп в безубыток;
//    · храповик взят → «до профита»  (BE-arm → 2R/TP, зелёный) — полоса
//      пересчитывается с нуля на новый отрезок.
//  Так оператор видит ровно один вопрос за раз: «сколько осталось до ближайшего
//  события». now ∈ [0,1] — край заливки (прогресс фазы). 2026-06-17.
// ─────────────────────────────────────────────────

const fmtUsd = (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const fmtPct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

// {entry, now, side, stopPrice, sizeUsd, beArmPct, beArmed, tpPrice}
//   → { inProfit, now, phase, label, hot, tip } | null
// null, если данных мало (напр. неусыновлённая ручная поза без стопа).
export function riskTint({
  entry,
  now,
  side,
  stopPrice,
  sizeUsd,
  beArmPct,
  beArmed,
  tpPrice,
  peakPct,
} = {}) {
  if (![entry, now, stopPrice].every((v) => v != null && v > 0)) return null;
  const isShort = String(side || "").toUpperCase() === "SHORT";
  const risk = Math.abs(entry - stopPrice); // дистанция вход→стоп в цене
  if (!(risk > 0)) return null;

  // Ход в мою сторону (>0 = в прибыли), в цене. Для SHORT прибыль при падении.
  const move = isShort ? entry - now : now - entry;
  const inProfit = move >= 0;

  // Веха храповика (BE-arm) и цель прибыли в цене (favorable-дистанция от входа).
  const armDist = beArmPct != null && beArmPct > 0 ? entry * (beArmPct / 100) : null;
  const targetDist = tpPrice != null ? Math.abs(entry - tpPrice) : 2 * risk;
  const armed = beArmed === true || (armDist != null && move >= armDist);

  // Пиковый ход в мою сторону (MFE) в цене — для «призрака» отката на заливке.
  // peakPct хранит бэк как favorable %, всегда ≥0. null → призрака нет.
  const peakMove = peakPct != null && peakPct > 0 ? entry * (peakPct / 100) : null;

  // Выбор фазы: что меряем прямо сейчас. fracOf(m) — доля той же фазы для
  // произвольного favorable-хода m (используем и для текущего, и для пика).
  let phase, label, milestonePx, fracOf;
  if (!inProfit) {
    phase = "stop";
    label = "до стопа";
    milestonePx = stopPrice;
    fracOf = (m) => Math.min(1, -m / risk);
  } else if (armDist != null && !armed) {
    phase = "arm";
    label = "до храповика";
    milestonePx = isShort ? entry - armDist : entry + armDist;
    fracOf = (m) => Math.min(1, Math.max(0, m / armDist));
  } else {
    // Храповик взят (или его нет) → меряем отрезок до цели прибыли.
    const base = armed && armDist != null ? armDist : 0; // старт отрезка
    const span = Math.max(targetDist - base, 1e-9);
    phase = "profit";
    label = "до профита";
    milestonePx = isShort ? entry - targetDist : entry + targetDist;
    fracOf = (m) => Math.min(1, Math.max(0, (m - base) / span));
  }
  const frac = fracOf(move);

  // «Призрак» отката: дальняя граница = пик (MFE), ближняя = текущий. Показываем
  // только в прибыльных фазах (на красной «до стопа» полосе favorable-пик не
  // ложится на ту же ось) и только если пик реально впереди текущего.
  let peak = null;
  if (inProfit && peakMove != null && peakMove > move) {
    peak = fracOf(peakMove);
    if (!(peak > frac)) peak = null; // в одну точку схлопнулось — нечего рисовать
  }

  // Tooltip: сколько ещё ($ + %) до вехи текущей фазы.
  let tip = label;
  const remPct = ((milestonePx - now) / entry) * 100 * (isShort ? -1 : 1);
  tip += ` ${fmtPct(remPct)}`;
  if (sizeUsd != null) {
    const remUsd =
      ((isShort ? (now - milestonePx) / entry : (milestonePx - now) / entry)) *
      sizeUsd;
    tip += ` (${fmtUsd(remUsd)})`;
  }

  return { inProfit, now: frac, peak, phase, label, hot: frac >= 0.85, tip };
}
