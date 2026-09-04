// ─────────────────────────────────────────────────
//  Hot Movers — momentum / OI-режим (чистая логика).
//  ⚠️ Серверный двойник в src/modules/hotMoversSetup.js — держать в синхроне.
//  Вынесено из main.js: pure-функции без зависимостей от состояния дашборды.
// ─────────────────────────────────────────────────

// Иконки сетапа — из общего набора (core/icon.js). Здесь лежали четыре
// самодельных <svg> со своим stroke-width и своей сеткой 12×12, поэтому в
// одном ряду с иконками остального дашборда они выглядели чужими.
//.
import { icon as glyph } from "../core/icon.js";

const _MOM_WEIGHTS = { 2: 0.2, 5: 0.4, 15: 0.8, 60: 1.2 };

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

// viewMode:
//   'trend' (дефолт) — сторона ВСЕГДА по движению цены (слив = SHORT, памп =
//     LONG); OI не переворачивает сторону, а лишь помечает качество хода (tag
//     trend = OI подтверждает / fade? = ход на делевередже, может выдохнуться).
//   'fade'  — классический контртренд по OI (OI↓ ⇒ ставка на выдох/отскок).
// Переключатель на карточке (radio) — оператор сравнивает оба вживую.
export function computeMomentum(windows, accelKind, volKind, signal, flush, viewMode = "trend") {
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
      title: "No data",
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
  // tagText — что писать в пилле после стороны. В fade-режиме = mode (trend/fade),
  // в trend-режиме = качество хода по OI (trend подтверждён / fade? на делевередже).
  let tagText = null;
  if (viewMode === "trend") {
    // Trend-following: сторона ВСЕГДА по цене, OI сторону не переворачивает.
    side = priceUp ? "LONG" : "SHORT";
    mode = "trend"; // entry-бейдж/чейз ждут mode; сторона честно по движению
    if (oiKind === "up") {
      tagText = "trend";
      why = priceUp
        ? `price up + OI up (${oiStr}) = uptrend, new longs confirm it`
        : `price down + OI up (${oiStr}) = downtrend, new shorts pressing`;
    } else if (oiKind === "down") {
      tagText = "fade?";
      why = priceUp
        ? `price up + OI down (${oiStr}) = rally on short covering, momentum may fade`
        : `price down + OI down (${oiStr}) = drop on deleveraging, a bounce is possible`;
    } else {
      tagText = "trend";
      why = oiKind === "flat" ? `OI flat (${oiStr}) — OI does not confirm the move` : "OI: no data";
    }
  } else if (oiKind === "up") {
    mode = "trend";
    side = priceUp ? "LONG" : "SHORT";
    why = priceUp
      ? `price up + OI up (${oiStr}) = new longs, real demand`
      : `price down + OI up (${oiStr}) = new shorts pressing`;
  } else if (oiKind === "down") {
    mode = "fade";
    side = priceUp ? "SHORT" : "LONG";
    why = priceUp
      ? `price up + OI down (${oiStr}) = short covering / exhaustion`
      : `price down + OI down (${oiStr}) = longs flushed, exhaustion`;
  } else {
    // OI флэт или нет данных — направление по движению, режим не подтверждён.
    mode = null;
    side = priceUp ? "LONG" : "SHORT";
    why = oiKind === "flat" ? `OI flat (${oiStr}) — regime unconfirmed` : "OI: no data";
  }

  // Breadth-слив: fade против синхронного делевереджа = лов ножа. Снимаем режим
  // (пилл остаётся, но не actionable: 🎯-зона/ntfy гаснут), помечаем в подсказке.
  if (fadeMutedByFlush(side, mode, flush)) {
    mode = null;
    const sharePct = Math.round((flush.share || 0) * 100);
    why = `market-wide flush (${sharePct}% of the top has OI down) — fading is unreliable, that is knife-catching`;
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
      why = `Muted: accelerating with the move — not exhaustion (the knife is speeding up) · ${why}`;
    } else if (priceUp && htf === "up") {
      mode = null;
      why = `Muted: 1h trend UP — a fade short goes against it · ${why}`;
    } else if (!priceUp && htf === "down") {
      mode = null;
      why = `Muted: 1h trend DOWN — a fade long goes against it · ${why}`;
    }
  }

  const sideUp = side === "LONG";

  // (1) Режим НЕ подтверждён (OI флэт/нет данных) ИЛИ заглушён выше (нож /
  // против старшего тренда / синхронный слив) → НЕ выдаём направленный сигнал.
  // Setup честно показывает WAIT: сторона и так видна по тинту строки и по
  // %-ячейкам, а «уверенный LONG/SHORT» на неподтверждённом ходе вводил в
  // заблуждение (кейс CHIP: заглушённый fade-long выглядел как trend-long).
  if (!mode) {
    return {
      label: `<span class="setup-pill">${glyph("clock")} WAIT</span>`,
      cls: "setup-wait",
      title: `No confirmed setup · ${why}`,
      score, // величину хода сохраняем — для сортировки муверов
      side: null, // нет направления — Enter='—' (вход не таймим)
      mode: null,
    };
  }

  // (2) Режим подтверждён. trend = ПО движению (стрелка ↑/↓, залитый пилл);
  // fade = КОНТРтренд (иконка ⟲, обведённый пилл). Разный вид не даёт спутать
  // «LONG TREND» с «LONG FADE».
  const isFade = mode === "fade";
  // Локальная переменная НЕ `icon`: она перекрыла бы импортированную функцию.
  const setupGlyph = isFade
    ? glyph("recompute")
    : glyph(sideUp ? "long" : "short");
  const modeTag = `<span style="opacity:.65;font-size: var(--fs-micro);font-weight:600"> ${(tagText ?? mode).toUpperCase()}</span>`;
  const strongCls = isFade
    ? sideUp
      ? "setup-fade-long"
      : "setup-fade-short"
    : sideUp
      ? "setup-long"
      : "setup-short";
  const weakCls = isFade
    ? sideUp
      ? "setup-fade-wait-long"
      : "setup-fade-wait-short"
    : sideUp
      ? "setup-wait-long"
      : "setup-wait-short";

  if (score >= 3) {
    // STRONG ≥6 помечаем точкой; NORMAL — обычный пилл.
    const dot = score >= 6 ? '<i class="setup-dot" aria-hidden="true"></i>' : "";
    const confirm =
      (accelKind === "up" ? "accel up " : "") + (volKind === "high" ? "vol up" : "");
    return {
      label: `<span class="setup-pill">${setupGlyph}${side}${dot}${modeTag}</span>`,
      cls: strongCls,
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
      label: `<span class="setup-pill">${setupGlyph}${side}${modeTag}</span>`,
      cls: weakCls,
      title: `Weak ${mode.toUpperCase()} ${side} (score ${score.toFixed(1)}) · ${why} — watching`,
      score,
      side,
      mode,
    };
  }
  // Режим подтверждён, но хода почти нет → нейтральный WAIT.
  return {
    label: `<span class="setup-pill">${glyph("clock")} WAIT</span>`,
    cls: "setup-wait",
    title: `Move too small — waiting for a clear setup · ${why}`,
    score,
    side,
    mode,
  };
}
