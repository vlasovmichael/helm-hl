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
