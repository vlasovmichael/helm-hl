// ─────────────────────────────────────────────────
//  Risk tint: «глубина» заливки PnL-карточки по риск-геометрии.
//  Вместо отдельной шкалы карточка uPnL / Net(Mkt) сама переливается:
//  насыщенность фона растёт по мере приближения к цели 2R (зелёный) или к
//  стопу (красный). depth ∈ [0,1] — доля пути от входа до релевантного края:
//    profit: вход(0) → 2R(1)   ·   loss: вход(0) → стоп(1).
//  Цель 2R синтетическая (вход + 2×риск): у ручных/adopt-позиций нет фикс-TP,
//  нянька лишь держит стоп — правый край = ориентир на payoff R:R≥2:1.
//  Геометрия зеркальна для SHORT (цель ниже входа). 2026-06-16.
// ─────────────────────────────────────────────────

const fmtUsd = (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

// { entry, now, side, stopPrice, sizeUsd } → { depth, inProfit, hot, tip }
// или null, если данных мало (напр. неусыновлённая ручная поза без стопа).
export function riskTint({ entry, now, side, stopPrice, sizeUsd } = {}) {
  if (![entry, now, stopPrice].every((v) => v != null && v > 0)) return null;
  const isShort = String(side || "").toUpperCase() === "SHORT";
  const risk = Math.abs(entry - stopPrice); // дистанция вход→стоп в цене
  if (!(risk > 0)) return null;

  // Знаковый ход в мою сторону (>0 = в прибыли). Для SHORT прибыль при падении.
  const move = isShort ? entry - now : now - entry;
  const inProfit = move >= 0;
  // Глубина: 0 у входа; 1 на 2R-цели (прибыль) или на стопе (убыток).
  const depth = inProfit
    ? Math.min(1, move / (2 * risk))
    : Math.min(1, -move / risk);

  // Tooltip в $ на ключевых точках (если знаем размер позиции).
  let tip = "";
  if (sizeUsd != null) {
    const pnlAt = (px) =>
      ((isShort ? (entry - px) / entry : (px - entry) / entry)) * sizeUsd;
    const target = isShort ? entry - 2 * risk : entry + 2 * risk;
    tip = `стоп ${fmtUsd(pnlAt(stopPrice))} · сейчас ${fmtUsd(pnlAt(now))} · цель 2R ${fmtUsd(pnlAt(target))}`;
  }

  return { depth, inProfit, hot: depth >= 0.75, tip };
}
