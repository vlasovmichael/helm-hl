// ─────────────────────────────────────────────────
//  Whale Watch — perp positions of any HL address
// ─────────────────────────────────────────────────
// Мониторинг чужих HL-адресов: открытые перп-позиции, direction-bias, дельты
// (открыл/закрыл/изменил размер) + ntfy-алерты по значимым изменениям.
// + HL Leaderboard (top accounts by accountValue).

import axios from "axios";
import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";

const WHALE_DEFAULT_ADDRESS = "0x3ed4033676d0bdb3938728ca4ac673d00e74bd06";
const WHALE_CACHE_TTL_MS = 30_000;
const whaleCache = new Map();          // address → { ts, data }
const whalePrevPositions = new Map();  // address → positions[]
const whaleFirstSeenAt = new Map();    // "addr:coin" → timestamp when position first detected

// ntfy helper for whale alerts — separate topic from strategy alerts
async function fireWhaleNtfy(title, message) {
  const { url, topic, token } = config.ntfy;
  if (!url || !url.startsWith("https://")) return;  // skip docker-internal or missing
  const whaleTopic = process.env.NTFY_TOPIC_WHALE || topic;
  if (!whaleTopic) return;
  try {
    const { default: https } = await import("node:https");
    const body = JSON.stringify({
      topic: whaleTopic,
      title,
      message,
      priority: 4,
      tags: ["whale"],
    });
    const u = new URL(`${url}/`);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: u.hostname, port: u.port || 443, path: "/", method: "POST", headers },
        (res) => { res.resume(); res.on("end", resolve); },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    logger.debug(`[Dashboard] whale ntfy failed: ${err.message}`);
  }
}

function computeWhaleDelta(addr, newPositions) {
  const prev = whalePrevPositions.get(addr) ?? [];
  const delta = [];
  const now = Date.now();

  const prevMap = new Map(prev.map((p) => [p.coin, p]));
  const newMap  = new Map(newPositions.map((p) => [p.coin, p]));

  // Opened — record firstSeenAt
  for (const [coin, p] of newMap) {
    if (!prevMap.has(coin)) {
      const key = `${addr}:${coin}`;
      if (!whaleFirstSeenAt.has(key)) whaleFirstSeenAt.set(key, now);
      delta.push({ coin, type: "opened", prevSizeUsd: null, sizeUsd: p.sizeUsd, side: p.side });
    }
  }
  // Closed — remove firstSeenAt
  for (const [coin, p] of prevMap) {
    if (!newMap.has(coin)) {
      whaleFirstSeenAt.delete(`${addr}:${coin}`);
      delta.push({ coin, type: "closed", prevSizeUsd: p.sizeUsd, sizeUsd: null, side: p.side, closedAt: now });
    }
  }
  // Size changed >20%
  for (const [coin, p] of newMap) {
    const old = prevMap.get(coin);
    if (!old) continue;
    if (old.sizeUsd === 0) continue;
    const pctChange = (p.sizeUsd - old.sizeUsd) / old.sizeUsd;
    if (Math.abs(pctChange) >= 0.2) {
      delta.push({
        coin,
        type: pctChange > 0 ? "size_up" : "size_down",
        prevSizeUsd: old.sizeUsd,
        sizeUsd: p.sizeUsd,
        side: p.side,
      });
    }
  }

  return delta;
}

