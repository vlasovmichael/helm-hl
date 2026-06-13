// ─────────────────────────────────────────────────
//  BTC Divergence — watchlist vs BTC snapshot ring buffer
// ─────────────────────────────────────────────────
// Снимает цены всех монет HL раз в минуту в кольцевой буфер (61 мин ≈ 1h окно)
// и считает относительное движение монеты к BTC за 5m/15m/1h. Подсвечивает
// расхождения (монета сильно отстаёт/опережает BTC) — кандидаты на fade.
//
// Broadcast по WS остаётся в server.js (где живёт wss): refreshDivergenceSnapshot
// делает только fetch+store и сообщает, появился ли новый снапшот.

import { hlInfo } from "../../../core/hlClient.js";

export const DIVERGENCE_WATCHLIST = ["BTC", "HYPE", "ZEC", "WLD", "NEAR", "LIT", "ASTER"];
export const DIVERGENCE_SNAPSHOT_MS = 60_000;
const DIVERGENCE_SNAPSHOTS = 62;         // 61 минута (покрывает 1h окно)

// Ring buffer: [{ts, prices: {COIN: price, ...}}] — хранит ВСЕ монеты с HL
const divergenceSnapshots = [];

export function hasDivergenceSnapshots() {
  return divergenceSnapshots.length > 0;
}

// Fetch+store одного снапшота. Возвращает true, если новый снапшот сохранён
// (server.js на это броадкастит свежий payload подключённым WS-клиентам).
export async function refreshDivergenceSnapshot() {
  try {
    const data = await hlInfo(
      { type: "metaAndAssetCtxs" },
      { label: "dashboard/divergence", timeoutMs: 10_000 },
    );
    const [meta, ctxs] = data ?? [];
    if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return false;

    // Сохраняем ВСЕ монеты — нужно для таба "All"
    const snap = { ts: Date.now(), prices: {} };
    for (let i = 0; i < meta.universe.length; i++) {
      const name = (meta.universe[i]?.name ?? "").toUpperCase();
      if (!name || !ctxs[i]) continue;
      const px = parseFloat(ctxs[i].midPx ?? ctxs[i].markPx ?? "0");
      if (px > 0) snap.prices[name] = px;
    }
    divergenceSnapshots.push(snap);
    if (divergenceSnapshots.length > DIVERGENCE_SNAPSHOTS) divergenceSnapshots.shift();
    return true;
  } catch {
    return false; /* silent */
  }
}

const DIVERGENCE_WINDOWS = { "5m": 5, "15m": 15, "1h": 60 };

function calcDivergenceWindow(current, minutes, coins) {
  const targetTs = Date.now() - minutes * 60_000;
  let past = null;
  for (const snap of divergenceSnapshots) {
    if (snap.ts <= targetTs) past = snap;
    else break;
  }

  const btcNow = current.prices["BTC"];
  const btcPast = past?.prices["BTC"];
  const btcPct = btcNow && btcPast ? ((btcNow - btcPast) / btcPast) * 100 : null;

  const rows = coins.map((coin) => {
    const pxNow = current.prices[coin];
    const pxPast = past?.prices[coin];
    const coinPct = pxNow && pxPast ? ((pxNow - pxPast) / pxPast) * 100 : null;
    const relPct = coinPct != null && btcPct != null ? coinPct - btcPct : null;
    return { coin, price: pxNow ?? null, coinPct, btcPct, relPct };
  });

  return { coins: rows, btcPct, hasPast: past !== null };
}

export function buildDivergencePayload(coins) {
  const current = divergenceSnapshots[divergenceSnapshots.length - 1];
  if (!current) return { windows: {}, updatedAt: null };

  const windows = {};
  for (const [label, mins] of Object.entries(DIVERGENCE_WINDOWS)) {
    windows[label] = calcDivergenceWindow(current, mins, coins);
  }
  return { windows, updatedAt: current.ts };
}

export function handleBtcDivergenceAll(req, res) {
  const current = divergenceSnapshots[divergenceSnapshots.length - 1];
  if (!current) return res.json({ coins: [], btcPct: null, hasPast: false, window: "15m" });

  const win = ["5m", "15m", "1h"].includes(req.query.window) ? req.query.window : "15m";
  const mins = DIVERGENCE_WINDOWS[win];
  const allCoins = Object.keys(current.prices).filter((c) => c !== "BTC");
  const result = calcDivergenceWindow(current, mins, allCoins);

  // Скор для сортировки: сильный сигнал сверху, монеты без истории в конец
  const btcPct = result.btcPct ?? 0;
  result.coins = result.coins
    .sort((a, b) => {
      const score = (c) => {
        if (!result.hasPast || c.relPct == null) return -1;
        if (btcPct > 0.3 && c.relPct <= -1.5) return 100 + Math.abs(c.relPct);   // SHORT signal
        if (btcPct < -0.3 && c.relPct >= 1.5) return 100 + c.relPct;             // LONG signal
        return Math.abs(c.relPct);                                                 // слабый сигнал
      };
      return score(b) - score(a);
    })
    .slice(0, 40);

  res.json({ ...result, window: win });
}

export function handleBtcDivergence(req, res) {
  const coins = req.query.coins
    ? req.query.coins.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)
    : DIVERGENCE_WATCHLIST;
  res.json(buildDivergencePayload(coins));
}
