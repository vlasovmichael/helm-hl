// ─────────────────────────────────────────────────
//  Hot Movers — momentum / OI-режим (чистая логика).
//  ⚠️ Серверный двойник в src/modules/hotMoversSetup.js — держать в синхроне.
//  Вынесено из main.js: pure-функции без зависимостей от состояния дашборды.
// ─────────────────────────────────────────────────

const _SVG_ARROW_DOWN = `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-bottom:1px"><path d="M6 1v8M3 7l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
const _SVG_ARROW_UP = `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-bottom:1px"><path d="M6 11V3M3 5l3-3 3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
const _SVG_WAIT = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-bottom:1px;opacity:0.7"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 4v2.5l1.5 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>`;

const _MOM_WEIGHTS = { 2: 0.2, 5: 0.4, 15: 0.8, 60: 1.2 };

const HM_ENTRY_ZONE_PCT = 0.5;
const HM_ENTRY_EXT_PCT = 2.5;
const HM_ENTRY_MIN_SCORE = 3; // = порог рамки Setup (score≥3 + mode)

export function deriveOiKind(s) {
  const d15 = s?.oiDelta15m, d5 = s?.oiDelta5m;
  if (typeof d15 === "number" && isFinite(d15)) {
    if (d15 >= 1) return "up";
    if (d15 <= -1) return "down";
    return "flat";
  }
  if (typeof d5 === "number" && isFinite(d5)) {
    if (d5 >= 0.5) return "up";
    if (d5 <= -0.5) return "down";
    return "flat";
  }
  return null;
}

export function oiDeltaStr(s) {
  const d15 = s?.oiDelta15m, d5 = s?.oiDelta5m;
  if (typeof d15 === "number" && isFinite(d15))
    return `${d15 >= 0 ? "+" : ""}${d15.toFixed(1)}%/15m`;
  if (typeof d5 === "number" && isFinite(d5))
    return `${d5 >= 0 ? "+" : ""}${d5.toFixed(1)}%/5m`;
  return "—";
}

export function deriveAccelKind(w2, w5) {
  if (!w2 || !w5 || w2.spikePct == null || w5.spikePct == null) return null;
  const a = w2.spikePct,
    b = w5.spikePct;
  if (Math.abs(b) < 0.05) return "flat";
  if (a > 0 !== b > 0 && Math.abs(a) > 0.2) return "rev";
  const ratio = Math.abs(a) / Math.abs(b * 0.4);
  return ratio >= 1.2 ? "up" : ratio <= 0.6 ? "down" : "flat";
}

export function deriveVolKind(volMult) {
  if (typeof volMult !== "number" || !isFinite(volMult)) return null;
  if (volMult >= 2) return "high";
  if (volMult >= 1.3) return "mid";
  if (volMult <= 0.5) return "thin";
  return "normal";
}

// Глушить ли fade против синхронного слива (зеркало isFadeMutedByFlush на сервере).
function fadeMutedByFlush(side, mode, flush) {
  if (!flush?.active || mode !== "fade") return false;
  return (
    (flush.dir === "down" && side === "LONG") || (flush.dir === "up" && side === "SHORT")
  );
}

