// ─────────────────────────────────────────────────
//  Dashboard Server — Express + WebSocket
// ─────────────────────────────────────────────────
// Слушает 0.0.0.0:3010. Доступ снаружи — через Cloudflare Tunnel + Access.

import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { config } from "../../core/config.js";
import { logger, getLogBuffer, subscribeLogs } from "../../core/logger.js";
import { hlInfo, HL_PRIORITY } from "../../core/hlClient.js";
import { getNotifications, subscribeNotifications } from "../../core/notifyLog.js";
import {
  getActivePosition,
  getActiveAdoptPositions,
  getActivePaperPosition,
  getHistorySince,
  getArchivedHistorySince,
  getEquitySnapshotsSince,
  realTradesForDisplay,
  getStrategyStats,
  getRecentStrategyTrades,
  getStrategyTradesPage,
  getStrategyPnlSince,
} from "../../core/database.js";
import { getAccountSummary, getPositionsCached, getLivePriceMap } from "../exchange.js";
import { getLivePrice as feedLivePrice, isFeedFresh } from "../../core/priceFeed.js";
import { fetchUserFills } from "../userFills.js";
import { getMonthlyLedger } from "../ledger.js";
import { FEE_RATE, MAKER_FEE_RATE } from "../executor/math.js";
import { getAvailableBalance, getAccountEquity } from "../wallet.js";
import { getTaxSummary } from "../taxCollector/index.js";
import { getRuntimeBlacklist } from "../executor/index.js";
import { TICK_INTERVAL_MS, state } from "../../app/state.js";
import { getAdoptSkipReason } from "../../app/adoptReconcile.js";
import {
  HUNTER_SL_PCT,
  HUNTER_TP_PCT,
  getHunterPeakPct,
  getHunterMaePct,
  isHunterArmed,
} from "../strategistHunter.js";
import { getAdoptPeakPct, getAdoptMaePct } from "../strategistAdopt.js";
import { getLastDailyRiskStatus } from "../dailyRisk.js";
import { getCandyGirlHeartbeat, getCandyGirlSignals, getCandyGirlStats } from "../strategistCandyGirl.js";
import { buildStrategiesPayload } from "./strategiesView.js";
import { getNearMisses } from "../nearMisses.js";
import {
  AUTH_ENABLED,
  isAuthenticated,
  authGate,
  handleLoginGet,
  handleLoginPost,
  handleLogout,
} from "./auth.js";
import { handleMarketContext } from "./routes/marketContext.js";
import {
  handleList as handleManualPaperList,
  handleOpen as handleManualPaperOpen,
  handleClose as handleManualPaperClose,
} from "./routes/manualPaper.js";
import {
  handleWhaleWatch,
  handleWhaleWatchBatch,
  handleWhaleLeaderboard,
} from "./routes/whale.js";
import {
  takeOiSnapshot,
  getMoversPayloadCached,
  handleSignals,
  handleWhatIf,
  OI_SNAPSHOT_MS,
} from "./routes/movers.js";
import { getManualTrades } from "./routes/manualTrades.js";
import { handlePnlSummary, handleInsights, handleDayJournal, handleDayNoteSave } from "./routes/pnl.js";
import {
  DIVERGENCE_WATCHLIST,
  DIVERGENCE_SNAPSHOT_MS,
  refreshDivergenceSnapshot,
  buildDivergencePayload,
  hasDivergenceSnapshots,
  handleBtcDivergence,
  handleBtcDivergenceAll,
} from "./routes/divergence.js";

