import axios from "axios";
import { logger } from "../utils/logger.js";

const HL_API = "https://api.hyperliquid.xyz/info";
const STALE_RTT_MS = 30_000;

async function post(type, payload = {}) {
  const t0 = Date.now();
  const response = await axios.post(HL_API, { type, ...payload });
  const rttMs = Date.now() - t0;
  return { data: response.data, rttMs };
}

export async function getMarketData() {
  logger.info("Fetching market data from Hyperliquid...");

  const { data, rttMs } = await post("metaAndAssetCtxs");

  if (rttMs > STALE_RTT_MS) {
    throw new Error(
      `Stale data from Hyperliquid: RTT ${(rttMs / 1000).toFixed(1)}s exceeds ${STALE_RTT_MS / 1000}s threshold`,
    );
  }

  // --- Валидация структуры ответа ---
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error(
      `Invalid metaAndAssetCtxs response: expected array[2], got ${typeof data} (${JSON.stringify(data).slice(0, 200)})`,
    );
  }

  const [meta, assetCtxs] = data;

  // meta может быть { universe: [...] } или сам массив
  const universe = Array.isArray(meta) ? meta : meta?.universe;

  if (!Array.isArray(universe)) {
    throw new Error(
      `Invalid meta.universe: expected array, got ${typeof universe} (${JSON.stringify(meta).slice(0, 200)})`,
    );
  }

  if (!Array.isArray(assetCtxs)) {
    throw new Error(
      `Invalid assetCtxs: expected array, got ${typeof assetCtxs} (${JSON.stringify(assetCtxs).slice(0, 200)})`,
    );
  }

  // --- Маппинг данных ---
  const markets = [];

  for (let i = 0; i < universe.length; i++) {
    const asset = universe[i];
    const ctx = assetCtxs[i];

    const coin = asset?.name;
    if (!coin) continue;
    if (!ctx) continue;

    const price = parseFloat(ctx.midPx ?? ctx.markPx ?? 0);
    const fundingRate = parseFloat(ctx.funding ?? 0);

    if (Number.isNaN(price) || Number.isNaN(fundingRate)) continue;

    const apy = fundingRate * 24 * 365 * 100;

    markets.push({ coin, price, fundingRate, apy });
  }

  const positiveCount = markets.filter((m) => m.fundingRate > 0).length;
  logger.info(
    `Found ${positiveCount} coins with positive funding (out of ${markets.length} total)`,
  );

  return markets;
}