export function computeMomentum(windows, accelKind, volKind, signal, flush) {
  let weighted = 0;
  let haveData = false;
  for (const w of windows) {
    if (w.spikePct == null) continue;
    const wt = _MOM_WEIGHTS[w.mins];
    if (wt == null) continue;
    weighted += w.spikePct * wt;
    haveData = true;
  }
  if (!haveData) {
    return {
      label: '<span class="num-inline-muted">—</span>',
      cls: "setup-none",
      title: "Нет данных",
      score: 0,
      side: null,
      mode: null,
    };
  }
  const priceUp = weighted > 0;
  let score = Math.abs(weighted);
  // Ускорение относительно тренда: ↑ подтверждает, выдох/разворот — штрафуют.
  if (accelKind === "up") score *= 1.15;
  else if (accelKind === "down") score *= 0.8;
  else if (accelKind === "rev") score *= 0.6;
  // Объём подтверждает реальность хода.
  if (volKind === "high") score *= 1.15;
  else if (volKind === "thin") score *= 0.85;

  // OI решает режим: trend = по движению, fade = против.
  const oiKind = deriveOiKind(signal);
  const oiStr = oiDeltaStr(signal);
  let side, mode, why;
  if (oiKind === "up") {
    mode = "trend";
    side = priceUp ? "LONG" : "SHORT";
    why = priceUp
      ? `цена↑ + OI↑ (${oiStr}) = новые лонги, реальный спрос`
      : `цена↓ + OI↑ (${oiStr}) = новые шорты давят`;
  } else if (oiKind === "down") {
    mode = "fade";
    side = priceUp ? "SHORT" : "LONG";
    why = priceUp
      ? `цена↑ + OI↓ (${oiStr}) = short-covering / выдох`
      : `цена↓ + OI↓ (${oiStr}) = лонгов вынесло, выдох`;
  } else {
    // OI флэт или нет данных — направление по движению, режим не подтверждён.
    mode = null;
    side = priceUp ? "LONG" : "SHORT";
    why = oiKind === "flat" ? `OI флэт (${oiStr}) — режим не подтверждён` : "OI: нет данных";
  }

  // Breadth-слив: fade против синхронного делевереджа = лов ножа. Снимаем режим
  // (пилл остаётся, но не actionable: 🎯-зона/ntfy гаснут), помечаем в подсказке.
  if (fadeMutedByFlush(side, mode, flush)) {
    mode = null;
    const sharePct = Math.round((flush.share || 0) * 100);
    why = `рыночный слив (${sharePct}% топа OI↓) — fade ненадёжен, лов ножа`;
  }

  // Fade = ставка на ВЫДОХ. Гасим actionable, если выдоха нет: (a) движение
  // ускоряется в свою сторону (accel↑ — нож разгоняется, не тормозит; ср.
  // коммент колонки ACC «≥1.2 = ускорение, не фейди»); (b) фейдим ПО старшему
  // 1h-тренду (fade-short при тренде вверх / fade-long при тренде вниз) — это
  // движение по тренду, не откат под фейд. Держать в синхроне с
  // fadeExhaustionMuted() на сервере (hotMoversSetup.js).
  const htf = signal?.htfTrend ?? null;
  if (mode === "fade") {
    if (accelKind === "up") {
      mode = null;
      why = `⛔ ускорение в сторону движения — не выдох (нож разгоняется) · ${why}`;
    } else if (priceUp && htf === "up") {
      mode = null;
      why = `⛔ 1h-тренд ВВЕРХ — фейд-шорт против тренда · ${why}`;
    } else if (!priceUp && htf === "down") {
      mode = null;
      why = `⛔ 1h-тренд ВНИЗ — фейд-лонг против тренда · ${why}`;
    }
  }

  const sideUp = side === "LONG";
  const arrow = sideUp ? _SVG_ARROW_UP : _SVG_ARROW_DOWN;
  const modeTag = mode
    ? `<span style="opacity:.65;font-size:9px;font-weight:600"> ${mode.toUpperCase()}</span>`
    : "";

  if (score >= 3 && mode) {
    // STRONG ≥6 помечаем точкой; NORMAL — обычный пилл.
    const dot = score >= 6 ? " ●" : "";
    const confirm =
      (accelKind === "up" ? "accel↑ " : "") + (volKind === "high" ? "vol↑" : "");
    return {
      label: `<span class="setup-pill">${arrow}${side}${dot}${modeTag}</span>`,
      cls: sideUp ? "setup-long" : "setup-short",
      title:
        `${mode.toUpperCase()} ${side} (score ${score.toFixed(1)}) · ${why}` +
        (confirm ? " · " + confirm.trim() : ""),
      score,
      side,
      mode,
    };
  }
  if (score >= 1.5) {
    return {
      label: `<span class="setup-pill">${arrow}${side}${modeTag}</span>`,
      cls: sideUp ? "setup-wait-long" : "setup-wait-short",
      title: mode
        ? `Слабый ${mode.toUpperCase()} ${side} (score ${score.toFixed(1)}) · ${why} — наблюдаем`
        : `Momentum ${side} (score ${score.toFixed(1)}) · ${why} — наблюдаем`,
      score: mode ? score : score * 0.7, // без OI-подтверждения ниже в сортировке
      side,
      mode,
    };
  }
  return {
    label: `<span class="setup-pill">${_SVG_WAIT} WAIT</span>`,
    cls: sideUp ? "setup-wait-long" : "setup-wait-short",
    title: `Хода мало — ждём явный сетап · ${why}`,
    score,
    side,
    mode,
  };
}

export function hmEntryBadge(windows, side, score, mode) {
  if (!side || !mode || !(score >= HM_ENTRY_MIN_SCORE))
    return { icon: "·", state: "none", title: "нет подтверждённого сетапа — таймить нечего" };
  const pick = (mins, lbl) =>
    windows.find((w) => w.mins === mins) || windows.find((w) => w.label === lbl);
  const w15 = pick(15, "15m");
  const w5 = pick(5, "5m");
  const ref =
    w15 && w15.spikePct != null ? w15 : w5 && w5.spikePct != null ? w5 : null;
  if (!ref) return { icon: "·", state: "none", title: "недостаточно истории" };
  const win = ref.label || `${ref.mins}m`;
  const extDir = side === "LONG" ? ref.spikePct : -ref.spikePct;
  const m = Math.abs(extDir).toFixed(1);
  if (extDir <= HM_ENTRY_ZONE_PCT)
    return {
      icon: "🎯",
      state: "zone",
      title: `${side}: у базы (${extDir >= 0 ? "+" : ""}${extDir.toFixed(1)}% в сторону сделки за ${win}) — вход рядом, чейза нет`,
    };
  if (extDir >= HM_ENTRY_EXT_PCT)
    return {
      icon: "⛔",
      state: "extended",
      title: `${side}: уже ушла +${m}% в твою сторону за ${win} — поздно, жди отката`,
    };
  return {
    icon: "⏳",
    state: "mid",
    title: `${side}: растянута +${m}% в сторону сделки за ${win} — дай откатить`,
  };
}
