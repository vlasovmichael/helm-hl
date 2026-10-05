// Монохромные свечи: направление несёт заливка — полая вверх, залитая вниз.
// Цвета из темы, поэтому на тёмной теме свечи светлые.

import { cssVar } from "../utils/format.js";

export function monoCandles(element) {
  const ink = cssVar("--ink", element) || "var(--ink)";
  return {
    upColor: cssVar("--panel", element) || "var(--color-gray-0)",
    downColor: ink,
    borderUpColor: ink,
    borderDownColor: ink,
    wickUpColor: ink,
    wickDownColor: ink,
  };
}

/** Цветные свечи: зелёная вверх, красная вниз. */
export function colorCandles(element) {
  const up = cssVar("--pnl-up", element) || "var(--gain)";
  const down = cssVar("--pnl-down", element) || "var(--loss)";
  return {
    upColor: up,
    downColor: down,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
  };
}

export const candleStyle = (mode, element) => (mode === "color" ? colorCandles(element) : monoCandles(element));

const DOTTED = 1; // LineStyle.Dotted

/** Линия текущей цены: тонкий пунктир цвета последней свечи. */
export function lastPriceLine(bar, element) {
  const up = !bar || bar.close >= bar.open;
  return {
    priceLineVisible: true,
    priceLineWidth: 1,
    priceLineStyle: DOTTED,
    priceLineColor: up ? cssVar("--pnl-up", element) || "var(--gain)" : cssVar("--pnl-down", element) || "var(--loss)",
  };
}
