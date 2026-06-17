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

  // Выбор фазы: что меряем прямо сейчас.
  let phase, frac, label, milestonePx;
  if (!inProfit) {
    phase = "stop";
    label = "до стопа";
    frac = Math.min(1, -move / risk);
    milestonePx = stopPrice;
  } else if (armDist != null && !armed) {
    phase = "arm";
    label = "до храповика";
    frac = Math.min(1, move / armDist);
    milestonePx = isShort ? entry - armDist : entry + armDist;
  } else {
    // Храповик взят (или его нет) → меряем отрезок до цели прибыли.
    const base = armed && armDist != null ? armDist : 0; // старт отрезка
    const span = Math.max(targetDist - base, 1e-9);
    phase = "profit";
    label = "до профита";
    frac = Math.min(1, Math.max(0, (move - base) / span));
    milestonePx = isShort ? entry - targetDist : entry + targetDist;
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

  return { inProfit, now: frac, phase, label, hot: frac >= 0.85, tip };
}
