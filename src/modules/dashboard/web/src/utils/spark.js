// ─────────────────────────────────────────────────
// Спарклайн цены — один рисовальщик на все плашки.
// Его крутят и Hot Movers (колонка цены), и Market Context (BTC): линия
// везде одной толщины и одного цветового кода (вверх/вниз/плоско).
// ─────────────────────────────────────────────────

// values — ряд цен (старое → новое). cls добавляется рядом с базовым .spark.
export function sparkSvg(values, { w = 44, h = 14, cls = "" } = {}) {
  if (!Array.isArray(values) || values.length < 2) return "";
  let min = Infinity,
    max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "";
  const span = max - min || 1;
  const n = values.length;
  const dx = (w - 2) / (n - 1);
  const pts = values
    .map((v, i) => {
      const x = 1 + i * dx;
      const y = 1 + (h - 2) * (1 - (v - min) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const first = values[0];
  const last = values[n - 1];
  const chg = first ? (last - first) / first : 0;
  const dir =
    Math.abs(chg) < 0.0005 ? "spark-flat" : last >= first ? "spark-up" : "spark-down";
  return (
    `<svg class="spark ${cls} ${dir}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
    `preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`
  );
}
