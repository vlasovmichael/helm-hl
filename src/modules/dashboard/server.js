// ─────────────────────────────────────────────────
//  Dashboard Server — Express + WebSocket
// ─────────────────────────────────────────────────
// Слушает 0.0.0.0:3010. Доступ снаружи — через Cloudflare Tunnel + Access.

import express from "express";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../../core/config.js";
import { logger, getLogBuffer, subscribeLogs } from "../../core/logger.js";
import {
  getActivePosition,
  getHistorySince,
  getArchivedHistorySince,
  getEquitySnapshotsSince,
  realTradesForDisplay,
} from "../../core/database.js";
import { getAccountSummary, getPositions, getLivePrice } from "../exchange.js";
import { fetchUserFills, reconstructManualTrades } from "../userFills.js";
import { FEE_RATE, MAKER_FEE_RATE } from "../executor/math.js";
import { getAvailableBalance, getAccountEquity } from "../wallet.js";
import { getTaxSummary } from "../taxCollector/index.js";
import { getRuntimeBlacklist } from "../executor/index.js";
import { getPriceNMinAgo, getBufferLength } from "../../core/priceHistory.js";
import { TICK_INTERVAL_MS, state } from "../../app/state.js";
import {
  HUNTER_SPIKE_PCT,
  HUNTER_SPIKE_WINDOW_MIN,
  HUNTER_SL_PCT,
  HUNTER_TP_PCT,
} from "../strategistSniper.js";
import { getChillBoyHeartbeat } from "../strategistTrendFollow.js";
import { getNearMisses } from "../nearMisses.js";

const HOST = "0.0.0.0";
const PORT = 3010;

const AUTH_USER = process.env.DASHBOARD_USER || "";
const AUTH_PASS = process.env.DASHBOARD_PASS || "";
const AUTH_ENABLED = AUTH_USER.length > 0 && AUTH_PASS.length > 0;

const SESSION_SECRET = crypto
  .createHash("sha256")
  .update(`${AUTH_PASS}::hl-dashboard-session-v1`)
  .digest();
const SESSION_COOKIE = "hl-session";
const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function signSession(user, expiresAt) {
  const payload = `${user}:${expiresAt}`;
  const h = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("hex");
  return `${expiresAt}.${h}`;
}