function fmtWhaleNotional(v) {
  if (v == null) return "?";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

async function maybeFireWhaleDeltaAlerts(addr, delta) {
  const shortAddr = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  for (const d of delta) {
    const isSignificant = d.type === "opened" || d.type === "closed"
      || (d.sizeUsd != null && d.sizeUsd >= 500_000)
      || (d.prevSizeUsd != null && d.prevSizeUsd >= 500_000);
    if (!isSignificant) continue;

    const emoji = d.type === "opened" ? "🐋" : d.type === "closed" ? "🔴" : d.type === "size_up" ? "📈" : "📉";
    const sizeStr = d.sizeUsd != null ? fmtWhaleNotional(d.sizeUsd) : fmtWhaleNotional(d.prevSizeUsd);
    const title = `${emoji} Whale ${shortAddr} ${d.type.replace("_", " ")} ${d.coin} ${d.side} ${sizeStr}`;
    const message = d.prevSizeUsd != null && d.sizeUsd != null
      ? `${fmtWhaleNotional(d.prevSizeUsd)} → ${fmtWhaleNotional(d.sizeUsd)}`
      : `Size: ${sizeStr}`;
    await fireWhaleNtfy(title, message);
  }
}

export async function handleWhaleWatch(req, res) {
  const addr = (req.query.address || WHALE_DEFAULT_ADDRESS).toLowerCase().trim();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return res.status(400).json({ error: "Invalid address format" });
  }

  const cached = whaleCache.get(addr);
  if (cached && Date.now() - cached.ts < WHALE_CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const state = await hlInfo(
      { type: "clearinghouseState", user: addr },
      { label: "dash/whaleWatch", timeoutMs: 8_000, maxRetries: 2, priority: HL_PRIORITY.LOW },
    );

    const positions = (state?.assetPositions ?? [])
      .map((ap) => ap?.position)
      .filter((p) => p?.coin && parseFloat(p.szi ?? "0") !== 0)
      .map((p) => {
        const szi = parseFloat(p.szi ?? "0");
        const entryPx = parseFloat(p.entryPx ?? "0");
        const uPnl = parseFloat(p.unrealizedPnl ?? "0");
        const lev = p.leverage?.value != null ? parseFloat(p.leverage.value) : null;
        const liqPx = p.liquidationPx != null ? parseFloat(p.liquidationPx) : null;
        const key = `${addr}:${p.coin}`;
        if (!whaleFirstSeenAt.has(key)) whaleFirstSeenAt.set(key, Date.now());
        return {
          coin: p.coin,
          side: szi < 0 ? "SHORT" : "LONG",
          szi: Math.abs(szi),
          entryPrice: entryPx,
          sizeUsd: Math.abs(szi) * entryPx,
          unrealizedPnl: uPnl,
          leverage: Number.isFinite(lev) ? lev : null,
          liquidationPrice: Number.isFinite(liqPx) ? liqPx : null,
          leverageType: p.leverage?.type ?? null,
          firstSeenAt: whaleFirstSeenAt.get(key),
        };
      });

    // Direction bias: % of total notional that's SHORT vs LONG
    const totalNotional = positions.reduce((s, p) => s + p.sizeUsd, 0);
    const shortNotional = positions.filter((p) => p.side === "SHORT").reduce((s, p) => s + p.sizeUsd, 0);
    const longNotional = totalNotional - shortNotional;
    const bias = totalNotional > 0
      ? { shortPct: (shortNotional / totalNotional) * 100, longPct: (longNotional / totalNotional) * 100 }
      : null;

    // Delta tracking — only computed on fresh fetch (TTL expired)
    const delta = computeWhaleDelta(addr, positions);
    whalePrevPositions.set(addr, positions);
    if (delta.length > 0) {
      maybeFireWhaleDeltaAlerts(addr, delta).catch(() => {});
    }

    const data = {
      address: addr,
      ts: Date.now(),
      count: positions.length,
      positions,
      totalNotional,
      totalUnrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
      bias,
      delta,
    };
    whaleCache.set(addr, { ts: Date.now(), data });
    res.json(data);
  } catch (err) {
    logger.warn(`[Dashboard] /api/whale-watch error: ${err.message}`);
    const stale = whaleCache.get(addr);
    if (stale) return res.json({ ...stale.data, stale: true });
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────
//  Whale Watch Batch — fetch multiple addresses in one request
//  Uses direct axios (NOT hlInfo semaphore) so it never blocks Scout.
//  Sequential with 80ms gap to stay within HL rate limits.
// ─────────────────────────────────────────────────

async function fetchWhaleSingle(addr) {
  const cached = whaleCache.get(addr);
  if (cached && Date.now() - cached.ts < WHALE_CACHE_TTL_MS) {
    return cached.data;
  }
  const resp = await axios.post(
    "https://api.hyperliquid.xyz/info",
    { type: "clearinghouseState", user: addr },
    { timeout: 10_000, headers: { "Content-Type": "application/json" } },
  );
  const state = resp.data;
  const positions = (state?.assetPositions ?? [])
    .map((ap) => ap?.position)
    .filter((p) => p?.coin && parseFloat(p.szi ?? "0") !== 0)
    .map((p) => {
      const szi = parseFloat(p.szi ?? "0");
      const entryPx = parseFloat(p.entryPx ?? "0");
      const uPnl = parseFloat(p.unrealizedPnl ?? "0");
      const lev = p.leverage?.value != null ? parseFloat(p.leverage.value) : null;
      const key = `${addr}:${p.coin}`;
      if (!whaleFirstSeenAt.has(key)) whaleFirstSeenAt.set(key, Date.now());
      return {
        coin: p.coin,
        side: szi < 0 ? "SHORT" : "LONG",
        szi: Math.abs(szi),
        entryPrice: entryPx,
        sizeUsd: Math.abs(szi) * entryPx,
        unrealizedPnl: uPnl,
        leverage: Number.isFinite(lev) ? lev : null,
        firstSeenAt: whaleFirstSeenAt.get(key),
      };
    });

  const totalNotional = positions.reduce((s, p) => s + p.sizeUsd, 0);
  const shortNotional = positions.filter((p) => p.side === "SHORT").reduce((s, p) => s + p.sizeUsd, 0);
  const bias = totalNotional > 0
    ? { shortPct: (shortNotional / totalNotional) * 100, longPct: ((totalNotional - shortNotional) / totalNotional) * 100 }
    : null;

  const delta = computeWhaleDelta(addr, positions);
  whalePrevPositions.set(addr, positions);
  if (delta.length > 0) maybeFireWhaleDeltaAlerts(addr, delta).catch(() => {});

  const data = {
    address: addr, ts: Date.now(), count: positions.length, positions,
    totalNotional, totalUnrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    bias, delta,
  };
  whaleCache.set(addr, { ts: Date.now(), data });
  return data;
}

export async function handleWhaleWatchBatch(req, res) {
  const raw = (req.query.addresses || "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  const addrs = raw.filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, 50);
  if (addrs.length === 0) return res.status(400).json({ error: "No valid addresses" });

  const results = [];
  for (const addr of addrs) {
    try {
      const data = await fetchWhaleSingle(addr);
      results.push({ address: addr, data });
    } catch (err) {
      const stale = whaleCache.get(addr);
      results.push({ address: addr, data: stale ? { ...stale.data, stale: true } : null, error: err.message });
    }
    // small gap between sequential requests to respect HL rate limits
    if (addrs.indexOf(addr) < addrs.length - 1) await new Promise((r) => setTimeout(r, 80));
  }

  res.json({ ts: Date.now(), count: results.length, results });
}

// ─────────────────────────────────────────────────
//  HL Leaderboard — top accounts by accountValue
// ─────────────────────────────────────────────────

const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const LEADERBOARD_CACHE_TTL_MS = 10 * 60_000;
let leaderboardCache = { ts: 0, data: null };

export async function handleWhaleLeaderboard(_req, res) {
  try {
    if (leaderboardCache.data && Date.now() - leaderboardCache.ts < LEADERBOARD_CACHE_TTL_MS) {
      return res.json(leaderboardCache.data);
    }

    const response = await axios.get(LEADERBOARD_URL, { timeout: 15_000 });
    const rows = response.data?.leaderboardRows ?? [];

    const top30 = rows
      .slice() // don't mutate
      .sort((a, b) => parseFloat(b.accountValue ?? "0") - parseFloat(a.accountValue ?? "0"))
      .slice(0, 30)
      .map((r) => {
        const perf = {};
        for (const [window, wdata] of r.windowPerformances ?? []) {
          perf[window] = wdata;
        }
        return {
          address:    r.ethAddress,
          displayName: r.displayName || null,
          accountValue: parseFloat(r.accountValue ?? "0"),
          pnl30d:  parseFloat(perf.month?.pnl  ?? "0"),
          roi30d:  parseFloat(perf.month?.roi  ?? "0"),
          vlm30d:  parseFloat(perf.month?.vlm  ?? "0"),
        };
      });

    const data = { ts: Date.now(), count: top30.length, rows: top30 };
    leaderboardCache = { ts: Date.now(), data };
    res.json(data);
  } catch (err) {
    logger.warn(`[Dashboard] /api/whale-leaderboard error: ${err.message}`);
    if (leaderboardCache.data) return res.json({ ...leaderboardCache.data, stale: true });
    res.status(500).json({ error: err.message });
  }
}
