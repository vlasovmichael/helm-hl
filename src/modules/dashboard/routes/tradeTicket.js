// ─────────────────────────────────────────────────
//  Trade Ticket — ручное открытие/закрытие позиции с дашборда
// ─────────────────────────────────────────────────
// Ордера уходят через SDK и не несут builder-fee, которую сторонние фронтенды
// вшивают в ордер (2 бп, +46% к тейкерской ставке).
//
// 🔒 ГРАНИЦА ОТВЕТСТВЕННОСТИ, не размывать: ручки ТОЛЬКО кладут ордер на биржу.
// Они не пишут в `positions`, не ставят стопы и не ведут позицию — дальше всё
// как при входе с сайта биржи: orphanCheck увидит позу, adopt усыновит её и
// повесит ATR-стоп. Своя строка в БД сделала бы второго владельца позиции —
// класс рассинхрона «зеркало ≠ биржа».
//
// Почему серверные проверки дублируют клиентские: клиенту доверять нельзя, это
// живые деньги. Всё, что гейтит форму в браузере, продублировано здесь.

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { retryWithBackoff } from "../../../core/retry.js";
import {
  openMarket,
  closeMarket,
  placeLimit,
  getAccountSummary,
  getBalance,
  setLeverage,
  getPositions,
} from "../../exchange.js";
import { getLivePrice } from "../../../core/priceFeed.js";
import { getLivePriceMap } from "../../exchange.js";
import { fetchExchangePositions } from "../../sync.js";
import { getFrontendOpenOrders } from "../../exchange.js";
import { resolveAsset, parseFillResponse } from "../../executor/fill-parser.js";
import { formatHlPrice, MARKET_SLIPPAGE } from "../../executor/math.js";
import { computeStopDistPct } from "../../../app/adoptReconcile.js";
import { HL_PRIORITY } from "../../../core/hlClient.js";
import { getLastDailyRiskStatus } from "../../dailyRisk.js";
import { computeTradesToday, computeCooldown } from "../../tradeGuards.js";
import { getHistorySince, getActiveAdoptPositions, getActivePosition } from "../../../core/database.js";
import { getUniverse } from "../../../core/universe.js";

// Биржевой минимум ордера на HL. Меньше — гарантированный отказ.
const MIN_ORDER_USD = 10;

// Наш собственный потолок плеча — НЕ биржевой. При стопе няньки ~−7% ATR
// изолированная ликвидация на 20x приходит около −5%, то есть РАНЬШЕ стопа:
// стоп перестаёт быть стопом. На 10x запас ещё есть.
//
// Эффективный потолок = min(биржевой для монеты, WALLET_LEVERAGE_CAP).
// Биржевые лимиты разные: CASHCAT/CHIP/ACE = 3x, LIT = 5x, DOGE = 10x,
// ETH = 25x, BTC = 40x. Одним числом их подменять нельзя — проверено.
const WALLET_LEVERAGE_CAP = 10;

/** Максимальное плечо по монете: биржевое, прижатое нашим потолком. null если тикер неизвестен. */
function maxLeverageFor(coin) {
  const asset = getUniverse().find((a) => String(a?.name).toUpperCase() === coin);
  if (!asset) return null;
  const exchangeMax = Number(asset.maxLeverage);
  if (!Number.isFinite(exchangeMax) || exchangeMax < 1) return null;
  return { exchangeMax, effective: Math.min(WALLET_LEVERAGE_CAP, exchangeMax) };
}

// Потолок нотионала на одну ручную сделку. Защита от опечатки и от того, что
// одна сделка съест весь депозит. Не риск-менеджмент — грубый предохранитель.
const MAX_NOTIONAL_USD = 60;

// Потолок ожидания справочного ATR-стопа в контексте модалки. Меньше секунды
// человек не замечает; больше — форма кажется зависшей.
const STOP_HINT_TIMEOUT_MS = 900;

/** Промис с потолком ожидания. Отвал по времени — обычный reject. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    }),
  ]);
}

/** Начало сегодняшнего дня по локальному времени процесса. */
function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Сделки за сегодня против дневного бюджета. Считает так же, как витрина
 * Screen (закрытые + открытые сейчас), чтобы цифра в UI и цифра в отказе
 * никогда не разошлись — иначе форма говорит «3 / 5», а сервер отбивает.
 */
