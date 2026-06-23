// ─────────────────────────────────────────────────
//  Market Context — живая расширенная статистика по BTC
// ─────────────────────────────────────────────────
// Цена + движения по таймфреймам (15m/1h/4h/24h) + объём 24h + OI + funding.
// Цвет рамки = «светофор» по фону (risk-on/off). Источники:
//   • 15m-свечи HL → движения 15m/1h/4h;
//   • metaAndAssetCtxs → markPx, prevDayPx (24h), dayNtlVlm, openInterest, funding.

import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";

const TTL_MS = 60_000; // кэш, чтобы не дёргать HL на каждый поллинг дашборды
let cache = { payload: null, ts: 0 };

// Движения BTC за 15m/1h/4h из 15m-свечей HL (priceHistory пуст первые 4ч после
// рестарта, поэтому считаем прямо из свечей).
async function getMoves() {
  const now = Date.now();
  let candles;
  try {
    candles = await hlInfo(
      {
        type: "candleSnapshot",
        req: { coin: "BTC", interval: "15m", startTime: now - 5 * 3600_000, endTime: now },
      },
      { label: "dash/mc-moves", timeoutMs: 5000, maxRetries: 1, priority: HL_PRIORITY.LOW },
    );
  } catch {
    return null;
  }
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const closes = candles.map((c) => Number(c.c)).filter((n) => Number.isFinite(n));
  const last = closes[closes.length - 1];
  const back = (n) => (closes.length > n ? closes[closes.length - 1 - n] : null);
  const pct = (prev) => (prev != null && prev !== 0 ? ((last - prev) / prev) * 100 : null);
  return { m15: pct(back(1)), m1h: pct(back(4)), m4h: pct(back(16)) };
}

// Расширенная статистика BTC из assetCtx: цена, 24h %, объём, OI, funding.
async function getStats() {
  let data;
  try {
    data = await hlInfo(
      { type: "metaAndAssetCtxs" },
      { label: "dash/mc-stats", timeoutMs: 5000, maxRetries: 1, priority: HL_PRIORITY.LOW },
    );
  } catch {
    return null;
  }
  const [meta, ctxs] = data ?? [];
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return null;
  const idx = meta.universe.findIndex((a) => (a.name ?? "").toUpperCase() === "BTC");
  if (idx === -1 || !ctxs[idx]) return null;
  const c = ctxs[idx];
  const mark = parseFloat(c.markPx ?? c.midPx ?? NaN);
  const prevDay = parseFloat(c.prevDayPx ?? NaN);
  const oiCoin = parseFloat(c.openInterest ?? NaN);
  const vol = parseFloat(c.dayNtlVlm ?? NaN);
  const funding = parseFloat(c.funding ?? NaN);
  const fin = (n) => (Number.isFinite(n) ? n : null);
  return {
    price: fin(mark),
    change24h:
      Number.isFinite(mark) && Number.isFinite(prevDay) && prevDay !== 0
        ? ((mark - prevDay) / prevDay) * 100
        : null,
    volUsd: fin(vol),
    oiUsd: Number.isFinite(oiCoin) && Number.isFinite(mark) ? oiCoin * mark : null,
    funding: fin(funding), // часовая ставка (доля, напр. 0.0000125 = 0.00125%)
  };
}

// Вердикт по фону. 1h = главный тренд, 15m = подтверждение моментума.
function classifyRegime(m15, m1h) {
  if (m1h == null) return { verdict: "UNKNOWN", arrow: "•" };
  if (m1h > 0.5 && (m15 == null || m15 >= -0.1)) return { verdict: "RISK_ON", arrow: "▲" };
  if (m1h < -0.5 && (m15 == null || m15 <= 0.1)) return { verdict: "RISK_OFF", arrow: "▼" };
  return { verdict: "MIXED", arrow: "≈" };
}

export async function handleMarketContext(_req, res) {
  if (cache.payload && Date.now() - cache.ts < TTL_MS) {
    return res.json(cache.payload);
  }
  const [moves, stats] = await Promise.all([getMoves(), getStats()]);
  // Если оба источника отвалились — отдаём прошлый кэш (тихая деградация).
  if (!moves && !stats && cache.payload) return res.json(cache.payload);

  const m = moves || { m15: null, m1h: null, m4h: null };
  const { verdict, arrow } = classifyRegime(m.m15, m.m1h);
  const payload = {
    verdict,
    arrow,
    btc: {
      price: stats?.price ?? null,
      m15: m.m15,
      m1h: m.m1h,
      m4h: m.m4h,
      change24h: stats?.change24h ?? null,
      volUsd: stats?.volUsd ?? null,
      oiUsd: stats?.oiUsd ?? null,
      funding: stats?.funding ?? null,
    },
    ts: Date.now(),
  };
  cache = { payload, ts: Date.now() };
  res.json(payload);
}
