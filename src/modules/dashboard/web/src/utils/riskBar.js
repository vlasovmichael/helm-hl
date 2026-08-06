// ─────────────────────────────────────────────────
//  Risk tint: risk-bar как ФОН PnL-карточки, ФАЗАМИ по ближайшей цели.
//  Карточка uPnL / Net(Mkt) сама несёт полосу: фон заливается слева направо,
//  длина = прогресс до СЛЕДУЮЩЕЙ вехи, а не до абстрактного 2R. Веха меняется:
//    · в убытке      → «до стопа»     (entry → stop, красный)
//    · в плюсе, до   → «до храповика» (entry → BE-arm, зелёный) — пока бот не
//      переставил стоп в безубыток;
//    · храповик взят → «до трейла»    (BE-arm → TRAIL-arm, зелёный) — пока
//      нянька не начала вести пик; ⚠️ трейл взводится по ПИКУ (MFE), поэтому
//      веху берёт «призрак» (--rb-peak), а не яркий край;
//    · трейл ведёт   → «до профита»  (TRAIL-arm → 2R/TP, зелёный) — полоса
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
  trailArmPct,
  trailArmed,
  tpPrice,
  peakPct,
  maePct,
} = {}) {
  if (![entry, now, stopPrice].every((v) => v != null && v > 0)) return null;
  const isShort = String(side || "").toUpperCase() === "SHORT";
  const risk = Math.abs(entry - stopPrice); // дистанция вход→стоп в цене
  if (!(risk > 0)) return null;

  // Ход в мою сторону (>0 = в прибыли), в цене. Для SHORT прибыль при падении.
  const move = isShort ? entry - now : now - entry;
  const inProfit = move >= 0;

  // Веха храповика (BE-arm) и цель прибыли в цене (favorable-дистанция от входа).
  const rawArmDist = beArmPct != null && beArmPct > 0 ? entry * (beArmPct / 100) : null;
  const targetDist = tpPrice != null ? Math.abs(entry - tpPrice) : 2 * risk;
  // Храповик выключают, задрав порог за небо (ADOPT_BE_ARM_PCT=999). Веха, до
  // которой цена не дойдёт раньше самой цели прибыли — не веха: иначе фаза «до
  // храповика» съедает весь плюс и полоса стоит на нуле, пока в минусе живёт.
  const armDist = rawArmDist != null && rawArmDist < targetDist ? rawArmDist : null;
  const armed = beArmed === true || (armDist != null && move >= armDist);

  // Веха трейла — та же проверка «веха раньше цели», иначе она не веха.
  const rawTrailDist =
    trailArmPct != null && trailArmPct > 0 ? entry * (trailArmPct / 100) : null;
  const trailDist =
    rawTrailDist != null && rawTrailDist < targetDist ? rawTrailDist : null;

  // Пиковый ход в мою сторону (MFE) в цене — для «призрака» отката на заливке.
  // peakPct хранит бэк как favorable %, всегда ≥0. null → призрака нет.
  const peakMove = peakPct != null && peakPct > 0 ? entry * (peakPct / 100) : null;
  // Трейл взводится по ПИКУ, а не по текущей цене: откат ниже порога его уже не
  // снимает. Поэтому сравниваем именно peakMove (бэк присылает trailArmed — он
  // главнее, локальный расчёт нужен между тиками поллинга).
  const trailOn =
    trailArmed === true ||
    (trailDist != null && peakMove != null && peakMove >= trailDist);
  // Худшая просадка (MAE) в цене — для зеркального «призрака» на красной полосе.
  // maePct хранит бэк как unrealized %, в минусе ≤0. <0 → было хуже текущего.
  const maeMove = maePct != null && maePct < 0 ? entry * (maePct / 100) : null;

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
  } else if (trailDist != null && !trailOn) {
    // Храповик взят (или выключен), трейл ещё нет — это и есть ближайшее
    // событие. Раньше этой фазы не было: полоса сразу мерила до 2R (≈+10% при
    // стопе 5%), ползла на четверть и трейл на +2% в ней было не разглядеть.
    const base = armed && armDist != null ? armDist : 0;
    const span = Math.max(trailDist - base, 1e-9);
    phase = "trail";
    label = "до трейла";
    milestonePx = isShort ? entry - trailDist : entry + trailDist;
    fracOf = (m) => Math.min(1, Math.max(0, (m - base) / span));
  } else {
    // Трейл ведёт (или вех больше нет) → меряем отрезок до цели прибыли.
    const base = trailOn && trailDist != null
      ? trailDist
      : armed && armDist != null
        ? armDist
        : 0; // старт отрезка
    const span = Math.max(targetDist - base, 1e-9);
    phase = "profit";
    label = "до профита";
    milestonePx = isShort ? entry - targetDist : entry + targetDist;
    fracOf = (m) => Math.min(1, Math.max(0, (m - base) / span));
  }
  const frac = fracOf(move);

  // «Призрак» отката: дальняя граница = экстремум, ближняя = текущий. В плюсе
  // это MFE (сколько прошёл и сдал), в минусе — MAE (как глубоко просел и отыграл).
  // Обе величины ложатся на ось текущей фазы; рисуем, только если экстремум
  // реально дальше текущего (есть что показать «хвостом»).
  let peak = null;
  if (inProfit && peakMove != null && peakMove > move) {
    peak = fracOf(peakMove);
    if (!(peak > frac)) peak = null; // в одну точку схлопнулось — нечего рисовать
  } else if (!inProfit && maeMove != null && maeMove < move) {
    // На фазе «до стопа» fracOf(m)=−m/risk: более отрицательный MAE → дальше к стопу.
    peak = fracOf(maeMove);
    if (!(peak > frac)) peak = null;
  }

  // Веха текущей фазы в favorable-% от входа — для подписи «→ TRAIL +2.00%»
  // прямо на карточке, чтобы порог читался без наведения мышью.
  const milestonePct =
    (isShort ? entry - milestonePx : milestonePx - entry) / entry * 100;

  // Tooltip: сколько ещё ($ + %) до вехи текущей фазы. На фазе трейла остаток
  // считаем от ПИКА (он и взводит трейл), иначе тултип обещал бы больше, чем
  // на самом деле осталось: пик уже ближе к вехе, чем текущая цена.
  let tip = label;
  const gapRef = phase === "trail" && peakMove != null && peakMove > move
    ? (isShort ? entry - peakMove : entry + peakMove)
    : now;
  const remPct = ((milestonePx - gapRef) / entry) * 100 * (isShort ? -1 : 1);
  tip += ` ${fmtPct(remPct)}`;
  if (sizeUsd != null) {
    const remUsd =
      ((isShort ? (gapRef - milestonePx) / entry : (milestonePx - gapRef) / entry)) *
      sizeUsd;
    tip += ` (${fmtUsd(remUsd)})`;
  }
  if (gapRef !== now) tip += " по пику";

  return {
    inProfit,
    now: frac,
    peak,
    phase,
    label,
    milestonePct,
    hot: frac >= 0.85,
    tip,
  };
}