const HOST = "0.0.0.0";
const PORT = 3010;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Прод раздаёт собранную Vite-сборку (npm run build:dash → dist/). Имена ассетов
// хэшируются Vite'ом, поэтому ручной cache-bust больше не нужен: index.html отдаём
// no-cache, а хэшированные app/styles браузер кэширует навсегда (immutable).
// Дев фронта живёт на отдельном vite-сервере (npm run dev:dash), сюда не заходит.
const PUBLIC_DIR = join(__dirname, "dist");
function handleIndex(_req, res) {
  try {
    const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
    res.set("Cache-Control", "no-cache");
    res.type("html").send(html);
  } catch (err) {
    logger.warn(
      `[Dashboard] index render failed: ${err.message} — собрана ли дашборда? (npm run build:dash)`,
    );
    res.status(500).send("dashboard build missing — run: npm run build:dash");
  }
}

let server = null;
let wss = null;
let broadcastTimer = null;
let heartbeatTimer = null;
let unsubscribeLogs = null;
let unsubscribeNotifications = null;
let divergenceTimer = null;

// ─────────────────────────────────────────────────
//  Status Logic (Shared)
// ─────────────────────────────────────────────────


// Локальная полночь сегодня в ms — граница «за день» для paper-summary.
function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Сводка того, как БОТ ведёт активную позицию прямо сейчас: где стоп, взведён
// ли breakeven-храповик / трейл, какой пик. Дашборд показывает это как статус
// (а не советы оператору) — позицией рулит бот, человек только наблюдает.
function buildBotManagement(position) {
  if (!position) return null;
  const entry = position.entry_price;
  if (!entry) return null;
  const isShort = (position.side || "short").toLowerCase() === "short";
  const sid = position.strategy_id || "carry";

  // Hunter SHORT — стоп/тейк фиксированы от входа, трейл/BE в in-memory мапах.
  if (sid === "hunter") {
    const peakPct = getHunterPeakPct(position.id) ?? 0;
    const beArmed =
      config.trading.hunterBeRatchetEnabled &&
      peakPct >= config.trading.hunterBeArmPct;
    const trailArmed =
      config.trading.hunterTrailEnabled &&
      (isHunterArmed(position.id) ||
        peakPct >= config.trading.hunterTrailArmPct);

    // Живой пол: где бот РЕАЛЬНО выйдет прямо сейчас (в unrealized % от входа,
    // плюс = прибыль). Трейл → пик−giveback; BE взведён → безубыток (floor);
    // иначе → жёсткий −SL. Статичный «стоп −2%» врал, как только взводился
    // храповик — оператор видел −2%, а бот уже держал безубыток (2026-06-14).
    let floorPct, floorKind;
    if (trailArmed) {
      floorPct = peakPct * (1 - config.trading.hunterTrailGiveBackPct / 100);
      floorKind = "trail";
    } else if (beArmed) {
      floorPct = config.trading.hunterBeFloorPct;
      floorKind = "be";
    } else {
      floorPct = -HUNTER_SL_PCT;
      floorKind = "stop";
    }
    // unrealized% = (entry − price)/entry·100 для шорта (зеркально для лонга).
    // price на полу: price = entry·(1 − dir·floorPct/100), dir=+1 short / −1 long.
    const dir = isShort ? 1 : -1;
    const floorPrice = entry * (1 - dir * (floorPct / 100));

    return {
      strategy: sid,
      stopPrice: entry * (1 + (isShort ? 1 : -1) * (HUNTER_SL_PCT / 100)),
      tpPrice: entry * (1 - (isShort ? 1 : -1) * (HUNTER_TP_PCT / 100)),
      stopPct: HUNTER_SL_PCT,
      initialRiskPct: HUNTER_SL_PCT, // исходный риск (для R-multiple на фронте)
      peakPct,
      maePct: getHunterMaePct(position.id),
      beArmed,
      beArmPct: config.trading.hunterBeArmPct, // веха храповика (% от входа)
      trailArmed,
      floorPct, // живой пол в unrealized % (плюс = прибыль)
      floorPrice, // цена, на которой бот закроется сейчас
      floorKind, // 'trail' | 'be' | 'stop'
      timeStopMin: config.trading.hunterTimeStopMin, // max-hold: фронт считает остаток от heldHours
    };
  }

  // Прочие стратегии: показываем сохранённый стоп/тейк, если есть.
  if (position.sl_price || position.tp_price) {
    const initialRiskPct =
      position.sl_price != null
        ? Math.abs((entry - position.sl_price) / entry) * 100
        : null;
    return {
      strategy: sid,
      stopPrice: position.sl_price ?? null,
      tpPrice: position.tp_price ?? null,
      stopPct: null,
      initialRiskPct,
      peakPct: null,
      beArmed: false,
      trailArmed: false,
    };
  }
  return { strategy: sid, stopPrice: null, tpPrice: null, peakPct: null, beArmed: false, trailArmed: false };
}

