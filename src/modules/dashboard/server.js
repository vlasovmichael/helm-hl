// ─────────────────────────────────────────────────
//  Dashboard Server — Express + WebSocket
// ─────────────────────────────────────────────────
// Слушает 0.0.0.0:3010. Доступ снаружи — через Cloudflare Tunnel + Access.

import express from "express";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "../../core/config.js";
import { logger, getLogBuffer, subscribeLogs } from "../../core/logger.js";
import { getActivePosition, getHistorySince, getArchivedHistorySince } from "../../core/database.js";
import { getAccountSummary, getPositions, getLivePrice } from "../exchange.js";
import { FEE_RATE, MAKER_FEE_RATE } from "../executor/math.js";
import { getAvailableBalance, getAccountEquity } from "../wallet.js";
import { state } from "../../app/state.js";
import { getTaxSummary } from "../taxCollector/index.js";
import { getRuntimeBlacklist } from "../executor/index.js";
import { getPriceNMinAgo, getBufferLength } from "../../core/priceHistory.js";
import { TICK_INTERVAL_MS } from "../../app/state.js";
import {
  HUNTER_SPIKE_PCT,
  HUNTER_SPIKE_WINDOW_MIN,
  HUNTER_SL_PCT,
  HUNTER_TP_PCT,
} from "../strategistSniper.js";

const HOST = "0.0.0.0";
const PORT = 3010;

const AUTH_USER = process.env.DASHBOARD_USER || '';
const AUTH_PASS = process.env.DASHBOARD_PASS || '';
const AUTH_ENABLED = AUTH_USER.length > 0 && AUTH_PASS.length > 0;

const SESSION_SECRET = crypto
  .createHash('sha256')
  .update(`${AUTH_PASS}::hl-dashboard-session-v1`)
  .digest();