function tradesTodayStatus(now = Date.now()) {
  const cap = config.trading.screenTradesPerDay;
  try {
    const closed = getHistorySince(startOfDay(now)).filter((r) => r.mode === "PRODUCTION").length;
    const open = getActiveAdoptPositions().length + (getActivePosition() ? 1 : 0);
    return computeTradesToday({ closed, open, cap });
  } catch (err) {
    // БД недоступна — счётчик не знает. Вход НЕ запираем: неизвестность не повод
    // отобрать возможность торговать, но UI обязан сказать, что рельса не держит.
    logger.debug(`[Guards] trades-today failed: ${err.message}`);
    return { today: 0, cap, over: false, known: false };
  }
}

/**
 * Пауза после закрытия по этой монете. Ловит паттерн, где выход одной сделки и
 * вход следующей стоят в одной секунде.
 *
 * Пауза считается от ЛЮБОГО закрытия, не только убыточного: после плюсовой
 * сделки перезаход такой же горячий, а «разрешено после профита» — это
 * правило, которое учит добирать, пока не отдашь обратно.
 */
function reentryCooldown(coin, now = Date.now()) {
  const minutes = config.trading.reentryCooldownMin;
  const want = String(coin || "").toUpperCase();
  if (!want || !(minutes > 0)) return computeCooldown({ lastCloseAt: null, minutes, now });

  let last = null;
  try {
    for (const r of getHistorySince(now - minutes * 60_000)) {
      if (r.mode !== "PRODUCTION") continue;
      if (String(r.coin || "").toUpperCase() !== want) continue;
      if (!last || r.closed_at > last.closed_at) last = r;
    }
  } catch (err) {
    logger.debug(`[Guards] reentry lookup failed: ${err.message}`);
    return computeCooldown({ lastCloseAt: null, minutes, now });
  }
  return computeCooldown({
    lastCloseAt: last?.closed_at ?? null,
    lastPnl: last?.realized_pnl ?? null,
    minutes,
    now,
  });
}

/** Свежая цена: WS-фид → fallback на кэш price-map. null если нет. */
async function resolvePrice(coin) {
  const c = String(coin || "").toUpperCase();
  if (!c) return null;
  const live = getLivePrice(c);
  if (live && Number.isFinite(live.price) && live.price > 0) return live.price;
  try {
    const map = await getLivePriceMap();
    const p = map?.get?.(c);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* price-map недоступен */
  }
  return null;
}

/** Свободная маржа. 0 при ошибке — форма тогда просто не даст открыть. */
async function safeAvailable() {
  try {
    const bal = await getBalance();
    return Number.isFinite(bal) && bal > 0 ? bal : 0;
  } catch {
    return 0;
  }
}

/**
 * Депо целиком (accountValue), не свободная маржа. Риск на сделку считается от
 * всего счёта: свободная маржа схлопывается по мере набора поз, и процент от неё
 * рос бы тем сильнее, чем больше ты уже нарисковал.
 */
async function safeEquity() {
  try {
    const { equity } = await getAccountSummary();
    return Number.isFinite(equity) && equity > 0 ? equity : null;
  } catch {
    return null;
  }
}

/** Нормализация тела запроса — на входе всегда недоверенные данные. */
function readOpenBody(b) {
  return {
    coin: String(b?.coin || "").toUpperCase().replace(/-PERP$/i, "").replace(/^@/, ""),
    side: b?.side === "long" ? "long" : b?.side === "short" ? "short" : null,
    marginUsd: Number(b?.marginUsd),
    leverage: Math.round(Number(b?.leverage)),
    orderType: b?.orderType === "limit" ? "limit" : "market",
    limitPx: Number(b?.limitPx),
  };
}

/**
 * GET /api/ticket/context?coin=CHIP
 * Всё, что нужно модалке: цена, свободная маржа, потолок плеча, ATR-стоп
 * няньки, дневной риск и открытые позиции с их стопами.
 */