// То же, что buildBotManagement, но для ручного входа под adopt-нянькой.
// Логика выхода у adopt зеркальна Hunter (трейл пик−giveback / BE-безубыток /
// жёсткий resting-SL на бирже), пороги — из adopt-конфига. Даёт оператору тот же
// живой пол для ручной позиции, что и для бот-сделки (2026-06-14).
function buildAdoptManagement(adoptPos) {
  if (!adoptPos) return null;
  const entry = adoptPos.entry_price;
  if (!entry) return null;
  const isShort = (adoptPos.side || "short").toLowerCase() === "short";
  const peakPct = getAdoptPeakPct(adoptPos.id) ?? 0;
  const t = config.trading;

  const trailArmed = peakPct >= t.adoptTrailArmPct;
  const beArmed = peakPct >= t.adoptBeArmPct;

  let floorPct, floorKind;
  if (trailArmed) {
    floorPct = peakPct * (1 - t.adoptTrailGiveBackPct / 100);
    floorKind = "trail";
  } else if (beArmed) {
    floorPct = t.adoptBeFloorPct;
    floorKind = "be";
  } else if (adoptPos.sl_price != null) {
    // Жёсткий resting-SL стоит на бирже — берём его реальный % от входа.
    floorPct = isShort
      ? ((entry - adoptPos.sl_price) / entry) * 100
      : ((adoptPos.sl_price - entry) / entry) * 100;
    floorKind = "stop";
  } else {
    return { strategy: "adopt", peakPct, floorPct: null, floorKind: "stop" };
  }
  const dir = isShort ? 1 : -1;
  const floorPrice = entry * (1 - dir * (floorPct / 100));
  // Исходный риск (для R-multiple): дистанция входа до resting-SL на бирже.
  // Стабильна даже когда BE/трейл взвели floorPct в плюс (hard SL не двигается).
  const initialRiskPct =
    adoptPos.sl_price != null
      ? Math.abs((entry - adoptPos.sl_price) / entry) * 100
      : null;

  return {
    strategy: "adopt",
    stopPrice: adoptPos.sl_price ?? null,
    initialRiskPct,
    peakPct,
    maePct: getAdoptMaePct(adoptPos.id),
    beArmed,
    beArmPct: t.adoptBeArmPct, // веха храповика (% от входа)
    trailArmed,
    floorPct,
    floorPrice,
    floorKind,
  };
}

// HL 2026-05-23: unified-by-default. Раньше дашборд отдельно дёргал
// spotClearinghouseState чтобы показать "Wallet Total", потому что perp
// accountValue не включал spot. Теперь getAccountSummary() / wallet.js
// уже считают всё через spot (см. memory/hl_unified_migration_2026_05_23.md),
// отдельный snapshot не нужен.