const SESSION_COOKIE = 'hl-session';
const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function signSession(user, expiresAt) {
  const payload = `${user}:${expiresAt}`;
  const h = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${expiresAt}.${h}`;
}

function verifySession(token, user) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.indexOf('.');
  if (idx === -1) return false;
  const expiresAt = parseInt(token.slice(0, idx), 10);
  const sig = token.slice(idx + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`${user}:${expiresAt}`)
    .digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function constantTimeStringEqual(a, b) {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  const cookies = parseCookies(req);
  return verifySession(cookies[SESSION_COOKIE], AUTH_USER);
}

const PUBLIC_PATHS = new Set(['/login', '/styles.css', '/favicon.ico']);

function authGate(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (isAuthenticated(req)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const next_ = encodeURIComponent(req.originalUrl || '/');
  res.redirect(302, `/login?next=${next_}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");

let server = null;
let wss = null;
let broadcastTimer = null;
let unsubscribeLogs = null;

// ─────────────────────────────────────────────────
//  Status Logic (Shared)
// ─────────────────────────────────────────────────

async function getStatusData() {
  const position = getActivePosition();

  let equity = 0;
  let available = 0;
  try {
    if (config.isProduction) {
      const summary = await getAccountSummary();
      equity = summary.equity;
      available = summary.available;
    } else {
      available = await getAvailableBalance();
      equity = await getAccountEquity();
    }
  } catch {
    // fine
  }

  let currentPnl = null;
  let currentPrice = null;
  if (position) {
    try {
      currentPrice = await getLivePrice(position.coin);
    } catch {
      // оставляем null, фронт фолбэкнется на entry или pnl-derived
    }
  }

  let manualPositions = [];
  if (config.isProduction) {
    try {
      const exPositions = await getPositions();
      const botCoin = position?.coin?.toLowerCase() ?? null;
      const matchesBot = (c) => {
        if (!botCoin) return false;
        const lc = (c ?? "").toLowerCase();
        return lc === botCoin || lc === `${botCoin}-perp` || lc === `@${botCoin}` || lc.replace("-perp", "") === botCoin;
      };

      if (position) {
        const ourPos = exPositions.find((ap) => matchesBot(ap?.position?.coin));
        if (ourPos?.position) {
          const pricePnl = parseFloat(ourPos.position.unrealizedPnl ?? "0");
          const sinceOpen = parseFloat(ourPos.position.cumFunding?.sinceOpen);
          const fundingPnl = Number.isFinite(sinceOpen) ? -sinceOpen : 0;
          const entryFee = position.size_usd * FEE_RATE;
          const exitFeeMarket = position.size_usd * FEE_RATE;
          const exitFeeMaker = position.size_usd * MAKER_FEE_RATE;
          currentPnl = {
            price: pricePnl,
            funding: fundingPnl,
            entryFee,
            exitFeeMarket,
            exitFeeMaker,
            netMarket: pricePnl + fundingPnl - entryFee - exitFeeMarket,
            netMaker: pricePnl + fundingPnl - entryFee - exitFeeMaker,
          };
        }
      }

      for (const ap of exPositions) {
        const p = ap?.position;
        if (!p?.coin) continue;
        if (matchesBot(p.coin)) continue;
        const szi = parseFloat(p.szi ?? "0");
        const entryPx = parseFloat(p.entryPx ?? "0");
        if (!Number.isFinite(szi) || szi === 0) continue;
        const sizeUsd = Math.abs(szi) * entryPx;
        const liqPx = p.liquidationPx != null ? parseFloat(p.liquidationPx) : null;
        const lev = p.leverage?.value != null ? parseFloat(p.leverage.value) : null;
        let livePrice = null;
        try { livePrice = await getLivePrice(p.coin); } catch { /* ignore */ }
        manualPositions.push({
          coin: p.coin,
          side: szi < 0 ? "SHORT" : "LONG",
          szi: Math.abs(szi),
          entryPrice: entryPx,
          sizeUsd,
          unrealizedPnl: parseFloat(p.unrealizedPnl ?? "0"),
          liquidationPrice: Number.isFinite(liqPx) ? liqPx : null,
          leverage: Number.isFinite(lev) ? lev : null,
          currentPrice: livePrice,
        });
      }
    } catch (err) {
      logger.warn(`[Dashboard] positions fetch failed: ${err.message}`);
    }
  }

  return {
    mode: config.mode,
    equity,
    available,
    sessionStartEquity: state.sessionStartEquity,
    sessionProfit: state.sessionStartEquity > 0 ? equity - state.sessionStartEquity : 0,
    uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
    runtimeBans: [...getRuntimeBlacklist()],
    authEnabled: AUTH_ENABLED,
    activePosition: position
      ? {
          coin: position.coin,
          side: (position.side || 'short').toUpperCase(),
          sizeUsd: position.size_usd,
          entryPrice: position.entry_price,
          entryApy: position.entry_apy,
          entryTime: position.entry_time,
          heldHours: (Date.now() - position.entry_time) / 3_600_000,
          currentPnl,
          currentPrice,
        }
      : null,
    manualPositions,
    ts: Date.now(),
  };
}

// ─────────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────────

async function handleStatus(_req, res) {
  try {
    const data = await getStatusData();
    res.json(data);
  } catch (err) {
    logger.warn(`[Dashboard] /api/status error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function handleHistory(req, res) {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    const since = Date.now() - hours * 3_600_000;
    const dbRows = getHistorySince(since);
    const archRows = getArchivedHistorySince(since);
    const allTrades = [...dbRows, ...archRows].sort((a, b) => a.closed_at - b.closed_at);

    let currentEquity = 0;
    try {
      if (config.isProduction) {
        const summary = await getAccountSummary();
        currentEquity = summary.equity;
      } else {
        currentEquity = await getAccountEquity();
      }
    } catch {
      currentEquity = state.sessionStartEquity || 0;
    }

    const totalPnlInWindow = allTrades.reduce((sum, t) => sum + t.realized_pnl, 0);
    let runningEquity = currentEquity - totalPnlInWindow;
    const baseline = runningEquity;

    const tradePoints = allTrades.map((t) => {
      runningEquity += t.realized_pnl;
      return { ts: t.closed_at, coin: t.coin, pnl: t.realized_pnl, equity: runningEquity, reason: t.reason };
    });

    const now = Date.now();
    const points = [
      { ts: since, coin: null, pnl: 0, equity: baseline, reason: 'window_start' },
      ...tradePoints,
      { ts: now, coin: null, pnl: 0, equity: currentEquity, reason: 'now' },
    ];

    res.json({ baseline, currentEquity, windowHours: hours, tradeCount: tradePoints.length, count: points.length, points });
  } catch (err) {
    logger.warn(`[Dashboard] /api/history error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

function handleActivity(req, res) {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const since = Date.now() - hours * 3_600_000;
    const events = [];

    for (const t of getHistorySince(since)) {
      if (!t.coin) continue;
      events.push({ kind: 'close', ts: t.closed_at, coin: t.coin, pnl: t.realized_pnl, reason: t.reason, strategy_id: t.strategy_id || 'carry' });
    }
    for (const t of getArchivedHistorySince(since)) {
      if (!t.coin) continue;
      events.push({ kind: 'close', ts: t.closed_at, coin: t.coin, pnl: t.realized_pnl, reason: t.reason, strategy_id: t.strategy_id || 'carry' });
    }

    const open = getActivePosition();
    if (open && open.coin && open.entry_time >= since) {
      events.push({ kind: 'open', ts: open.entry_time, coin: open.coin, sizeUsd: open.size_usd, entryPrice: open.entry_price, entryApy: open.entry_apy, strategy_id: open.strategy_id || 'carry' });
    }

    events.sort((a, b) => b.ts - a.ts);
    res.json({ windowHours: hours, count: events.length, events: events.slice(0, limit) });
  } catch (err) {
    logger.warn(`[Dashboard] /api/activity error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

function handleSignals(req, res) {
  try {
    const limit = req.query.limit ? Math.max(1, Math.min(50, parseInt(req.query.limit, 10))) : 12;
    const data = Array.isArray(state.latestHunter) ? state.latestHunter : [];
    const now = state.latestHunterAt || Date.now();
    const trendLookback = config.trading.hunterTrendLookbackMin;
    const trendMaxRise  = config.trading.hunterTrendMaxRisePct;
    const activeCoin = getActivePosition()?.coin ?? null;

    const ticksNeeded = Math.max(2, Math.ceil((HUNTER_SPIKE_WINDOW_MIN * 60_000) / TICK_INTERVAL_MS));

    const enriched = data.map((item) => {
      const past = getPriceNMinAgo(item.coin, HUNTER_SPIKE_WINDOW_MIN, now);
      const spikePct = past != null ? ((item.price - past) / past) * 100 : null;
      const trendPast = getPriceNMinAgo(item.coin, trendLookback, now);
      const trendPct = trendPast != null ? ((item.price - trendPast) / trendPast) * 100 : null;
      const bufLen = getBufferLength(item.coin);
      return { coin: item.coin, price: item.price, spikePct, trendPct, bufLen };
    });

    // Сортировка: по абсолютной величине 2m Δ — самые заметные движения наверху.
    enriched.sort((a, b) => {
      const ax = a.spikePct == null ? -Infinity : Math.abs(a.spikePct);
      const bx = b.spikePct == null ? -Infinity : Math.abs(b.spikePct);
      return bx - ax;
    });

    const watchThreshold = HUNTER_SPIKE_PCT * 0.6;

    const top = enriched.slice(0, limit).map((m, idx) => {
      let signal = 'NEUTRAL';
      let blocked = null;
      let sl = null;
      let tp = null;
      if (m.spikePct == null) {
        signal = 'WARMUP';
      } else if (m.spikePct >= HUNTER_SPIKE_PCT) {
        signal = 'SHORT';
        if (m.trendPct != null && m.trendPct >= trendMaxRise) {
          blocked = `trend +${m.trendPct.toFixed(1)}%/${trendLookback}m`;
        }
        sl = m.price * (1 + HUNTER_SL_PCT / 100);
        tp = m.price * (1 - HUNTER_TP_PCT / 100);
      } else if (m.spikePct <= -HUNTER_SPIKE_PCT) {
        signal = 'LONG';
        if (m.trendPct != null && m.trendPct <= -trendMaxRise) {
          blocked = `trend ${m.trendPct.toFixed(1)}%/${trendLookback}m`;
        }
        sl = m.price * (1 - HUNTER_SL_PCT / 100);
        tp = m.price * (1 + HUNTER_TP_PCT / 100);
      } else if (Math.abs(m.spikePct) >= watchThreshold) {
        signal = 'WATCH';
      }
      return {
        rank: idx + 1,
        coin: m.coin,
        pair: `${m.coin}/USDC`,
        price: m.price,
        spikePct: m.spikePct,
        trendPct: m.trendPct,
        signal,
        blocked,
        sl, tp,
        slPct: sl != null ? HUNTER_SL_PCT : null,
        tpPct: tp != null ? HUNTER_TP_PCT : null,
        bufferLen: m.bufLen,
        bufferNeeded: ticksNeeded,
        isActive: activeCoin && m.coin === activeCoin,
      };
    });

    res.json({
      ts: state.latestHunterAt || 0,
      thresholds: {
        spikePct: HUNTER_SPIKE_PCT,
        spikeWindowMin: HUNTER_SPIKE_WINDOW_MIN,
        slPct: HUNTER_SL_PCT,
        tpPct: HUNTER_TP_PCT,
        trendLookbackMin: trendLookback,
        trendMaxRisePct: trendMaxRise,
      },
      universeSize: data.length,
      activeCoin,
      count: top.length,
      signals: top,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function handleLogs(req, res) {
  try {
    const limit = req.query.limit ? Math.max(1, Math.min(2000, parseInt(req.query.limit, 10))) : 500;
    const sinceId = req.query.sinceId ? parseInt(req.query.sinceId, 10) : 0;
    let entries = getLogBuffer();
    if (Number.isFinite(sinceId) && sinceId > 0) {
      entries = entries.filter((e) => e.id > sinceId);
    }
    if (entries.length > limit) entries = entries.slice(entries.length - limit);
    res.json({ count: entries.length, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function handleTaxSummary(req, res) {
  try {
    const yearParam = req.query.year ? parseInt(req.query.year, 10) : null;
    const year = (yearParam && !isNaN(yearParam)) ? yearParam : new Date().getFullYear();
    const summary = await getTaxSummary(year);
    res.json(summary);
  } catch (err) {
    logger.warn(`[Dashboard] /api/tax-summary error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

function handleLoginGet(req, res) {
  if (!AUTH_ENABLED) return res.redirect(302, '/');
  if (isAuthenticated(req)) return res.redirect(302, '/');
  res.sendFile(join(PUBLIC_DIR, 'login.html'));
}

function handleLoginPost(req, res) {
  if (!AUTH_ENABLED) return res.redirect(302, '/');
  const user = (req.body?.user || '').toString();
  const pass = (req.body?.pass || '').toString();
  const userOk = user.length === AUTH_USER.length && constantTimeStringEqual(user, AUTH_USER);
  const passOk = pass.length === AUTH_PASS.length && constantTimeStringEqual(pass, AUTH_PASS);
  if (!userOk || !passOk) return res.status(401).json({ error: 'Invalid username or password.' });
  const expiresAt = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const token = signSession(AUTH_USER, expiresAt);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`);
  res.status(204).end();
}

function handleLogout(_req, res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect(302, '/login');
}

// ─────────────────────────────────────────────────
//  Lifecycle
// ─────────────────────────────────────────────────

export function startDashboard() {
  if (server) {
    logger.warn("[Dashboard] Server already running");
    return;
  }

  const app = express();
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  app.use(authGate);

  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use((req, res, next) => {
    if (/\.(html|js|css)$/.test(req.path) || req.path === '/') {
      res.set('Cache-Control', 'no-cache');
    }
    next();
  });

  app.get("/login", handleLoginGet);
  app.post("/login", handleLoginPost);
  app.get("/logout", handleLogout);
  app.get("/api/status", handleStatus);
  app.get("/api/history", handleHistory);
  app.get("/api/activity", handleActivity);
  app.get("/api/logs", handleLogs);
  app.get("/api/signals", handleSignals);
  app.get("/api/tax-summary", handleTaxSummary);

  const ALLOWED_INTERVALS = {
    "5m": 16 * 3600_000,
    "15m": 48 * 3600_000,
    "1h": 7 * 24 * 3600_000,
    "4h": 30 * 24 * 3600_000,
    "1d": 180 * 24 * 3600_000,
  };

  app.get("/api/candles", async (req, res) => {
    try {
      const rawCoin = req.query.coin;
      if (!rawCoin) return res.status(400).json({ error: "Missing coin" });
      // Hyperliquid candleSnapshot ждёт базовый тикер ("ZEC"), а позиции отдают "ZEC-PERP"
      const stripped = rawCoin.replace(/-PERP$/i, "").replace(/^@/, "");
      const coin = /^k[A-Z]/.test(stripped) ? stripped : stripped.toUpperCase();
      const interval = ALLOWED_INTERVALS[req.query.interval] ? req.query.interval : "5m";
      const windowMs = ALLOWED_INTERVALS[interval];

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "candleSnapshot",
          req: {
            coin,
            interval,
            startTime: Date.now() - windowMs,
            endTime: Date.now(),
          },
        }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));

      const data = await r.json();
      if (data && data.error) throw new Error(data.error);
      res.json(Array.isArray(data) ? data : []);
    } catch (err) {
      logger.debug(`[Dashboard] Candles fetch failed for ${req.query.coin}: ${err.message}`);
      res.json([]);
    }
  });

  app.use(express.static(PUBLIC_DIR));


  server = app.listen(PORT, HOST, () => {
    logger.info(`[Dashboard] ✅ Listening on http://${HOST}:${PORT}`);
  });

  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (AUTH_ENABLED && !isAuthenticated(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", async (ws) => {
    try {
      const data = await getStatusData();
      ws.send(JSON.stringify({ type: "status", data }));
      ws.send(JSON.stringify({ type: "logs:init", entries: getLogBuffer() }));
    } catch (err) {
      logger.error(`[Dashboard] WS initial send failed: ${err.message}`);
    }
  });

  unsubscribeLogs = subscribeLogs((entry) => {
    if (!wss || wss.clients.size === 0) return;
    const msg = JSON.stringify({ type: "log", entry });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  });

  broadcastTimer = setInterval(async () => {
    if (!wss || wss.clients.size === 0) return;
    try {
      const data = await getStatusData();
      const msg = JSON.stringify({ type: "status", data });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(msg);
      }
    } catch (err) {
      logger.debug(`[Dashboard] WS broadcast failed: ${err.message}`);
    }
  }, 2000);

  server.on("error", (err) => {
    logger.error(`[Dashboard] Server error: ${err.message}`);
  });
}

export function stopDashboard() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (unsubscribeLogs) { unsubscribeLogs(); unsubscribeLogs = null; }
  if (!server) return;
  return new Promise((resolve) => {
    if (wss) wss.close();
    server.close(() => {
      logger.info("[Dashboard] ✅ Server stopped");
      server = null;
      resolve();
    });
  });
}
