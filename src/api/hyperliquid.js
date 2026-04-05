import axios from 'axios';
import { logger } from '../utils/logger.js';

const HL_API = 'https://api.hyperliquid.xyz/info';
const STALE_RTT_MS = 30_000; // 30 секунд round-trip — данные подозрительны

async function post(type, payload = {}) {
    const t0 = Date.now();
    const response = await axios.post(HL_API, { type, ...payload });
    const rttMs = Date.now() - t0;
    return { data: response.data, rttMs };
}

export async function getMarketData() {
    logger.info('Fetching market data from Hyperliquid...');

    const { data, rttMs } = await post('metaAndAssetCtxs');

    if (rttMs > STALE_RTT_MS) {
        throw new Error(`Stale data from Hyperliquid: RTT ${(rttMs / 1000).toFixed(1)}s exceeds ${STALE_RTT_MS / 1000}s threshold`);
    }

    const [universe, assetCtxs] = data;

    const markets = universe.map((asset, i) => {
        const ctx = assetCtxs[i];
        const coin = asset.name;
        const price = parseFloat(ctx.midPx ?? 0);
        const fundingRate = parseFloat(ctx.funding ?? 0);
        const apy = fundingRate * 24 * 365 * 100;

        return { coin, price, fundingRate, apy };
    });

    const positiveCount = markets.filter(m => m.fundingRate > 0).length;
    logger.info(`Found ${positiveCount} coins with positive funding (out of ${markets.length} total)`);
    return markets;
}
