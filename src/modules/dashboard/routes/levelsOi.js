// ─────────────────────────────────────────────────
//  Levels OI — открытый интерес монеты сейчас и его ход за окна разбора
// ─────────────────────────────────────────────────
// Живое значение — metaAndAssetCtxs HL, история — снимки tools/oiCollector.mjs
// раз в 15 мин: исторического OI у HL нет. Цена для режима берётся из тех же
// снимков, чтобы ход цены и ход OI мерились одним источником.
//
// OI считает обе стороны сразу, поэтому режим описывает, кто действовал, но
// не говорит, куда пойдёт цена.

import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";
import { snapshotsSince } from "./oiCollector.js";

const LIVE_TTL_MS = 15_000;
const HISTORY_TTL_MS = 60_000;
const NEAR_MS = 20 * 60_000; // снимок дальше этого от цели окна не годится
export const OI_FLAT_PCT = 0.5; // ход OI меньше — позиционирование не менялось
export const PX_FLAT_PCT = 0.3;

let live = { at: 0, map: null, inflight: null };
let history = { at: 0, since: 0, rows: null };

async function liveMap() {
  if (live.map && Date.now() - live.at < LIVE_TTL_MS) return live.map;
  if (live.inflight) return live.inflight;
  live.inflight = hlInfo({ type: "metaAndAssetCtxs" }, { label: "levels/oi", priority: HL_PRIORITY.LOW })
    .then((data) => {
      const [meta, ctxs] = data ?? [];
      const map = new Map();
      (meta?.universe || []).forEach((u, i) => {
        const oi = parseFloat(ctxs?.[i]?.openInterest);
        const px = parseFloat(ctxs?.[i]?.markPx);
        if (u?.name && oi > 0 && px > 0) map.set(u.name.toUpperCase(), { oi, px });
      });
      live = { at: Date.now(), map, inflight: null };
      return map;
    })
    .catch(() => {
      live.inflight = null;
      return live.map;
    });
  return live.inflight;
}

async function historyRows(sinceMs) {
  const fresh = Date.now() - history.at < HISTORY_TTL_MS && history.since <= sinceMs;
  if (fresh && history.rows) return history.rows;
  const rows = await snapshotsSince(sinceMs);
  history = { at: Date.now(), since: sinceMs, rows };
  return rows;
}

/** Кто действовал: знак хода цены и знак хода OI. */
export function oiMode(pxPct, oiPct) {
  if (!Number.isFinite(pxPct) || !Number.isFinite(oiPct)) return null;
  if (Math.abs(oiPct) < OI_FLAT_PCT) return "flat";
  if (Math.abs(pxPct) < PX_FLAT_PCT) return oiPct > 0 ? "build" : "unwind";
  if (pxPct > 0) return oiPct > 0 ? "new-longs" : "short-covering";
  return oiPct > 0 ? "new-shorts" : "long-exit";
}

/**
 * Ход OI и цены за окна. Чистая функция: `rows` — снимки коллектора
 * по возрастанию времени, `now` — живое значение {oi, px}.
 */
export function oiRead(coin, now, rows, windows, at = Date.now()) {
  if (!now) return null;
  const key = coin.toUpperCase();
  const out = windows.map(([label, ms]) => {
    const target = at - ms;
    let best = null;
    for (const r of rows) {
      const c = r.d?.[coin] ?? r.d?.[key];
      if (!c) continue;
      const diff = Math.abs(r.t - target);
      if (diff <= NEAR_MS && (!best || diff < best.diff)) best = { diff, oi: Number(c.oi), px: Number(c.px) };
    }
    if (!(best?.oi > 0) || !(best?.px > 0)) return { label, oiPct: null, pxPct: null, mode: null };
    const oiPct = (now.oi / best.oi - 1) * 100;
    const pxPct = (now.px / best.px - 1) * 100;
    return { label, oiPct, pxPct, mode: oiMode(pxPct, oiPct) };
  });
  return { oi: now.oi, oiUsd: now.oi * now.px, at, windows: out };
}

/** OI монеты для разбора: живое значение и ход за окна. Отказ источника — null. */
export async function levelsOi(coin, windows) {
  try {
    const map = await liveMap();
    const now = map?.get(coin.toUpperCase());
    if (!now) return null;
    const longest = Math.max(...windows.map(([, ms]) => ms));
    const rows = await historyRows(Date.now() - longest - NEAR_MS);
    return oiRead(coin, now, rows, windows);
  } catch {
    return null;
  }
}