export async function handleContext(req, res) {
  const coin = String(req.query.coin || "").toUpperCase().replace(/-PERP$/i, "");
  try {
    const [price, available, equity, positions] = await Promise.all([
      coin ? resolvePrice(coin) : Promise.resolve(null),
      safeAvailable(),
      safeEquity(),
      buildPositions(),
    ]);

    // ATR-стоп няньки: показываем ТО ЖЕ число, что она реально применит.
    //
    // Под жёстким таймаутом. По незнакомой монете свечей в кэше нет, запрос
    // идёт живьём и ждёт бюджета веса до 4с — а модалка всё это время не
    // отвечала, и выбор монеты «думал» 3-5 секунд. Стоп тут справочный:
    // нянька посчитает свой после входа, и UI умеет показать «по ATR после
    // входа», когда числа нет. Ждать ради него нельзя.
    let stopDistPct = null;
    let stopBasis = null;
    if (coin && config.trading.adoptEnabled) {
      try {
        ({ distPct: stopDistPct, basis: stopBasis } = await withTimeout(
          computeStopDistPct(coin, HL_PRIORITY.LOW),
          STOP_HINT_TIMEOUT_MS,
        ));
      } catch {
        /* нет ATR или не успел — модалка честно скажет «по ATR после входа».
           Свечи при этом догреются в кэш, и следующий заход покажет число. */
      }
    }

    // Потолок плеча — из биржевых метаданных монеты, не из константы.
    // resolveAsset отдаёт только szDecimals, поэтому universe читаем напрямую.
    let maxLeverage = WALLET_LEVERAGE_CAP;
    let exchangeMaxLeverage = null;
    let coinKnown = null;
    if (coin) {
      const lev = maxLeverageFor(coin);
      coinKnown = lev !== null;
      if (lev) {
        maxLeverage = lev.effective;
        exchangeMaxLeverage = lev.exchangeMax;
      }
    }

    const day = getLastDailyRiskStatus();
    const budget = tradesTodayStatus();
    const cooldown = coin ? reentryCooldown(coin) : null;
    res.json({
      coin,
      coinKnown,
      // Список тикеров для автодополнения. Отдаём целиком (~230 строк, ~2КБ) —
      // дешевле, чем ручка-поиск на каждое нажатие клавиши.
      coins: getUniverse()
        .map((a) => a?.name)
        .filter(Boolean)
        .sort(),
      price,
      available,
      maxLeverage,              // эффективный: min(биржевой, наш потолок)
      exchangeMaxLeverage,      // биржевой — чтобы UI сказал, чей лимит связывает
      walletLeverageCap: WALLET_LEVERAGE_CAP,
      maxNotionalUsd: MAX_NOTIONAL_USD,
      minOrderUsd: MIN_ORDER_USD,
      stopDistPct,
      stopBasis,
      equity,                                  // депо целиком — база для риска
      riskPct: config.trading.adoptRiskPct,    // порог риска на сделку
      adoptEnabled: config.trading.adoptEnabled,
      hasPosition: positions.some((p) => p.coin === coin),
      positions,
      day: {
        // known=false — статус ещё не считался (бот только поднялся) либо
        // refreshDailyRisk падает. Тогда halted=false НЕ означает «лимит цел»,
        // означает «не знаем». Молча пускать вход под видом «всё в порядке»
        // нельзя — UI обязан сказать, что рельса сейчас не держит.
        known: !!day,
        netUsd: day?.netUsd ?? null,
        limitUsd: day?.limitUsd ?? config.trading.dailyLossLimitUsd,
        halted: !!day?.halted,
        // Бюджет сделок и пауза перезахода — те же гейты, что отобьют вход.
        tradesToday: budget.today,
        tradesCap: budget.cap,
        tradesOver: budget.over,
      },
      cooldown,
      generatedAt: Date.now(),
    });
  } catch (err) {
    logger.warn(`[TradeTicket] context failed: ${err.message}`);
    res.status(500).json({ error: true });
  }
}

/**
 * Открытые позы + их стопы. Стоп берём из живых trigger-ордеров на бирже, а НЕ
 * из нашей БД: 🚨 истина о том, защищена ли поза, живёт на бирже — в БД стопы
 * могут быть, когда на бирже их уже нет.
 */
async function buildPositions() {
  let raw = [];
  try {
    raw = await fetchExchangePositions();
  } catch {
    return [];
  }
  let triggers = [];
  try {
    triggers = await getFrontendOpenOrders();
  } catch {
    /* без стопов — покажем «никто не ведёт», это честнее чем промолчать */
  }
  return raw.map((p) => {
    const side = p.szi < 0 ? "short" : "long";
    // Предикат 1:1 с проверенным setupScannerAlerts: обязателен isTrigger,
    // иначе под «стоп» может попасть обычный reduce-only лимитник.
    const stop = triggers.find(
      (o) =>
        String(o.coin).toUpperCase() === String(p.coin).toUpperCase() &&
        o.isTrigger &&
        o.reduceOnly &&
        /stop/i.test(o.orderType || ""),
    );
    return {
      coin: p.coin,
      side,
      sz: Math.abs(p.szi),
      sizeUsd: Math.abs(p.positionValue),
      entryPrice: p.entryPx,
      markPrice: Math.abs(p.szi) > 0 ? Math.abs(p.positionValue) / Math.abs(p.szi) : p.entryPx,
      unrealized: p.unrealizedPnl,
      liquidationPx: p.liquidationPx,
      stopPrice: stop ? Number(stop.triggerPx) : null,
    };
  });
}

