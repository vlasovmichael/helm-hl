// ─────────────────────────────────────────────────
//  Carry — JSON для карточки захеджированного фандинга на /oi
// ─────────────────────────────────────────────────

import { logger } from "../../../core/logger.js";
import { getCarry } from "../../carry.js";

export async function handleCarry(_req, res) {
  try {
    res.json({ ok: true, ...(await getCarry()) });
  } catch (err) {
    logger.warn(`[Carry] ${err.message}`);
    res.json({ ok: false, reason: "hl-unavailable", message: "Hyperliquid did not answer; try again in a minute." });
  }
}