function verifySession(token, user) {
  if (!token || typeof token !== "string") return false;
  const idx = token.indexOf(".");
  if (idx === -1) return false;
  const expiresAt = parseInt(token.slice(0, idx), 10);
  const sig = token.slice(idx + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`${user}:${expiresAt}`)
    .digest("hex");
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
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

const PUBLIC_PATHS = new Set(["/login", "/styles.css", "/favicon.ico"]);

function authGate(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (isAuthenticated(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const next_ = encodeURIComponent(req.originalUrl || "/");
  res.redirect(302, `/login?next=${next_}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");

let server = null;
let wss = null;
let broadcastTimer = null;
let heartbeatTimer = null;
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
        return (
          lc === botCoin ||
          lc === `${botCoin}-perp` ||
          lc === `@${botCoin}` ||
          lc.replace("-perp", "") === botCoin
        );
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
        const liqPx =
          p.liquidationPx != null ? parseFloat(p.liquidationPx) : null;
        const lev =
          p.leverage?.value != null ? parseFloat(p.leverage.value) : null;
        let livePrice = null;
        try {
          livePrice = await getLivePrice(p.coin);
        } catch {
          /* ignore */
        }
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
    sessionProfit:
      state.sessionStartEquity > 0 ? equity - state.sessionStartEquity : 0,
    uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
    runtimeBans: [...getRuntimeBlacklist()],
    authEnabled: AUTH_ENABLED,
    activePosition: position
      ? {
          coin: position.coin,
          side: (position.side || "short").toUpperCase(),
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
    // Chill Boy — только отображение состояния детектора. На реальные prod-сделки
    // не влияет: показываем когда стратегия включена (paper или prod).
    chillBoy: config.trading.chillBoyEnabled
      ? {
          enabled: true,
          prod: config.isProduction && config.trading.chillBoyProdEnabled,
          heartbeat: getChillBoyHeartbeat(),
        }
      : null,
    ts: Date.now(),
  };
}

// ─────────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────────

// Tick считается живым, если завершился не более ~8 интервалов назад.
// На TICK_INTERVAL_MS=15s это ~2 мин — переживает разовые сетевые ретраи.
const HEALTH_TICK_STALE_MS = TICK_INTERVAL_MS * 8;
// Окно от старта процесса, пока ещё ни одного tick не случилось.
const HEALTH_BOOT_GRACE_MS = 60_000;

function handleHealth(_req, res) {
  const now = Date.now();
  const tickAgeMs = state.lastTickAt > 0 ? now - state.lastTickAt : null;
  const uptimeMs = now - state.startedAt;

  let status = "ok";
  const reasons = [];

  if (state.shuttingDown) {
    status = "shutting_down";
    reasons.push("shutting_down");
  } else if (state.lastTickAt === 0) {
    if (uptimeMs > HEALTH_BOOT_GRACE_MS) {
      status = "no_tick";
      reasons.push(`no tick within ${HEALTH_BOOT_GRACE_MS}ms of boot`);
    } else {
      status = "booting";
    }
  } else if (tickAgeMs > HEALTH_TICK_STALE_MS) {
    status = "stale_tick";
    reasons.push(`tick stale ${tickAgeMs}ms (>${HEALTH_TICK_STALE_MS}ms)`);
  }

  const position = getActivePosition();
  const httpStatus = status === "ok" || status === "booting" ? 200 : 503;

  res.status(httpStatus).json({
    status,
    reasons,
    tickAgeMs,
    lastTickAt: state.lastTickAt || null,
    uptimeMs,
    lastBotStateSaveAt: state.lastBotStateSaveAt || null,
    slot: position ? "ACTIVE" : "IDLE",
    slotCoin: position ? position.coin : null,
    slotStrategy: position ? position.strategy_id || "carry" : null,
    shuttingDown: state.shuttingDown,
  });
}

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
    const now = Date.now();

    // Performance-кривая = ИЗМЕРЕННЫЙ equity (снапшоты пишутся в balanceDiag
    // раз в 5 мин), а не реконструкция из суммы PnL сделок. Старая модель
    // (currentEquity − Σpnl) ломалась на депозитах/выводах: cash-in не сделка,
    // в Σpnl не попадал — и весь baseline молча сдвигался, ступенька исчезала.
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

    const points = getEquitySnapshotsSince(since).map((s) => ({
      ts: s.ts,
      equity: s.equity,
    }));

    // Живой кончик: фактический equity «сейчас», если последний снапшот
    // старше 30с (снапшоты идут раз в 5 мин, без этого график отстаёт).
    if (points.length === 0 || now - points[points.length - 1].ts > 30_000) {
      points.push({ ts: now, equity: currentEquity });
    }

    res.json({
      currentEquity,
      windowHours: hours,
      count: points.length,
      points,
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/history error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function handleActivity(req, res) {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const since = Date.now() - hours * 3_600_000;
    const events = [];

    for (const t of realTradesForDisplay(getHistorySince(since))) {
      if (!t.coin) continue;
      events.push({
        id: t.id,
        kind: "close",
        ts: t.closed_at,
        coin: t.coin,
        pnl: t.realized_pnl,
        reason: t.reason,
        strategy_id: t.strategy_id || "carry",
      });
    }
    for (const t of realTradesForDisplay(getArchivedHistorySince(since))) {
      if (!t.coin) continue;
      events.push({
        id: t.id,
        kind: "close",
        ts: t.closed_at,
        coin: t.coin,
        pnl: t.realized_pnl,
        reason: t.reason,
        strategy_id: t.strategy_id || "carry",
      });
    }

    const open = getActivePosition();
    if (open && open.coin && open.entry_time >= since) {
      events.push({
        id: open.id,
        kind: "open",
        ts: open.entry_time,
        coin: open.coin,
        sizeUsd: open.size_usd,
        entryPrice: open.entry_price,
        entryApy: open.entry_apy,
        strategy_id: open.strategy_id || "carry",
      });
    }

    // Manual trades (closed) внутри окна — `kind: 'manual_close'`. Открытые
    // ручные позиции отдельно не дублируем (status endpoint их уже отдаёт как
    // manualPositions карточки HANDS-OFF).
    try {
      const manualTrades = await getManualTrades();
      for (const m of manualTrades) {
        if (m.status !== "closed") continue;
        if (m.closeTime < since) continue;
        events.push({
          kind: "manual_close",
          ts: m.closeTime,
          coin: m.coin,
          pnl: m.pnl,
          side: m.side,
          entryPrice: m.entryPrice,
          closePrice: m.closePrice,
          sizeUsd: m.sizeUsd,
          strategy_id: "manual",
        });
      }
    } catch {
      /* manual best-effort */
    }

    events.sort((a, b) => b.ts - a.ts);
    res.json({
      windowHours: hours,
      count: events.length,
      events: events.slice(0, limit),
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/activity error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// Multi-window spike scoring (Hunter Signals A+B).
// 2m остаётся «нативным» Hunter-окном (бот всё ещё триггерит по нему через
// HUNTER_SPIKE_PCT=5%); здесь пороги ДЛЯ ДАШБОРДА — для ручной торговли —
// специально мягче, чтобы сигналы появлялись регулярно. Tier WEAK (0.6×)
// = «следить», NORMAL (1×) = «торгуемо», STRONG (1.5×) = «уверенный сигнал».
//
// Калибровка 2026-05-08 на спокойном рынке: при 2m≥3%/5m≥4%/15m≥5%/1h≥7%
// в любой момент почти всегда есть 5-15 WEAK-сигналов в скоупе ~65 монет.
const HUNTER_SIGNAL_WINDOWS = [
  { mins: 2, threshold: 3, label: "2m" },
  { mins: 5, threshold: 4, label: "5m" },
  { mins: 15, threshold: 5, label: "15m" },
  { mins: 60, threshold: 7, label: "1h" },
];

const TIER_RANK = { STRONG: 3, NORMAL: 2, WEAK: 1, NEUTRAL: 0 };

function computeTier(absPct, threshold) {
  if (absPct >= threshold * 1.5) return "STRONG";
  if (absPct >= threshold) return "NORMAL";
  if (absPct >= threshold * 0.6) return "WEAK";
  return "NEUTRAL";
}

function handleSignals(req, res) {
  try {
    const limit = req.query.limit
      ? Math.max(1, Math.min(50, parseInt(req.query.limit, 10)))
      : 12;
    const data = Array.isArray(state.latestHunter) ? state.latestHunter : [];
    const now = state.latestHunterAt || Date.now();
    const trendLookback = config.trading.hunterTrendLookbackMin;
    const trendMaxRise = config.trading.hunterTrendMaxRisePct;
    const activeCoin = getActivePosition()?.coin ?? null;

    const ticksNeeded = Math.max(
      2,
      Math.ceil((HUNTER_SPIKE_WINDOW_MIN * 60_000) / TICK_INTERVAL_MS),
    );

    const enriched = data.map((item) => {
      // Считаем спайки по всем окнам.
      const windows = HUNTER_SIGNAL_WINDOWS.map((w) => {
        const past = getPriceNMinAgo(item.coin, w.mins, now);
        if (past == null)
          return { ...w, spikePct: null, tier: null, side: null, ratio: 0 };
        const spikePct = ((item.price - past) / past) * 100;
        const absPct = Math.abs(spikePct);
        const tier = computeTier(absPct, w.threshold);
        const side = spikePct >= 0 ? "SHORT" : "LONG"; // pump → fade short, dump → fade long
        return { ...w, spikePct, tier, side, ratio: absPct / w.threshold };
      });

      // Best signal: STRONG > NORMAL > WEAK; tiebreak — наибольший ratio (насколько выше порога).
      const ranked = windows
        .filter((w) => w.tier && w.tier !== "NEUTRAL")
        .sort(
          (a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.ratio - a.ratio,
        );
      const best = ranked[0] ?? null;

      const trendPast = getPriceNMinAgo(item.coin, trendLookback, now);
      const trendPct =
        trendPast != null ? ((item.price - trendPast) / trendPast) * 100 : null;
      const bufLen = getBufferLength(item.coin);
      const native2m = windows.find((w) => w.mins === HUNTER_SPIKE_WINDOW_MIN);
      return {
        coin: item.coin,
        price: item.price,
        spikePct: native2m?.spikePct ?? null, // обратная совместимость: старое поле = 2m
        windows,
        best,
        trendPct,
        bufLen,
      };
    });

    // Сортировка: best tier rank desc → ratio desc → 2m abs desc (для пустых).
    enriched.sort((a, b) => {
      const aRank = a.best ? TIER_RANK[a.best.tier] : 0;
      const bRank = b.best ? TIER_RANK[b.best.tier] : 0;
      if (bRank !== aRank) return bRank - aRank;
      const aRatio = a.best?.ratio ?? 0;
      const bRatio = b.best?.ratio ?? 0;
      if (bRatio !== aRatio) return bRatio - aRatio;
      const a2 = a.spikePct == null ? -Infinity : Math.abs(a.spikePct);
      const b2 = b.spikePct == null ? -Infinity : Math.abs(b.spikePct);
      return b2 - a2;
    });

    const top = enriched.slice(0, limit).map((m, idx) => {
      let signal = "NEUTRAL";
      let blocked = null;
      let sl = null;
      let tp = null;
      let tier = null;
      let windowLabel = null;
      let windowMin = null;
      let signalSpikePct = null;

      const noHistoryAtAll = m.windows.every((w) => w.spikePct == null);
      if (noHistoryAtAll) {
        signal = "WARMUP";
      } else if (m.best) {
        const b = m.best;
        tier = b.tier;
        windowLabel = b.label;
        windowMin = b.mins;
        signalSpikePct = b.spikePct;
        // SHORT/LONG для NORMAL+ (торгуемое), WATCH для WEAK (только наблюдение).
        if (b.tier === "WEAK") {
          signal = "WATCH";
        } else {
          signal = b.side; // 'SHORT' или 'LONG'
          // Anti-trend gate применяется только к торгуемым тирам.
          if (
            b.side === "SHORT" &&
            m.trendPct != null &&
            m.trendPct >= trendMaxRise
          ) {
            blocked = `trend +${m.trendPct.toFixed(1)}%/${trendLookback}m`;
          } else if (
            b.side === "LONG" &&
            m.trendPct != null &&
            m.trendPct <= -trendMaxRise
          ) {
            blocked = `trend ${m.trendPct.toFixed(1)}%/${trendLookback}m`;
          }
          if (b.side === "SHORT") {
            sl = m.price * (1 + HUNTER_SL_PCT / 100);
            tp = m.price * (1 - HUNTER_TP_PCT / 100);
          } else {
            sl = m.price * (1 - HUNTER_SL_PCT / 100);
            tp = m.price * (1 + HUNTER_TP_PCT / 100);
          }
        }
      }

      return {
        rank: idx + 1,
        coin: m.coin,
        pair: `${m.coin}/USDC`,
        price: m.price,
        spikePct: m.spikePct, // legacy: 2m спайк
        signalSpikePct, // спайк для выбранного окна
        windowLabel,
        windowMin,
        tier,
        windows: m.windows.map((w) => ({
          label: w.label,
          mins: w.mins,
          threshold: w.threshold,
          spikePct: w.spikePct,
          tier: w.tier,
          side: w.side,
        })),
        trendPct: m.trendPct,
        signal,
        blocked,
        sl,
        tp,
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
        windows: HUNTER_SIGNAL_WINDOWS.map((w) => ({
          mins: w.mins,
          threshold: w.threshold,
          label: w.label,
        })),
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

function handleNearMisses(req, res) {
  try {
    const limit = req.query.limit
      ? Math.max(1, Math.min(200, parseInt(req.query.limit, 10)))
      : 30;
    const since = req.query.since ? parseInt(req.query.since, 10) : 0;
    const events = getNearMisses({ since, limit });
    res.json({ count: events.length, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function handleTradeDetail(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    // Ищем сначала в активной истории, потом в архиве.
    const all = [...getHistorySince(0), ...getArchivedHistorySince(0)];
    const trade = all.find((t) => t.id === id);
    if (!trade) return res.status(404).json({ error: "trade not found" });
    res.json({ trade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function handleLogs(req, res) {
  try {
    const limit = req.query.limit
      ? Math.max(1, Math.min(2000, parseInt(req.query.limit, 10)))
      : 500;
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

// ─────────────────────────────────────────────────
//  P&L Summary — daily/weekly/etc breakdown for dashboard
// ─────────────────────────────────────────────────
//
// Возвращает агрегаты realized PnL + per-strategy + utilization + funding по
// 5 периодам (today/yesterday/7d/30d/all). Today/yesterday — server local TZ
// (как воспринимает пользователь), 7d/30d — rolling N*24h, all — без границы.
//
// Funding: query Hyperliquid userFunding API раз в N минут (cache), суммируем
// по period boundaries. Старые DB-записи funding_collected = NULL — игнорим.

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "d7", label: "7d" },
  { key: "d30", label: "30d" },
  { key: "all", label: "All" },
];

function periodBoundaries(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const todayStart = d.getTime();
  return {
    today: { start: todayStart, end: now },
    yesterday: { start: todayStart - 24 * 3600_000, end: todayStart },
    d7: { start: now - 7 * 24 * 3600_000, end: now },
    d30: { start: now - 30 * 24 * 3600_000, end: now },
    all: { start: 0, end: now },
  };
}

const FUNDING_CACHE_TTL_MS = 5 * 60_000;
let fundingCache = { ts: 0, deltas: [] }; // deltas: [{ts, usdc}]

async function getFundingHistory() {
  if (
    Date.now() - fundingCache.ts < FUNDING_CACHE_TTL_MS &&
    fundingCache.deltas.length > 0
  ) {
    return fundingCache.deltas;
  }
  // userFunding возвращает все funding-payments (uPnL делится на ts + usdc).
  // Берём за 60 дней — покрывает 30d period с запасом.
  try {
    const startTime = Date.now() - 60 * 24 * 3600_000;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "userFunding",
        user: config.wallet.address,
        startTime,
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    const data = await r.json();
    if (!Array.isArray(data)) return fundingCache.deltas;
    // Каждый элемент: { time, hash, delta: { coin, usdc, szi, fundingRate, nSamples } }
    const deltas = data
      .map((it) => ({
        ts: it.time,
        usdc: parseFloat(it.delta?.usdc ?? "0"),
      }))
      .filter((x) => Number.isFinite(x.usdc));
    fundingCache = { ts: Date.now(), deltas };
    return deltas;
  } catch (err) {
    logger.debug(`[Dashboard] userFunding fetch failed: ${err.message}`);
    return fundingCache.deltas; // stale-OK
  }
}

// ─────────────────────────────────────────────────
//  Manual trades cache — reconstruct from HL userFills
// ─────────────────────────────────────────────────
// Тяжёлый запрос (userFills 60d + group), кешируем на 30с.

const MANUAL_CACHE_TTL_MS = 30_000;
let manualCache = { ts: 0, trades: [] };

async function getManualTrades() {
  if (!config.isProduction) return [];
  if (Date.now() - manualCache.ts < MANUAL_CACHE_TTL_MS) {
    return manualCache.trades;
  }
  try {
    const fills = await fetchUserFills(0); // 60d default
    // Bot trades для дедупа: все history (active + archived) + текущий open.
    const botTrades = [
      ...getHistorySince(0).map((t) => ({
        coin: t.coin,
        entry_time: t.entry_time,
        closed_at: t.closed_at,
      })),
      ...getArchivedHistorySince(0).map((t) => ({
        coin: t.coin,
        entry_time: t.entry_time,
        closed_at: t.closed_at,
      })),
    ];
    const open = getActivePosition();
    if (open)
      botTrades.push({
        coin: open.coin,
        entry_time: open.entry_time,
        closed_at: null,
        status: "OPEN",
      });
    const trades = reconstructManualTrades(fills, botTrades);
    manualCache = { ts: Date.now(), trades };
    return trades;
  } catch (err) {
    logger.debug(`[Dashboard] getManualTrades failed: ${err.message}`);
    return manualCache.trades; // stale-OK
  }
}

function sumFundingInRange(deltas, start, end) {
  let sum = 0;
  for (const d of deltas) {
    if (d.ts >= start && d.ts < end) sum += d.usdc;
  }
  return sum;
}

function computeStats(trades, equityRef = 0) {
  if (trades.length === 0) {
    return {
      totalPnl: 0,
      count: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      payoffRatio: 0,
      expectancy: 0,
      bestPnl: 0,
      worstPnl: 0,
      byStrategy: {},
      totalHoldMs: 0,
      totalFees: 0,
      grossPnl: 0,
      feesPctOfGross: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
    };
  }
  let totalPnl = 0,
    wins = 0,
    losses = 0;
  let winsSum = 0,
    lossesSum = 0;
  let bestPnl = -Infinity,
    worstPnl = Infinity;
  let totalFees = 0;
  const byStrategy = {};
  let totalHoldMs = 0;
  for (const t of trades) {
    const pnl = t.realized_pnl || 0;
    const fee = t.fee_paid || 0;
    totalPnl += pnl;
    totalFees += fee;
    if (pnl > 0) {
      wins++;
      winsSum += pnl;
    } else if (pnl < 0) {
      losses++;
      lossesSum += pnl;
    }
    if (pnl > bestPnl) bestPnl = pnl;
    if (pnl < worstPnl) worstPnl = pnl;
    const sid = t.strategy_id || "carry";
    if (!byStrategy[sid]) byStrategy[sid] = { pnl: 0, count: 0, wins: 0 };
    byStrategy[sid].pnl += pnl;
    byStrategy[sid].count += 1;
    if (pnl > 0) byStrategy[sid].wins += 1;
    if (t.entry_time && t.closed_at) {
      totalHoldMs += Math.max(0, t.closed_at - t.entry_time);
    } else if (t.hold_seconds) {
      totalHoldMs += t.hold_seconds * 1000;
    }
  }
  const count = trades.length;
  const winRate = count > 0 ? (wins / count) * 100 : 0;
  const avgPnl = totalPnl / count;
  const avgWin = wins > 0 ? winsSum / wins : 0;
  const avgLoss = losses > 0 ? lossesSum / losses : 0; // negative
  const payoffRatio = losses > 0 && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : (wins > 0 ? Infinity : 0);
  // expectancy = WR·avgWin + LR·avgLoss; математически = avgPnl.
  // Дублируем explicit как самостоятельную метрику для UI.
  const expectancy = avgPnl;
  const grossPnl = totalPnl + totalFees;
  const feesPctOfGross = grossPnl !== 0 ? (totalFees / Math.abs(grossPnl)) * 100 : 0;

  // Max drawdown по equity-кривой: сортируем по closed_at, считаем cumPnL,
  // отслеживаем пик и максимальную просадку от пика.
  const sorted = [...trades].sort((a, b) => (a.closed_at || 0) - (b.closed_at || 0));
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.realized_pnl || 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  // % просадки считаем от equity счёта — это осмысленный знаменатель.
  // Старый вариант (пик кумулятивного P&L) взрывался до сотен %, когда пик
  // был копеечный: $2.41 просадки / $0.88 пик = 273%. equityRef=0 (API
  // недоступен) → null, и UI просто не показывает процент.
  const maxDrawdownPct = equityRef > 0 ? (maxDD / equityRef) * 100 : null;

  return {
    totalPnl,
    count,
    wins,
    losses,
    winRate,
    avgPnl,
    avgWin,
    avgLoss,
    payoffRatio: Number.isFinite(payoffRatio) ? payoffRatio : null,
    expectancy,
    bestPnl: bestPnl === -Infinity ? 0 : bestPnl,
    worstPnl: worstPnl === Infinity ? 0 : worstPnl,
    byStrategy,
    totalHoldMs,
    totalFees,
    grossPnl,
    feesPctOfGross,
    maxDrawdown: maxDD,
    maxDrawdownPct,
  };
}

async function handlePnlSummary(_req, res) {
  try {
    const now = Date.now();
    const bounds = periodBoundaries(now);
    const fundingDeltas = await getFundingHistory();

    // Equity счёта — знаменатель для maxDrawdown %. Падение API не критично:
    // equityNow=0 → computeStats вернёт maxDrawdownPct=null и UI скроет процент.
    let equityNow = 0;
    try {
      equityNow = config.isProduction
        ? (await getAccountSummary()).equity
        : await getAccountEquity();
    } catch {
      /* equityNow=0 → процент просадки не показываем */
    }

    // Один проход — наибольший period (all). Дальше фильтруем in-memory.
    const allDb = getHistorySince(0);
    const allArch = getArchivedHistorySince(0);
    const allTrades = realTradesForDisplay([...allDb, ...allArch]);

    // Manual trades (reconstructed from userFills, deduped against bot trades).
    const manualTrades = await getManualTrades();

    const openPos = getActivePosition();
    let unrealized = 0;
    try {
      if (openPos && config.isProduction) {
        const positions = await getPositions();
        const livePos = positions.find((p) => p.coin === openPos.coin);
        if (livePos) unrealized = parseFloat(livePos.unrealizedPnl ?? "0");
      }
    } catch {
      /* leave unrealized=0 */
    }

    const result = {};
    for (const { key } of PERIODS) {
      const { start, end } = bounds[key];
      const inRange = allTrades.filter(
        (t) => t.closed_at >= start && t.closed_at < end,
      );
      const stats = computeStats(inRange, equityNow);
      const periodMs =
        key === "all"
          ? allTrades.length > 0
            ? now - Math.min(...allTrades.map((t) => t.closed_at))
            : 1
          : end - start;
      const utilizationPct =
        periodMs > 0 ? Math.min(100, (stats.totalHoldMs / periodMs) * 100) : 0;
      const funding = sumFundingInRange(fundingDeltas, start, end);

      // Manual split: trades закрытые в этом окне.
      const manualInRange = manualTrades.filter(
        (m) =>
          m.status === "closed" && m.closeTime >= start && m.closeTime < end,
      );
      const manualPnl = manualInRange.reduce((s, m) => s + (m.pnl || 0), 0);
      const manualCount = manualInRange.length;
      const manualWins = manualInRange.filter((m) => (m.pnl || 0) > 0).length;

      result[key] = {
        ...stats,
        utilizationPct,
        funding,
        // Price-only PnL = realized_pnl − funding_collected. Если funding_collected NULL
        // (старые записи) — fallback: показываем total как есть, отдельно period funding.
        pricePnl: stats.totalPnl,
        // Bot vs manual split (2026-05-13): bot = stats (DB), manual = reconstructed.
        bot: {
          pnl: stats.totalPnl,
          count: stats.count,
          wins: stats.wins,
        },
        manual: {
          pnl: manualPnl,
          count: manualCount,
          wins: manualWins,
        },
      };
    }

    res.json({
      now,
      bounds,
      periods: result,
      unrealized,
      activeCoin: openPos?.coin || null,
      activeStrategy: openPos?.strategy_id || null,
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/pnl-summary error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────
//  Trade markers — entry/close events для price chart annotations
// ─────────────────────────────────────────────────
async function handleTradeMarkers(req, res) {
  try {
    const rawCoin = req.query.coin;
    if (!rawCoin) return res.status(400).json({ error: "Missing coin" });
    const coin = rawCoin
      .replace(/-PERP$/i, "")
      .replace(/^@/, "")
      .toUpperCase();
    const hours = req.query.hours
      ? Math.max(1, Math.min(720, parseInt(req.query.hours, 10)))
      : 168;
    const since = Date.now() - hours * 3600_000;

    const dbRows = realTradesForDisplay(getHistorySince(since)).filter(
      (t) => t.coin === coin,
    );
    const archRows = realTradesForDisplay(getArchivedHistorySince(since)).filter(
      (t) => t.coin === coin,
    );
    const closes = [...dbRows, ...archRows];

    const events = [];
    for (const t of closes) {
      if (t.entry_time && t.entry_time >= since) {
        events.push({
          kind: "entry",
          ts: t.entry_time,
          price: t.entry_price,
          side: t.side || "short",
          strategy: t.strategy_id || "carry",
        });
      }
      events.push({
        kind: "close",
        ts: t.closed_at,
        price: t.close_price,
        pnl: t.realized_pnl,
        reason: t.reason,
        side: t.side || "short",
        strategy: t.strategy_id || "carry",
      });
    }
    // Manual trades по этой монете — отдельный strategy='manual' маркер.
    try {
      const manualTrades = await getManualTrades();
      for (const m of manualTrades) {
        if (m.coin.toUpperCase() !== coin) continue;
        if (m.entryTime >= since) {
          events.push({
            kind: "entry",
            ts: m.entryTime,
            price: m.entryPrice,
            side: m.side,
            strategy: "manual",
          });
        }
        if (m.status === "closed" && m.closeTime >= since) {
          events.push({
            kind: "close",
            ts: m.closeTime,
            price: m.closePrice,
            pnl: m.pnl,
            reason: "manual_close",
            side: m.side,
            strategy: "manual",
          });
        }
      }
    } catch {
      /* manual best-effort */
    }

    // Open position (если по этой же монете) — entry без close
    const open = getActivePosition();
    if (open && open.coin === coin && open.entry_time >= since) {
      events.push({
        kind: "entry",
        ts: open.entry_time,
        price: open.entry_price,
        side: open.side || "short",
        strategy: open.strategy_id || "carry",
        active: true,
      });
    }
    events.sort((a, b) => a.ts - b.ts);
    res.json({ coin, since, count: events.length, events });
  } catch (err) {
    logger.warn(`[Dashboard] /api/trade-markers error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function handleTaxSummary(req, res) {
  try {
    const yearParam = req.query.year ? parseInt(req.query.year, 10) : null;
    const year =
      yearParam && !isNaN(yearParam) ? yearParam : new Date().getFullYear();
    const summary = await getTaxSummary(year);
    res.json(summary);
  } catch (err) {
    logger.warn(`[Dashboard] /api/tax-summary error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

function handleLoginGet(req, res) {
  if (!AUTH_ENABLED) return res.redirect(302, "/");
  if (isAuthenticated(req)) return res.redirect(302, "/");
  res.sendFile(join(PUBLIC_DIR, "login.html"));
}

function handleLoginPost(req, res) {
  if (!AUTH_ENABLED) return res.redirect(302, "/");
  const user = (req.body?.user || "").toString();
  const pass = (req.body?.pass || "").toString();
  const userOk =
    user.length === AUTH_USER.length &&
    constantTimeStringEqual(user, AUTH_USER);
  const passOk =
    pass.length === AUTH_PASS.length &&
    constantTimeStringEqual(pass, AUTH_PASS);
  if (!userOk || !passOk)
    return res.status(401).json({ error: "Invalid username or password." });
  const expiresAt = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const token = signSession(AUTH_USER, expiresAt);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`,
  );
  res.status(204).end();
}

function handleLogout(_req, res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  res.redirect(302, "/login");
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
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));

  // /api/health — публичный, до authGate, чтобы Docker HEALTHCHECK из контейнера
  // мог опрашивать без креденшалов. Возвращает 503 если tick молчит >2 мин или
  // идёт shutdown — это сигнал оркестратору рестартить контейнер.
  app.get("/api/health", handleHealth);

  app.use(authGate);

  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use((req, res, next) => {
    if (/\.(html|js|css)$/.test(req.path) || req.path === "/") {
      res.set("Cache-Control", "no-cache");
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
  app.get("/api/near-misses", handleNearMisses);
  app.get("/api/trade/:id", handleTradeDetail);
  app.get("/api/tax-summary", handleTaxSummary);
  app.get("/api/pnl-summary", handlePnlSummary);
  app.get("/api/trade-markers", handleTradeMarkers);

  const ALLOWED_INTERVALS = {
    "1m": 4 * 3600_000,
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
      const interval = ALLOWED_INTERVALS[req.query.interval]
        ? req.query.interval
        : "5m";
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
      logger.debug(
        `[Dashboard] Candles fetch failed for ${req.query.coin}: ${err.message}`,
      );
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
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", async (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    try {
      const data = await getStatusData();
      ws.send(JSON.stringify({ type: "status", data }));
      ws.send(JSON.stringify({ type: "logs:init", entries: getLogBuffer() }));
    } catch (err) {
      logger.error(`[Dashboard] WS initial send failed: ${err.message}`);
    }
  });

  // Heartbeat: пингуем клиентов раз в 30с, мёртвых (не ответивших pong с прошлого тика) убиваем.
  // Защита от idle-cut'а в reverse proxy (Cloudflare Tunnel ~100с) и от зависших коннектов.
  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try { client.ping(); } catch { /* socket уже мёртв — terminate отработает на след. тике */ }
    }
  }, 30_000);

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
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (unsubscribeLogs) {
    unsubscribeLogs();
    unsubscribeLogs = null;
  }
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
