import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
// unlocks.html — форвард `unlock-cliff-front-2026-09`.
// 🚨 Страница не выносит вердикт: стоп-правило гипотезы разрешает оценку ровно
// один раз, при n=60. Счётчик — прогресс набора, не результат.
// ─────────────────────────────────────────────────

import { bindTheme, startFooterTimer } from "./src/core/shell.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
import { mountTopnav } from "./src/core/topnav.js";
import { renderUnlockForward } from "./src/features/unlockForward.js";

mountTopnav("unlocks");
mountPageHeader({ eyebrow: "Forward · unlock-cliff-front-2026-09", title: "Unlocks" });
bindTheme();
startFooterTimer();

async function refresh() {
  try {
    const r = await fetch("/api/unlocks");
    if (!r.ok) return;
    renderUnlockForward(await r.json());
  } catch {
    /* витрина исследовательская: молчим, следующий тик перерисует */
  }
}
refresh();
setInterval(refresh, 5 * 60_000);