async function getStatusData() {
  // adopt — это ручной вход под няней (multi-slot), а не бот-сделка. Его место
  // в manual-секции с пометкой ADOPTED, а не в главной карточке. Главную карточку
  // оставляем только настоящей бот-стратегии (hunter/carry/...). getActivePosition()
  // отдаёт самый свежий OPEN-слот, и им запросто оказывается adopt — отсюда раньше
  // «как будто бот сам открыл». (2026-06-13)
  const slotPos = getActivePosition();
  const isAdoptSlot = !!slotPos && (slotPos.strategy_id || "carry") === "adopt";
  const position = isAdoptSlot ? null : slotPos;
  // Координаты усыновлённых монет (нормализованные) — для пометки manual-карточек.
  const normCoin = (c) =>
    (c ?? "").toLowerCase().replace(/^@/, "").replace(/-perp$/, "");
  const adoptedCoins = new Set();
  const adoptByCoin = new Map(); // normCoin → adopt DB-позиция (для живого пола)
  if (config.isProduction) {
    try {
      for (const ap of getActiveAdoptPositions()) {
        const nc = normCoin(ap.coin);
        adoptedCoins.add(nc);
        adoptByCoin.set(nc, ap);
      }
    } catch {
      /* ignore */
    }
  }

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

  // Цены для дашборда (чистый display, broadcast крутится каждые 2с). Раньше
  // тут вызывался exchange.getLivePrice() по разу на КАЖДУЮ ручную позицию
  // (цикл ниже) — при протухшем/выключенном WS-фиде каждый вызов летел тяжёлым
  // metaAndAssetCtxs (весь universe) → N последовательных REST за тик → 429.
  // Теперь: свежий фид → mid из WS-кэша (0 HTTP); иначе ОДИН батч-map за тик.
  const feedFresh = isFeedFresh();
  const priceMap = feedFresh ? null : await getLivePriceMap();
  const wsPrice = (coin) =>
    feedFresh
      ? (feedLivePrice(coin)?.price ?? null)
      : (priceMap.get(String(coin).toUpperCase()) ?? null);

  let currentPnl = null;
  let currentPrice = null;
  if (position) {
    currentPrice = wsPrice(position.coin);
  }

  let manualPositions = [];
  if (config.isProduction) {
    try {
      const exPositions = await getPositionsCached();
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
        const livePrice = wsPrice(p.coin);
        // Расхождение DB-строки adopt с ЖИВОЙ позой по стороне = оператор флипнул
        // (short→long), а integrity ещё не переусыновил. Старое управление
        // (стоп/пик) от мёртвой стороны показывать НЕЛЬЗЯ — иначе карточка врёт
        // (LIT-инцидент 2026-06-18: лонг с ярлыком ADOPTED вёл стоп от шорта).
        const adoptPos = adoptByCoin.get(normCoin(p.coin));
        const liveSideLower = szi < 0 ? "short" : "long";
        const adoptResyncing =
          !!adoptPos && (adoptPos.side || "short").toLowerCase() !== liveSideLower;
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
          // Время открытия (для Floor-таймера 15-мин чекпоинта). Знаем его только
          // для усыновлённых поз — из adopt DB-строки; HL live-поза время открытия
          // не несёт. Голый HANDS-OFF без adopt → null → таймер просто не светится.
          entryTime: adoptPos?.entry_time ?? null,
          // Бот уже подхватил этот ручной вход (adopt-нянька повесила стоп+трейл)?
          adopted: adoptedCoins.has(normCoin(p.coin)),
          // Флип: DB-строка отстала от живой стороны → бот пере-усыновляет.
          adoptResyncing,
          // Если НЕ подхватил — почему (виден на дашборде, без лазанья в логи).
          adoptSkipReason: adoptedCoins.has(normCoin(p.coin))
            ? null
            : getAdoptSkipReason(p.coin),
          // Живой пол adopt-няньки — тот же форвард, что у бот-сделки. При
          // рассинхроне стороны (флип) НЕ отдаём — управление от мёртвой ноги.
          bot: adoptResyncing ? null : buildAdoptManagement(adoptPos),
        });
      }
    } catch (err) {
      logger.warn(`[Dashboard] positions fetch failed: ${err.message}`);
    }
  }

  // Hot Movers едут в WS-статусе (≤2с свежесть вместо 10с-поллинга). enrich=false:
  // always-on броадкаст НЕ дёргает candleSnapshot (Vol×/HTF) — иначе шторм
  // тяжёлых запросов выжирал весовой бюджет HL и 429-ил торговые чтения. Строки
  // (цена/спайки/окна/OI) считаются локально. Vol×/HTF — по запросу /api/signals.
  const hotMovers = await getMoversPayloadCached(30, false);

  // Живая цена BTC из WS-фида (allMids) — чтобы плашка Market Context обновляла
  // цену каждые 2с (кадр статуса), а не ждала 10с-поллинг /api/market-context.
  // null → фронт оставит последнюю из поллинга. 2026-06-29.
  const btcLivePrice = feedLivePrice("BTC")?.price ?? null;

  return {
    mode: config.mode,
    hotMovers,
    btcLivePrice,
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
          strategyId: position.strategy_id || "carry",
          sizeUsd: position.size_usd,
          entryPrice: position.entry_price,
          entryApy: position.entry_apy,
          entryTime: position.entry_time,
          heldHours: (Date.now() - position.entry_time) / 3_600_000,
          currentPnl,
          currentPrice,
          bot: buildBotManagement(position),
        }
      : null,
    manualPositions,
    // Дневной стоп-лосс (backend-правда по fills, см. dailyRisk.js): фронт
    // переключает бейдж «Today» в «стоп: входы закрыты».
    dailyRisk: getLastDailyRiskStatus(),
    // Единый обзор всех стратегий (реестр-driven) для таблицы на /strategies.
    strategies: buildStrategiesPayload(),
    // Candy Girl — signal-only радар (1h EMA-тренд + 5m pullback-reclaim).
    // Сигналы кормят Smart Signals и Swing-подтверждение; торгового слота нет.
    candyGirl: config.trading.candyGirlEnabled
      ? {
          enabled: true,
          heartbeat: getCandyGirlHeartbeat(),
          signals: getCandyGirlSignals(),
          stats: getCandyGirlStats(),
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
    const now = Date.now();
    // hours<=0 («All») = вся удержанная история снапшотов (retention 35 дней).
    const since = hours > 0 ? now - hours * 3_600_000 : 0;

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

// Дедуп display-лент против БД-истории. ЕДИНЫЙ источник правды для всего, что
// бот записал (bot + adopted), — таблица `history`. Реконструкция из fills нужна
// только чтобы показать ЧИСТО ручные трейды, которых в истории нет. Проблема: у
// adopted-позы вход — ручной fill, поэтому она живёт И в history, И в fills; если
// reconstruct не успел пометить ногу `adopted` (entry_time ещё не бэкфилнут / нет
// бот-OID), та же сделка задваивалась в ленте — один раз из history (`close`),
// второй как `manual_close`. Поэтому из fills-ветки выкидываем round-trip'ы,
// которые история уже покрывает: закрытые — по coin + времени закрытия (надёжное,
// обе стороны берут время того же fill); открытые — по coin активного слота
// (архитектура single-slot). closed_at adopt-флипа = реальное время ноги, так что
// допуска в несколько секунд хватает с запасом на округления/индексацию.
const DEDUP_TS_TOLERANCE_MS = 5_000;
export function makeHistoryCoverage(historyRows, activePos) {
  const closesByCoin = new Map();
  for (const t of historyRows || []) {
    if (!t?.coin || !Number.isFinite(t.closed_at)) continue;
    const c = t.coin.toUpperCase();
    if (!closesByCoin.has(c)) closesByCoin.set(c, []);
    closesByCoin.get(c).push(t.closed_at);
  }
  const openCoin = activePos?.coin ? activePos.coin.toUpperCase() : null;
  return {
    // Закрытая ручная нога уже записана ботом (adopted/bot) → не дублируем.
    closedCovered: (coin, closeTs) => {
      if (!coin || !Number.isFinite(closeTs)) return false;
      const arr = closesByCoin.get(coin.toUpperCase());
      return Array.isArray(arr) && arr.some((t) => Math.abs(t - closeTs) <= DEDUP_TS_TOLERANCE_MS);
    },
    // Открытая ручная нога = текущая активная поза (single-slot) → не дублируем.
    openCovered: (coin) => openCoin != null && !!coin && coin.toUpperCase() === openCoin,
  };
}

async function handleActivity(req, res) {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const since = Date.now() - hours * 3_600_000;
    const events = [];

    // Источник сделки: adopt-слот = ручной вход под бот-нянькой ('adopted'),
    // strategy_id 'manual' = чистая ручная, всё остальное = бот ('bot').
    const sourceOf = (sid) =>
      sid === "adopt" ? "adopted" : sid === "manual" ? "manual" : "bot";

    const pushClose = (t) => {
      if (!t.coin) return;
      const sid = t.strategy_id || "carry";
      events.push({
        id: t.id,
        kind: "close",
        ts: t.closed_at,
        coin: t.coin,
        pnl: t.realized_pnl,
        reason: t.reason,
        side: t.side,
        sizeUsd: t.size_usd,
        entryPrice: t.entry_price,
        entryTime: t.entry_time,
        fee: t.fee_paid,
        strategy_id: sid,
        source: sourceOf(sid),
      });
    };
    const histRows = [
      ...realTradesForDisplay(getHistorySince(since)),
      ...realTradesForDisplay(getArchivedHistorySince(since)),
    ];
    for (const t of histRows) pushClose(t);

    const open = getActivePosition();
    const coverage = makeHistoryCoverage(histRows, open);
    if (open && open.coin && open.entry_time >= since) {
      const sid = open.strategy_id || "carry";
      events.push({
        id: open.id,
        kind: "open",
        ts: open.entry_time,
        coin: open.coin,
        side: open.side,
        sizeUsd: open.size_usd,
        entryPrice: open.entry_price,
        entryApy: open.entry_apy,
        strategy_id: sid,
        source: sourceOf(sid),
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
        // Уже записана ботом как adopted/bot — не дублируем (см. makeHistoryCoverage).
        if (coverage.closedCovered(m.coin, m.closeTime)) continue;
        events.push({
          kind: "manual_close",
          ts: m.closeTime,
          coin: m.coin,
          pnl: (m.pnl || 0) - (m.fee || 0), // net, как history-сделки
          side: m.side,
          entryPrice: m.entryPrice,
          closePrice: m.closePrice,
          sizeUsd: m.sizeUsd,
          reason: m.reason,
          strategy_id: "manual",
          source: "manual",
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
    // Покрытые историей ноги (adopted/bot) пропускаем целиком — entry и close
    // уже добавлены из БД выше (см. makeHistoryCoverage).
    const coverage = makeHistoryCoverage(closes, getActivePosition());
    try {
      const manualTrades = await getManualTrades();
      for (const m of manualTrades) {
        if (m.coin.toUpperCase() !== coin) continue;
        const covered =
          m.status === "closed"
            ? coverage.closedCovered(m.coin, m.closeTime)
            : coverage.openCovered(m.coin);
        if (covered) continue;
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
            pnl: (m.pnl || 0) - (m.fee || 0), // net, как history-сделки
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

async function handleLedger(_req, res) {
  try {
    const ledger = await getMonthlyLedger();
    res.json(ledger);
  } catch (err) {
    logger.warn(`[Dashboard] /api/ledger error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
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
  app.use(express.json({ limit: "4kb" }));

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
  app.get("/", handleIndex);
  app.get("/index.html", handleIndex);
  app.get("/api/status", handleStatus);
  app.get("/api/history", handleHistory);
  app.get("/api/activity", handleActivity);
  app.get("/api/logs", handleLogs);
  app.get("/api/signals", handleSignals);
  app.get("/api/whatif", handleWhatIf);
  app.get("/api/near-misses", handleNearMisses);
  app.get("/api/trade/:id", handleTradeDetail);
  app.get("/api/tax-summary", handleTaxSummary);
  app.get("/api/ledger", handleLedger);
  app.get("/api/pnl-summary", handlePnlSummary);
  app.get("/api/strategies", (_req, res) => {
    try {
      res.json(buildStrategiesPayload());
    } catch (err) {
      logger.warn(`[Dashboard] /api/strategies failed: ${err.message}`);
      res.status(500).json({ rows: [], planned: [], error: true });
    }
  });
  // Постраничные сделки стратегии (ленивая подгрузка в detail таблицы Strategies).
  app.get("/api/strategy-trades", (req, res) => {
    const strategy = String(req.query.strategy || "");
    const mode = req.query.mode === "PRODUCTION" ? "PRODUCTION" : "PAPER";
    const side = req.query.side === "long" || req.query.side === "short" ? req.query.side : null;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (!strategy) return res.status(400).json({ error: "strategy required" });
    try {
      const { total, trades } = getStrategyTradesPage(strategy, mode, limit, offset, side);
      res.json({ strategy, side, mode, limit, offset, total, trades });
    } catch (err) {
      logger.warn(`[Dashboard] /api/strategy-trades failed: ${err.message}`);
      res.status(500).json({ error: true });
    }
  });
  // Журнал ушедших ntfy-пушей для колокольчика. ?limit (≤100).
  app.get("/api/notifications", (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    try {
      res.json({ items: getNotifications(limit), generatedAt: Date.now() });
    } catch (err) {
      logger.warn(`[Dashboard] /api/notifications failed: ${err.message}`);
      res.status(500).json({ items: [], error: true });
    }
  });
  // Личный paper-журнал (Rabbit-style): открыть/закрыть/список бумажных сделок.
  app.get("/api/manual-paper", handleManualPaperList);
  app.post("/api/manual-paper/open", handleManualPaperOpen);
  app.post("/api/manual-paper/close", handleManualPaperClose);

  app.get("/api/insights", handleInsights);
  app.get("/api/day-journal", handleDayJournal);
  app.post("/api/day-journal", handleDayNoteSave);
  app.get("/api/trade-markers", handleTradeMarkers);
  app.get("/api/btc-divergence", handleBtcDivergence);
  app.get("/api/market-context", handleMarketContext);
  app.get("/api/btc-divergence/all", handleBtcDivergenceAll);
  app.get("/api/whale-watch", handleWhaleWatch);
  app.get("/api/whale-watch/batch", handleWhaleWatchBatch);
  app.get("/api/whale-leaderboard", handleWhaleLeaderboard);

  // Debug: посмотреть что реально выдаёт getManualTrades() — для расследования
  // багов в reconstructManualTrades. JSON со списком всех восстановленных
  // ручных трейдов + raw PURR fills из последнего fetchUserFills.
  app.get("/api/_debug/manual", async (_req, res) => {
    try {
      const manualTrades = await getManualTrades();
      const fills = await fetchUserFills(0);
      const purrFills = fills.filter((f) => f.coin === "PURR");
      res.json({
        now: Date.now(),
        manualCount: manualTrades.length,
        manualTrades,
        purrFills,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const ALLOWED_INTERVALS = {
    "1m": 4 * 3600_000,
    "5m": 16 * 3600_000,
    "15m": 48 * 3600_000,
    "1h": 7 * 24 * 3600_000,
    "4h": 30 * 24 * 3600_000,
    "1d": 180 * 24 * 3600_000,
  };
  // TTL кеша /api/candles по interval: одна свеча обновляется на бирже не чаще
  // чем раз в interval. Берём ~80% interval как потолок свежести, минимум 30s.
  const CANDLES_CACHE_TTL = {
    "1m": 30_000,
    "5m": 60_000,
    "15m": 5 * 60_000,
    "1h": 10 * 60_000,
    "4h": 15 * 60_000,
    "1d": 30 * 60_000,
  };
  const candlesCache = new Map(); // key=`${coin}|${interval}` → { ts, data, inFlight? }

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
      const ttl      = CANDLES_CACHE_TTL[interval] ?? 60_000;
      const cacheKey = `${coin}|${interval}`;

      const now    = Date.now();
      const cached = candlesCache.get(cacheKey);
      if (cached && cached.data && now - cached.ts < ttl) {
        return res.json(cached.data);
      }
      // Coalesce: если запрос уже в полёте — ждём его (избегаем шторма при
      // нескольких открытых вкладках дашборда).
      if (cached?.inFlight) {
        try {
          const data = await cached.inFlight;
          return res.json(Array.isArray(data) ? data : []);
        } catch {
          return res.json([]);
        }
      }

      const promise = hlInfo(
        {
          type: "candleSnapshot",
          req: { coin, interval, startTime: now - windowMs, endTime: now },
        },
        { label: "dash/candles", timeoutMs: 5000, maxRetries: 2, priority: HL_PRIORITY.LOW },
      );
      candlesCache.set(cacheKey, { ts: now, data: null, inFlight: promise });

      try {
        const data = await promise;
        if (data && data.error) throw new Error(data.error);
        const arr = Array.isArray(data) ? data : [];
        candlesCache.set(cacheKey, { ts: Date.now(), data: arr });
        res.json(arr);
      } catch (err) {
        // На ошибке оставляем старый data (если был) и обнуляем inFlight чтобы
        // не залипать. Следующий запрос попробует снова после TTL stale-data.
        const prev = candlesCache.get(cacheKey);
        candlesCache.set(cacheKey, { ts: prev?.ts ?? 0, data: prev?.data ?? null });
        logger.debug(
          `[Dashboard] Candles fetch failed for ${req.query.coin}: ${err.message}`,
        );
        res.json(prev?.data ?? []);
      }
    } catch (err) {
      logger.debug(`[Dashboard] /api/candles error: ${err.message}`);
      res.json([]);
    }
  });

  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders: (res, filePath) => {
        // Хэшированные ассеты Vite (/assets/*.[hash].js|css) иммутабельны → кэшим навсегда.
        // HTML отдаём no-cache, чтобы новые хэши подхватывались сразу после деплоя.
        if (filePath.includes("/assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

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
      if (hasDivergenceSnapshots()) {
        ws.send(JSON.stringify({ type: "btc-divergence", data: buildDivergencePayload(DIVERGENCE_WATCHLIST) }));
      }
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

  // Уведомления (колокольчик) — пушим мгновенно в WS, как только пуш записан в
  // журнал. Раньше дашборд узнавал о них поллингом /api/notifications (≤60с лаг,
  // ntfy на телефоне приходил раньше). Теперь телефон и дашборд звонят синхронно.
  unsubscribeNotifications = subscribeNotifications((item) => {
    if (!wss || wss.clients.size === 0) return;
    const msg = JSON.stringify({ type: "notification", item });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  });

  // Снапшот divergence считается в модуле; broadcast свежего payload
  // подключённым WS-клиентам остаётся здесь (где живёт wss).
  const pumpDivergence = async () => {
    const stored = await refreshDivergenceSnapshot();
    if (stored && wss && wss.clients.size > 0) {
      const msg = JSON.stringify({ type: "btc-divergence", data: buildDivergencePayload(DIVERGENCE_WATCHLIST) });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(msg);
      }
    }
  };
  pumpDivergence();
  divergenceTimer = setInterval(pumpDivergence, DIVERGENCE_SNAPSHOT_MS);

  setInterval(takeOiSnapshot, OI_SNAPSHOT_MS);

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
  if (divergenceTimer) { clearInterval(divergenceTimer); divergenceTimer = null; }
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (unsubscribeLogs) {
    unsubscribeLogs();
    unsubscribeLogs = null;
  }
  if (unsubscribeNotifications) {
    unsubscribeNotifications();
    unsubscribeNotifications = null;
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
