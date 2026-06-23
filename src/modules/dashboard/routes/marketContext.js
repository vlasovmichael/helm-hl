// ─────────────────────────────────────────────────
//  Market Context — «вердикт по фону» (risk-on/off)
// ─────────────────────────────────────────────────
// Отвечает на один вопрос: вход сейчас идёт ПО фону рынка или ПРОТИВ.
// Источник тренда — 15m-свечи BTC с HL; они же питают мини-график цены.

import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";

// BTC % за 15m/1h/4h из 15m-свечей HL (не priceHistory — тот пуст первые 4ч
// после рестарта). Кэш 60с, чтобы не дёргать HL на каждый поллинг дашборды.
const BTC_CANDLES_TTL_MS = 60_000;
const BTC_CHART_BARS = 30; // сколько последних 15m-свечей отдаём на мини-график
let btcCache = { moves: null, candles: null, price: null, ts: 0 };

async function getBtc() {
  if (btcCache.moves && Date.now() - btcCache.ts < BTC_CANDLES_TTL_MS) {
    return btcCache;
  }
  const now = Date.now();
  let candles;
  try {
    candles = await hlInfo(
      {
        type: "candleSnapshot",
        // ~8ч 15m-свечей: хватает и на мини-график (30 баров), и на m4h (16 баров)
        req: { coin: "BTC", interval: "15m", startTime: now - 8 * 3600_000, endTime: now },
      },
      { label: "dash/market-context", timeoutMs: 5000, maxRetries: 1, priority: HL_PRIORITY.LOW },
    );
  } catch {
    return btcCache; // stale (или null) — полоса деградирует тихо
  }
  if (!Array.isArray(candles) || candles.length < 2) return btcCache;

  const closes = candles.map((c) => Number(c.c)).filter((n) => Number.isFinite(n));
  const last = closes[closes.length - 1];
  // back(n) = close n свечей назад (1 свеча 15m). null если не накопилось.
  const back = (n) => (closes.length > n ? closes[closes.length - 1 - n] : null);
  const pct = (prev) => (prev != null && prev !== 0 ? ((last - prev) / prev) * 100 : null);

  const moves = {
    m15: pct(back(1)),   // 1×15m
    m1h: pct(back(4)),   // 4×15m
    m4h: pct(back(16)),  // 16×15m
  };
  // Компактные OHLC последних N свечей для мини-графика: [o,h,l,c].
  const series = candles
    .slice(-BTC_CHART_BARS)
    .map((c) => [Number(c.o), Number(c.h), Number(c.l), Number(c.c)])
    .filter((a) => a.every((n) => Number.isFinite(n)));

  btcCache = { moves, candles: series, price: last, ts: Date.now() };
  return btcCache;
}

// Вердикт по фону. 1h = главный тренд, 15m = подтверждение моментума.
// Порог ±0.5% по 1h отсекает боковик-шум (BTC «дышит» в этих пределах).
function classifyRegime(m15, m1h) {
  if (m1h == null) return { verdict: "UNKNOWN", arrow: "•" };
  if (m1h > 0.5 && (m15 == null || m15 >= -0.1)) {
    return { verdict: "RISK_ON", arrow: "▲" };
  }
  if (m1h < -0.5 && (m15 == null || m15 <= 0.1)) {
    return { verdict: "RISK_OFF", arrow: "▼" };
  }
  return { verdict: "MIXED", arrow: "≈" };
}

export async function handleMarketContext(_req, res) {
  const data = await getBtc();
  const btc = data.moves || { m15: null, m1h: null, m4h: null };
  const { verdict, arrow } = classifyRegime(btc.m15, btc.m1h);
  res.json({
    verdict,
    arrow,
    btc,
    btcPrice: data.price ?? null,
    btcCandles: data.candles || [],
    ts: Date.now(),
  });
}
