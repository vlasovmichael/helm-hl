// ─────────────────────────────────────────────────
//  Лесенка стакана — одна на живой стакан и тренажёр.
//  Полоса глубины — SVG с шириной атрибутом: стиль в разметке запрещён.
// ─────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Полоса доли 0..1, прижатая к правому краю строки. */
export function depthBar(share) {
  const w = Math.max(2, Math.min(100, share * 100));
  return `<svg class="ob-bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect x="${(100 - w).toFixed(2)}" y="0" width="${w.toFixed(2)}" height="1"></rect></svg>`;
}

/**
 * Строки стакана. level: { px, sz, wall?, mine?, eaten? }; колонки после
 * цены — подписи уже отформатированных значений.
 */
export function ladderRows(levels, { side, maxSz, cells }) {
  return levels
    .map((l) => {
      const cls = [
        "ob-row",
        side,
        l.wall ? "wall" : "",
        l.mine ? "mine" : "",
        l.eaten ? "eaten" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<div class="${cls}" data-px="${l.px}">
        ${depthBar(maxSz > 0 ? l.sz / maxSz : 0)}
        <span class="ob-tag"></span>
        ${cells(l)
          .map((c, i) => `<span class="${i === 0 ? "ob-px" : i === 1 ? "ob-sz" : "ob-usd"}">${esc(c)}</span>`)
          .join("")}
      </div>`;
    })
    .join("");
}

/** Скелетон лесенки, пока книга не приехала: ступеньки разной длины. */
export function ladderSkeleton(rows = 10) {
  return Array.from({ length: rows }, () => `<div class="ob-row ob-row--sk"><span class="sk"></span></div>`).join("");
}

/** Полоса давления: доля бидов слева, асков справа. */
export function pressureBar(bidShare) {
  const b = Math.max(0, Math.min(100, bidShare * 100));
  return `<svg class="ob-imb-bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">
    <rect class="b" x="0" y="0" width="${b.toFixed(2)}" height="1"></rect>
    <rect class="a" x="${b.toFixed(2)}" y="0" width="${(100 - b).toFixed(2)}" height="1"></rect>
  </svg>`;
}
