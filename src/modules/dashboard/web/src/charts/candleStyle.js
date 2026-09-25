// Монохромные свечи: направление несёт заливка — полая вверх, залитая вниз.
// Цвета из темы, поэтому на тёмной теме свечи светлые.

import { cssVar } from "../utils/format.js";

export function monoCandles() {
  const ink = cssVar("--text-primary") || "#18181B";
  return {
    upColor: cssVar("--card-bg") || "#fff",
    downColor: ink,
    borderUpColor: ink,
    borderDownColor: ink,
    wickUpColor: ink,
    wickDownColor: ink,
  };
}

/** Цветные свечи: зелёная вверх, красная вниз. */
export function colorCandles() {
  const up = cssVar("--pnl-up") || "#0ecb81";
  const down = cssVar("--pnl-down") || "#f6465d";
  return {
    upColor: up,
    downColor: down,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
  };
}

export const candleStyle = (mode) => (mode === "color" ? colorCandles() : monoCandles());

const DOTTED = 1; // LineStyle.Dotted

/** Линия текущей цены: тонкий пунктир цвета последней свечи. */
export function lastPriceLine(bar) {
  const up = !bar || bar.close >= bar.open;
  return {
    priceLineVisible: true,
    priceLineWidth: 1,
    priceLineStyle: DOTTED,
    priceLineColor: up ? cssVar("--pnl-up") || "#0ecb81" : cssVar("--pnl-down") || "#f6465d",
  };
}
