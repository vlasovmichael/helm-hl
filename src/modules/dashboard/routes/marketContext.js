// ─────────────────────────────────────────────────
//  Market Context — «вердикт по фону» (risk-on/off)
// ─────────────────────────────────────────────────
// Отвечает на один вопрос: вход сейчас идёт ПО фону рынка или ПРОТИВ.
// Источник тренда — 15m-свечи BTC с HL. Sentiment — Fear & Greed Index
// (alternative.me, бесплатно, кэш 30 мин). Это НЕ новостная лента (commodity),
// а сжатый вердикт для ручного трейда.

import axios from "axios";
import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";

const FNG_TTL_MS = 30 * 60_000;
let fngCache = { value: null, label: null, ts: 0 };

async function getFearGreed() {
  if (fngCache.value != null && Date.now() - fngCache.ts < FNG_TTL_MS) {
    return { value: fngCache.value, label: fngCache.label };
  }
  try {
    const { data } = await axios.get("https://api.alternative.me/fng/?limit=1", {
      timeout: 4000,
    });
    const row = data?.data?.[0];
    if (row) {
      fngCache = {
        value: Number(row.value),
        label: row.value_classification || null,
        ts: Date.now(),
      };
    }
  } catch {
    /* сеть упала — отдаём stale (или null), полоса деградирует тихо */
  }
  return { value: fngCache.value, label: fngCache.label };
}

// BTC % за 15m/1h/4h из 15m-свечей HL (не priceHistory — тот пуст первые 4ч
// после рестарта). Кэш 60с, чтобы не дёргать HL на каждый поллинг дашборды.
const BTC_CANDLES_TTL_MS = 60_000;
let btcMovesCache = { moves: null, ts: 0 };

async function getBtcMoves() {
  if (btcMovesCache.moves && Date.now() - btcMovesCache.ts < BTC_CANDLES_TTL_MS) {
    return btcMovesCache.moves;
  }
  const now = Date.now();
  let candles;
  try {
    candles = await hlInfo(
      {
        type: "candleSnapshot",
        req: { coin: "BTC", interval: "15m", startTime: now - 5 * 3600_000, endTime: now },
      },
      { label: "dash/market-context", timeoutMs: 5000, maxRetries: 1, priority: HL_PRIORITY.LOW },
    );
  } catch {
    return btcMovesCache.moves; // stale (или null) — полоса деградирует тихо
  }
  if (!Array.isArray(candles) || candles.length < 2) return btcMovesCache.moves;

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
  btcMovesCache = { moves, ts: Date.now() };
  return moves;
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
  const [moves, fng] = await Promise.all([getBtcMoves(), getFearGreed()]);
  const btc = moves || { m15: null, m1h: null, m4h: null };
  const { verdict, arrow } = classifyRegime(btc.m15, btc.m1h);
  res.json({
    verdict,
    arrow,
    btc,
    fearGreed: fng.value != null ? { value: fng.value, label: fng.label } : null,
    ts: Date.now(),
  });
}
