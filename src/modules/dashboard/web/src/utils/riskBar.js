// ─────────────────────────────────────────────────
//  Risk bar: SL │ entry(⅓) │ ●now ───→ 2R.
//  Визуальная шкала «где я между стопом и целью 2:1». Левая треть (stop→entry)
//  = красная зона убытка, правые ⅔ (entry→2R) = зелёная зона прибыли. Бегунок
//  = текущая цена, плавно едет (CSS-transition по left) и пульсирует.
//  Цель 2R синтетическая (вход + 2×риск): у ручных/adopt-позиций нет
//  фиксированного TP, нянька лишь защищает стопом — поэтому правый конец =
//  ориентир на payoff 2:1 (коуч-правило R:R≥2:1), а не реальный ордер.
//  Геометрия зеркальна для SHORT (цель ниже входа), но шкала всегда читается
//  слева→направо «хуже→лучше». 2026-06-16.
// ─────────────────────────────────────────────────

const fmtUsd = (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const pct1 = (f) => (Math.max(0, Math.min(1, f)) * 100).toFixed(1);

// { entry, now, side, stopPrice, sizeUsd } → HTML шкалы или "" если данных мало
// (например, неусыновлённая ручная поза без стопа — рисовать нечего).
export function renderRiskBar({ entry, now, side, stopPrice, sizeUsd } = {}) {
  if (![entry, now, stopPrice].every((v) => v != null && v > 0)) return "";
  const isShort = String(side || "").toUpperCase() === "SHORT";
  const risk = Math.abs(entry - stopPrice); // дистанция вход→стоп в цене
  if (!(risk > 0)) return "";
  // 2R-цель: на 2×риск в сторону прибыли от входа.
  const target = isShort ? entry - 2 * risk : entry + 2 * risk;
  // Нормируем цены на шкалу stop(0)→target(1). Линейная интерполяция верна и
  // для SHORT (там target<stop, span отрицателен — знаки сокращаются).
  const span = target - stopPrice;
  const frac = (px) => (px - stopPrice) / span;
  const fEntry = frac(entry); // = ⅓ по построению (риск : 2·риск)
  const fNow = Math.max(0, Math.min(1, frac(now)));

  // P&L в $ на заданной цене (если знаем размер позиции).
  const pnlAt = (px) => {
    if (sizeUsd == null) return null;
    const movePct = isShort ? (entry - px) / entry : (px - entry) / entry;
    return movePct * sizeUsd;
  };
  const nowPnl = pnlAt(now);
  const stopPnl = pnlAt(stopPrice); // ≈ −риск
  const tgtPnl = pnlAt(target); // ≈ +2·риск
  const lbl = (v) => (v == null ? "" : ` ${fmtUsd(v)}`);

  const fav = fNow >= fEntry; // справа от входа → в прибыли
  // Сколько % пути от входа к 2R пройдено (0 в убытке, 100 на цели).
  const toTarget = fNow <= fEntry ? 0 : ((fNow - fEntry) / (1 - fEntry)) * 100;
  const tip = `стоп${lbl(stopPnl)} · сейчас${lbl(nowPnl)} · цель 2R${lbl(tgtPnl)}`;

  return `
    <div class="risk-bar" data-fav="${fav ? "1" : "0"}" title="${tip}">
      <div class="risk-bar-track">
        <span class="risk-bar-loss" style="width:${pct1(fEntry)}%"></span>
        <span class="risk-bar-profit" style="left:${pct1(fEntry)}%;width:${pct1(1 - fEntry)}%"></span>
        <span class="risk-bar-entry" style="left:${pct1(fEntry)}%"></span>
        <span class="risk-bar-now ${fav ? "fav" : "against"}" style="left:${pct1(fNow)}%"></span>
      </div>
      <div class="risk-bar-legend">
        <span class="rb-end rb-stop">SL${lbl(stopPnl)}</span>
        <span class="rb-now ${fav ? "positive" : "negative"}">${lbl(nowPnl).trim()}${toTarget > 0 ? ` · ${toTarget.toFixed(0)}% к 2R` : ""}</span>
        <span class="rb-end rb-tgt">2R${lbl(tgtPnl)}</span>
      </div>
    </div>`;
}