/** POST /api/ticket/open */
export async function handleOpen(req, res) {
  if (!config.isProduction) {
    return res.status(409).json({ error: "the bot is in PAPER mode — real orders are disabled" });
  }
  const b = readOpenBody(req.body);

  // ── Проверки. Дублируют клиентские намеренно: это живые деньги. ──
  if (!b.coin) return res.status(400).json({ error: "coin required" });
  if (!b.side) return res.status(400).json({ error: "side must be long|short" });
  if (!(b.marginUsd > 0)) return res.status(400).json({ error: "marginUsd must be > 0" });

  // Плечо проверяем ПРОТИВ ЛИМИТА КОНКРЕТНОЙ МОНЕТЫ, а не против общей константы.
  // Раньше тут стояло «1..10», и на CASHCAT (биржевой максимум 3x) проходила
  // десятка: биржа такой ордер отбивает, а если бы приняла — ликвидация пришла
  // бы раньше стопа няньки. Найдено.
  const lev = maxLeverageFor(b.coin);
  if (!lev) return res.status(422).json({ error: `the exchange does not know the ticker ${b.coin}` });
  if (!Number.isInteger(b.leverage) || b.leverage < 1) {
    return res.status(400).json({ error: "leverage must be a positive integer" });
  }
  if (b.leverage > lev.effective) {
    const who =
      lev.exchangeMax <= WALLET_LEVERAGE_CAP
        ? `the exchange maximum for ${b.coin} is ${lev.exchangeMax}x`
        : `our cap is ${WALLET_LEVERAGE_CAP}x (the exchange allows ${lev.exchangeMax}x)`;
    return res.status(422).json({ error: `leverage ${b.leverage}x is not allowed: ${who}` });
  }

  const notional = b.marginUsd * b.leverage;
  if (notional < MIN_ORDER_USD) {
    return res.status(422).json({ error: `the exchange minimum order is $${MIN_ORDER_USD}` });
  }
  if (notional > MAX_NOTIONAL_USD) {
    return res.status(422).json({ error: `notional $${notional.toFixed(2)} exceeds the cap of $${MAX_NOTIONAL_USD}` });
  }

  // Дневной стоп запирает ВХОД. Выход не запирает никогда (см. handleClose).
  const day = getLastDailyRiskStatus();
  if (day?.halted) {
    return res.status(423).json({ error: "the daily stop fired — entries are closed until midnight" });
  }

  // Дневной бюджет сделок. Раньше был надписью и пропустил 17 сделок за сутки.
  const budget = tradesTodayStatus();
  if (budget.over) {
    return res.status(423).json({
      error: `daily trade budget spent: ${budget.today} of ${budget.cap} — entries are closed until midnight`,
    });
  }

  // Пауза после закрытия по этой монете. Ловит перезаход через секунду после
  // стопа — на 31.08 такие входы дали −$6.37 при итоге дня −$4.38.
  const cool = reentryCooldown(b.coin);
  if (cool.blocked) {
    const mins = Math.ceil(cool.secondsLeft / 60);
    const outcome = cool.lastPnl == null ? "" : cool.lastPnl < 0
      ? ` The last one closed at −$${Math.abs(cool.lastPnl).toFixed(2)}.`
      : ` The last one closed at +$${cool.lastPnl.toFixed(2)}.`;
    return res.status(423).json({
      error:
        `${b.coin} just closed — ${cool.minutes}-minute cooldown, ${mins} min left.` +
        `${outcome} Pick another coin or wait.`,
    });
  }

  const available = await safeAvailable();
  if (b.marginUsd > available + 1e-9) {
    return res.status(422).json({ error: `margin $${b.marginUsd.toFixed(2)} exceeds the free $${available.toFixed(2)}` });
  }

  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(b.coin));
  } catch (err) {
    return res.status(422).json({ error: `the exchange does not know the ticker ${b.coin}` });
  }

  const price = await resolvePrice(b.coin);
  if (price == null) return res.status(422).json({ error: `no live price for ${b.coin}` });

  const entryPx = b.orderType === "limit" ? b.limitPx : price;
  if (b.orderType === "limit") {
    if (!(b.limitPx > 0)) return res.status(400).json({ error: "limitPx required for limit order" });
    // Post-only, пересекающая рынок, будет отклонена биржей — ловим раньше,
    // чтобы оператор не решил, что ордер поставился.
    const wouldCross = b.side === "short" ? b.limitPx < price : b.limitPx > price;
    if (wouldCross) {
      return res.status(422).json({ error: "post-only would cross the market — move the price or use Market" });
    }
  }

  // Размер в монетах округляем до szDecimals. У монет с szDecimals=0
  // (CHIP, CASHCAT, DOGE) шаг равен ЦЕЛОЙ монете, и округление вниз легко
  // уводит нотионал под биржевой минимум: $10.02 по CHIP → 360 шт → $9.99,
  // биржа такой ордер отбивает. Поэтому если после округления вниз не хватает
  // до минимума — добираем один шаг вверх, но только если хватает маржи.
  const step = Math.pow(10, szDecimals);
  let sz = Math.floor((notional / entryPx) * step) / step;
  if (sz > 0 && sz * entryPx < MIN_ORDER_USD) {
    const bumped = Math.ceil((MIN_ORDER_USD / entryPx) * step) / step;
    const bumpedMargin = (bumped * entryPx) / b.leverage;
    if (bumpedMargin > available + 1e-9) {
      return res.status(422).json({
        error:
          `размер округляется до $${(sz * entryPx).toFixed(2)} — ниже минимума $${MIN_ORDER_USD}. ` +
          `Для ${b.coin} на ${b.leverage}x нужна маржа от $${bumpedMargin.toFixed(2)}, свободно $${available.toFixed(2)}`,
      });
    }
    sz = bumped;
  }
  if (!(sz > 0)) {
    return res.status(422).json({ error: `size rounded to zero (szDecimals=${szDecimals})` });
  }

  try {
    await setLeverage(b.coin, b.leverage);
  } catch (err) {
    logger.warn(`[TradeTicket] setLeverage(${b.coin}, ${b.leverage}) failed: ${err.message}`);
    return res.status(502).json({ error: `could not set leverage: ${err.message}` });
  }

  const isBuy = b.side === "long";
  try {
    if (b.orderType === "limit") {
      const px = formatHlPrice(b.limitPx, szDecimals);
      const result = await retryWithBackoff(
        () => placeLimit({ coin: b.coin, isBuy, sz, px, tif: "Alo", reduceOnly: false }),
        { label: `ticket-open-limit-${b.coin}`, maxRetries: 2, baseDelayMs: 1000 },
      );
      const status = result?.response?.data?.statuses?.[0];
      if (typeof status === "string") throw new Error(status);
      if (status?.error) throw new Error(status.error);
      const oid = status?.resting?.oid ?? status?.filled?.oid ?? null;
      logger.info(
        `[TradeTicket] 📝 LIMIT ${b.side.toUpperCase()} #${b.coin} sz=${sz} @ ${px} ` +
          `($${notional.toFixed(2)} = ${b.marginUsd.toFixed(2)}×${b.leverage}) oid=${oid}`,
      );
      return res.json({
        ok: true,
        kind: "limit",
        oid,
        message: `${b.side === "short" ? "Short" : "Long"} ${b.coin} · limit ${px} resting · $${notional.toFixed(2)} (${b.marginUsd.toFixed(2)}×${b.leverage}) · bot will attach the stop once it fills`,
      });
    }

    const result = await retryWithBackoff(
      () => openMarket(b.coin, isBuy, sz, MARKET_SLIPPAGE),
      { label: `ticket-open-market-${b.coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
    const fill = parseFillResponse(result, "OPEN");
    if (!fill.ok) throw new Error(fill.error || "exchange rejected");
    logger.info(
      `[TradeTicket] ✅ MARKET ${b.side.toUpperCase()} #${b.coin} filled ${fill.totalSz} @ $${fill.avgPx} ` +
        `($${(fill.totalSz * fill.avgPx).toFixed(2)}) oid=${fill.oid}`,
    );
    return res.json({
      ok: true,
      kind: "market",
      oid: fill.oid,
      fillPx: fill.avgPx,
      sz: fill.totalSz,
      message: `${b.side === "short" ? "Short" : "Long"} ${b.coin} filled ${fill.totalSz} @ ${fill.avgPx} · $${(fill.totalSz * fill.avgPx).toFixed(2)} · bot attaches the stop in ~15s`,
    });
  } catch (err) {
    logger.error(`[TradeTicket] open #${b.coin} failed: ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
}

/**
 * POST /api/ticket/close
 * Намеренно почти не гейтится: дневной стоп на выход НЕ распространяется и
 * PAPER-проверка тут тоже уместна только как «нет реальных поз».
 */
export async function handleClose(req, res) {
  if (!config.isProduction) {
    return res.status(409).json({ error: "the bot is in PAPER mode — there are no real positions" });
  }
  const coin = String(req.body?.coin || "").toUpperCase().replace(/-PERP$/i, "");
  const pct = Number(req.body?.pct);
  const orderType = req.body?.orderType === "limit" ? "limit" : "market";
  const limitPx = Number(req.body?.limitPx);

  if (!coin) return res.status(400).json({ error: "coin required" });
  if (!(pct > 0) || pct > 100) return res.status(400).json({ error: "pct must be 1..100" });

  // Истина о позиции — с биржи, не из БД.
  let positions;
  try {
    positions = await getPositions();
  } catch (err) {
    return res.status(502).json({ error: `could not read positions: ${err.message}` });
  }
  const ap = (positions || []).find(
    (x) => String(x?.position?.coin || "").toUpperCase() === coin,
  );
  const szi = parseFloat(ap?.position?.szi ?? "0");
  if (!szi) return res.status(404).json({ error: `no open position in ${coin}` });

  const side = szi < 0 ? "short" : "long";
  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(coin));
  } catch (err) {
    return res.status(422).json({ error: `the exchange does not know the ticker ${coin}` });
  }

  const step = Math.pow(10, szDecimals);
  let sz = Math.floor((Math.abs(szi) * pct) / 100 * step) / step;
  // Просят 100% — закрываем ровно то, что есть, без потерь на округлении вниз.
  if (pct === 100) sz = Math.abs(szi);
  if (!(sz > 0)) return res.status(422).json({ error: "the close size rounded to zero" });

  try {
    if (orderType === "limit") {
      if (!(limitPx > 0)) return res.status(400).json({ error: "limitPx required for limit order" });
      const price = await resolvePrice(coin);
      const isBuy = side === "short"; // закрытие шорта = BUY
      if (price != null) {
        const wouldCross = isBuy ? limitPx > price : limitPx < price;
        if (wouldCross) {
          return res.status(422).json({ error: "post-only would cross the market — move the price or use Market" });
        }
      }
      const px = formatHlPrice(limitPx, szDecimals);
      const result = await retryWithBackoff(
        () => placeLimit({ coin, isBuy, sz, px, tif: "Alo", reduceOnly: true }),
        { label: `ticket-close-limit-${coin}`, maxRetries: 2, baseDelayMs: 1000 },
      );
      const status = result?.response?.data?.statuses?.[0];
      if (typeof status === "string") throw new Error(status);
      if (status?.error) throw new Error(status.error);
      const oid = status?.resting?.oid ?? status?.filled?.oid ?? null;
      logger.info(`[TradeTicket] 📝 CLOSE-LIMIT #${coin} ${pct}% sz=${sz} @ ${px} oid=${oid}`);
      return res.json({
        ok: true,
        kind: "limit",
        oid,
        message: `${coin}: reduce-only limit for ${pct}% resting @ ${px}`,
      });
    }

    const result = await retryWithBackoff(
      () => closeMarket(coin, sz, MARKET_SLIPPAGE),
      { label: `ticket-close-market-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
    const fill = parseFillResponse(result, "CLOSE");
    if (!fill.ok) throw new Error(fill.error || "exchange rejected");
    logger.info(`[TradeTicket] ✅ CLOSE #${coin} ${pct}% filled ${fill.totalSz} @ $${fill.avgPx}`);
    return res.json({
      ok: true,
      kind: "market",
      fillPx: fill.avgPx,
      sz: fill.totalSz,
      message: `${coin}: closed ${pct}% — ${fill.totalSz} @ ${fill.avgPx}`,
    });
  } catch (err) {
    logger.error(`[TradeTicket] close #${coin} failed: ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
}
