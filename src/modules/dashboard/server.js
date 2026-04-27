// ─────────────────────────────────────────────────
//  Dashboard Server — Express
// ─────────────────────────────────────────────────
// Слушает 0.0.0.0:3010. Доступ снаружи — через Cloudflare Tunnel + Access.
// Auth: optional cookie-based session (DASHBOARD_USER / DASHBOARD_PASS).

import express from "express";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "../../core/config.js";
import { logger } from "../../core/logger.js";
import { getActivePosition, getHistorySince, getArchivedHistorySince } from "../../core/database.js";
import { getAccountSummary, getPositions } from "../exchange.js";
import { getAvailableBalance, getAccountEquity } from "../wallet.js";
import { state } from "../../app/state.js";
import { getTaxSummary } from "../taxCollector/index.js";
import { getRuntimeBlacklist } from "../executor/index.js";

const HOST = "0.0.0.0";
const PORT = 3010;

// Auth: если в .env заданы DASHBOARD_USER и DASHBOARD_PASS — требуем
// логин через отдельную страницу /login (cookie-based session).
// Иначе (default) — без auth, полагаемся на сетевой слой
// (Cloudflare Access / VPN / loopback).
const AUTH_USER = process.env.DASHBOARD_USER || '';
const AUTH_PASS = process.env.DASHBOARD_PASS || '';
const AUTH_ENABLED = AUTH_USER.length > 0 && AUTH_PASS.length > 0;

// Session secret — производный от пароля. Меняется при смене пароля
// (что инвалидирует все существующие cookies — это хорошо).
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

// Whitelist путей, которые доступны без auth (login UI + его статика).
const PUBLIC_PATHS = new Set(['/login', '/styles.css', '/favicon.ico']);

function authGate(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (isAuthenticated(req)) return next();

  // API → 401 JSON; обычные страницы → редирект на /login
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

// ─────────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────────

async function handleStatus(_req, res) {
  try {
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
        equity    = await getAccountEquity();
      }
    } catch {
      // показываем 0 — UI пометит как stale
    }

    res.json({
      mode: config.mode,
      equity,
      available,
      sessionStartEquity: state.sessionStartEquity,
      sessionProfit:
        state.sessionStartEquity > 0 ? equity - state.sessionStartEquity : 0,
      uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
      runtimeBans: [...getRuntimeBlacklist()],
      authEnabled: AUTH_ENABLED,
      activePosition: position
        ? {
            coin: position.coin,
            sizeUsd: position.size_usd,
            entryPrice: position.entry_price,
            entryApy: position.entry_apy,
            entryTime: position.entry_time,
            heldHours: (Date.now() - position.entry_time) / 3_600_000,
          }
        : null,
      ts: Date.now(),
    });
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

    const allTrades = [...dbRows, ...archRows]
      .sort((a, b) => a.closed_at - b.closed_at);

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
      return {
        ts: t.closed_at,
        coin: t.coin,
        pnl: t.realized_pnl,
        equity: runningEquity,
        reason: t.reason,
      };
    });

    const now = Date.now();
    const points = [
      { ts: since, coin: null, pnl: 0, equity: baseline, reason: 'window_start' },
      ...tradePoints,
      { ts: now, coin: null, pnl: 0, equity: currentEquity, reason: 'now' },
    ];

    res.json({
      baseline,
      currentEquity,
      windowHours: hours,
      tradeCount: tradePoints.length,
      count: points.length,
      points,
    });
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
      events.push({
        kind:        'close',
        ts:          t.closed_at,
        coin:        t.coin,
        pnl:         t.realized_pnl,
        reason:      t.reason,
        strategy_id: t.strategy_id || 'carry',
      });
    }
    for (const t of getArchivedHistorySince(since)) {
      if (!t.coin) continue;
      events.push({
        kind:        'close',
        ts:          t.closed_at,
        coin:        t.coin,
        pnl:         t.realized_pnl,
        reason:      t.reason,
        strategy_id: t.strategy_id || 'carry',
      });
    }

    const open = getActivePosition();
    if (open && open.coin && open.entry_time >= since) {
      events.push({
        kind:        'open',
        ts:          open.entry_time,
        coin:        open.coin,
        sizeUsd:     open.size_usd,
        entryPrice:  open.entry_price,
        entryApy:    open.entry_apy,
        strategy_id: open.strategy_id || 'carry',
      });
    }

    events.sort((a, b) => b.ts - a.ts);
    res.json({
      windowHours: hours,
      count:       events.length,
      events:      events.slice(0, limit),
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/activity error: ${err.message}`);
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

// ─────────────────────────────────────────────────
//  Auth routes
// ─────────────────────────────────────────────────

function handleLoginGet(req, res) {
  if (!AUTH_ENABLED) return res.redirect(302, '/');
  if (isAuthenticated(req)) return res.redirect(302, '/');
  res.sendFile(join(PUBLIC_DIR, 'login.html'));
}

function handleLoginPost(req, res) {
  if (!AUTH_ENABLED) return res.redirect(302, '/');

  const user = (req.body?.user || '').toString();
  const pass = (req.body?.pass || '').toString();

  // Constant-time compare
  const userOk = user.length === AUTH_USER.length && constantTimeStringEqual(user, AUTH_USER);
  const passOk = pass.length === AUTH_PASS.length && constantTimeStringEqual(pass, AUTH_PASS);

  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const expiresAt = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const token = signSession(AUTH_USER, expiresAt);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`,
  );
  res.status(204).end();
}

function handleLogout(_req, res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
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

  // Гейт идёт ПЕРЕД API/static. Login-страница и её ассеты в whitelist.
  app.use(authGate);

  if (AUTH_ENABLED) {
    logger.info(`[Dashboard] 🔒 Session auth enabled (user: ${AUTH_USER})`);
  } else {
    logger.info('[Dashboard] ⚠️  Auth disabled (DASHBOARD_USER/PASS not set) — relying on network-level protection');
  }

  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Статика (HTML/JS/CSS) обновляется при каждом деплое — ETag-валидация
  // через no-cache (не путать с no-store: браузер кеширует, но всегда
  // делает conditional GET). Решает проблему "обновил код, оператор видит старое".
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
  app.get("/api/tax-summary", handleTaxSummary);

  app.use(express.static(PUBLIC_DIR));

  server = app.listen(PORT, HOST, () => {
    logger.info(`[Dashboard] ✅ Listening on http://${HOST}:${PORT}`);
  });

  server.on("error", (err) => {
    logger.error(`[Dashboard] Server error: ${err.message}`);
  });
}

export function stopDashboard() {
  if (!server) return;
  return new Promise((resolve) => {
    server.close(() => {
      logger.info("[Dashboard] ✅ Server stopped");
      server = null;
      resolve();
    });
  });
}
