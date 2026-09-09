import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
// calibrator.html — цена входа в монету, выраженная в процентных пунктах.
// Считает бэкенд по расписанию (src/modules/calibrator.js), здесь только показ.
// ─────────────────────────────────────────────────

import { bindTheme, startFooterTimer } from "./src/core/shell.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
import { mountTopnav } from "./src/core/topnav.js";
import { renderCalibrator, bindCalibratorMode } from "./src/features/calibrator.js";

mountTopnav("calibrator");
mountPageHeader({ eyebrow: "Research · what a coin costs", title: "Calibrator" });
bindTheme();
startFooterTimer();
bindCalibratorMode();

async function refresh() {
  try {
    const r = await fetch("/api/calibrator");
    if (!r.ok) return;
    renderCalibrator(await r.json());
  } catch {
    /* исследовательская витрина: следующий тик перерисует */
  }
}
refresh();
setInterval(refresh, 30 * 60_000);
