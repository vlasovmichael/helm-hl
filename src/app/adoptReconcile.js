// ─────────────────────────────────────────────────
//  Adopt Mode — бот-нянька на ручные входы
// ─────────────────────────────────────────────────
// План: plans/adopt-mode-plan.md
//
// Юзер открывает позицию руками → бот подхватывает её в СВОБОДНЫЙ слот как
// strategy_id='adopt' и СРАЗУ ставит реальный reduce-only стоп на бирже. Бот
// чинит ВЫХОД (главный леак — держал лузеров до нуля, memory
// trading-coaching-payoff-leak), не вход. Безубыток-храповик и трейл —
// следующий шаг (переиспуск Hunter-логики). Сейчас: жёсткий стоп при подхвате.
//
// Гарды: слот свободен, ADOPT_ENABLED, возраст позы ≤ ADOPT_MAX_AGE_MIN, не в
// Hunter-cooldown. Стоп reduce-only — может только ЗАКРЫТЬ позу, не нарастить/
// не развернуть, поэтому безопасен при любом размере.
// Ставим стоп ДО записи в БД: если постановка не удалась — НЕ усыновляем
// (остаёшься в обычном hands-off, без ложного «бот ведёт»).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { savePosition, updatePositionEntryTime } from '../core/database.js';
import { getAccountSummary, getLivePrice } from '../modules/exchange.js';
import {
  placeHunterTrigger,
  placeHunterLongTrigger,
} from '../modules/executor/hunterOpen.js';
import { resolveAsset } from '../modules/executor/fill-parser.js';
import { fetchUserFills } from '../modules/userFills.js';
import { isQuietHour } from '../modules/setupScannerAlerts.js';
import { getLastDailyRiskStatus, localDayKey } from '../modules/dailyRisk.js';
import { atr } from '../modules/trendFollowAtr.js';
import { getHourlyCandles } from '../modules/candleCache.js';

const ATR_PERIOD = 14;            // стандартный период ATR
const ATR_LOOKBACK_HOURS = 48;    // с запасом ≥ ATR_PERIOD+1 свечей

// Последнее решение adopt по монете — чтобы причина «не усыновил» была видна на
// дашборде, а не только в логах на сервере (оператору надоело лазить в SSH каждый
// раз, когда вход не подхватился — 2026-06-16). coin → краткая причина-строка.
// Усыновлённая монета причину чистит (её ведёт adopt, вопрос снят).
const _adoptSkipReason = new Map();
export function getAdoptSkipReason(coin) {
  return _adoptSkipReason.get(coin) || null;
}

const up = (c) => String(c).toUpperCase();

// ── First-seen трекинг ручных поз ──────────────────────────────────────────
// КОРЕНЬ глюка «без стопа: возраст входа неизвестен» (повторялся 5 раз): возраст
// входа берётся ТОЛЬКО из HL-fills (fetchUserFills), а userFillsByTime отдаёт твой
// open-fill с лагом ~30с после входа (+30с кэш). В это окно openTime=null → нянька
// консервативно НЕ усыновляла (защита от старых orphan'ов — XPL) → ~30с поза без
// стопа + красный бейдж, потом fill долетал → ADOPTED. null сваливал в кучу два
// разных случая: «свежак, fill не проиндексирован» и «реально старый orphan».
//
// Различаем по тому, ВИДЕЛ ли бот рождение позы: появилась absent→present при
// живом боте → заведомо свежая → усыновляем сразу (entry≈first-seen). Висела уже
// на старте (рождение не видели) → возможен старый orphan → остаёмся осторожны.
const _firstSeen = new Map();   // coinUpper → { ts, atStartup }
let _bootObserved = false;       // наблюдён ли хоть один цикл (для atStartup-метки)

// Чистая (для теста): обновляет first-seen карту по текущему набору монет.
// Первый цикл (bootObserved=false) метит все наличные позы atStartup=true. Новые
// монеты последующих циклов → atStartup=false (рождение увидели). Возвращает
// новое значение bootObserved.
export function updateFirstSeen(map, presentCoins, now, bootObserved) {
  const present = new Set(presentCoins.map(up));
  for (const c of present) {
    if (!map.has(c)) map.set(c, { ts: now, atStartup: !bootObserved });
  }
  for (const c of [...map.keys()]) if (!present.has(c)) map.delete(c);
  return true;
}

// Чистое (для теста) решение по возрасту входа для adopt.
//  openTime  — реальное время входа из fills (unix ms) | null (не проиндексирован)
//  firstSeen — { ts, atStartup } | null — когда бот ВПЕРВЫЕ увидел позу
//  → { decision: 'adopt'|'too-old'|'unknown-age', entryTime, ageMin, provisional }
export function decideAdoptByAge({ openTime, firstSeen, now, maxAgeMs }) {
  // 1. fills знают точное время входа → авторитетно.
  if (openTime != null) {
    const ageMin = (now - openTime) / 60_000;
    const decision = now - openTime > maxAgeMs ? 'too-old' : 'adopt';
    return { decision, entryTime: openTime, ageMin, provisional: false };
  }
  // 2. fill ещё не проиндексирован, но позу бот увидел РОДившейся при себе →
  //    заведомо свежая → усыновляем сразу, entry≈first-seen (уточним бэкфиллом).
  if (firstSeen && !firstSeen.atStartup) {
    const ageMin = (now - firstSeen.ts) / 60_000;
    // first-seen старше max-age, а fill так и не пришёл → дальше не рискуем.
    const decision = now - firstSeen.ts > maxAgeMs ? 'too-old' : 'adopt';
    return { decision, entryTime: firstSeen.ts, ageMin, provisional: decision === 'adopt' };
  }
  // 3. Поза висела уже на старте (рождение не видели) или first-seen неизвестен →
  //    возможен старый orphan → консервативно НЕ трогаем (защита XPL).
  return { decision: 'unknown-age', entryTime: null, ageMin: null, provisional: false };
}

// Усыновлённые с провизорным entry_time (fill ещё не был проиндексирован на момент
// adopt). coinUpper → { id, since }. Бэкфиллим реальное время, когда fill долетит.
const _provisionalAdopt = new Map();
const BACKFILL_GIVEUP_MS = 15 * 60_000; // fill не пришёл за 15м → бросаем уточнение

// Сирота-алерт: поза уже ГЛУБЖЕ планового стопа на момент усыновления. Ставить
// стоп нельзя — reduce-only триггер уже in-the-money → мгновенный market-close
// (так родились худшие хвосты: JTO −6.06%, CHIP −7.65%, DYDX −8.07% при hold=0м,
// 6 сделок из 23 стопов). Вместо этого: НЕ усыновляем + громкий пуш — «резать или
// держать» решает оператор в моменте, а не рынок через 0 минут. Пока условие висит —
// повторяем алерт не чаще раза в 30м (orphanCheck крутится каждый тик).
const _orphanAlertAt = new Map(); // coinUpper → ts последнего алерта
const ORPHAN_REALERT_MS = 30 * 60_000;

// Чистая (для теста): цена уже на/за плановым стопом? short: стоп ВЫШЕ входа,
// пробитие = price ≥ SL; long: стоп НИЖЕ, пробитие = price ≤ SL.
export function isBeyondPlannedStop({ side, price, plannedSl }) {
  if (!Number.isFinite(price) || !Number.isFinite(plannedSl)) return false;
  return side === 'short' ? price >= plannedSl : price <= plannedSl;
}

/**
 * Дистанция жёсткого стопа в % от входа.
 * ATR-режим: ATR(1h, 14) × MULT / цена, зажат в [MIN_PCT, MAX_PCT] — подстраивает
 * стоп под волатильность монеты (фейдеру нужен воздух). Фолбэк на фикс-% если
 * режим 'pct' или свечей/ATR нет.
 * @returns {Promise<{ distPct:number, basis:'atr'|'pct' }>}
 */
export async function computeStopDistPct(coin) {
  const t = config.trading;
  if (t.adoptStopMode === 'atr') {
    try {
      const candles = await getHourlyCandles(coin, ATR_LOOKBACK_HOURS);
      if (Array.isArray(candles) && candles.length >= ATR_PERIOD + 1) {
        const a = atr(candles, ATR_PERIOD);
        const lastClose = candles[candles.length - 1]?.close;
        if (Number.isFinite(a) && a > 0 && Number.isFinite(lastClose) && lastClose > 0) {
          const rawPct = (a * t.adoptAtrMult / lastClose) * 100;
          const pct = Math.min(t.adoptStopMaxPct, Math.max(t.adoptStopMinPct, rawPct));
          return { distPct: pct, basis: 'atr' };
        }
      }
      logger.info(`[Adopt] ATR недоступен для #${coin} — фолбэк на фикс ${t.adoptStopPct}%`);
    } catch (err) {
      logger.debug(`[Adopt] ATR calc failed #${coin}: ${err.message} — фолбэк на фикс-%`);
    }
  }
  return { distPct: t.adoptStopPct, basis: 'pct' };
}

/**
 * Время открытия ТЕКУЩЕЙ непрерывной позиции по монете из сырых HL fills.
 *
 * Берём правду с биржи без реконструкции ручной истории: позиция на бирже =
 * знаковая сумма fills (и бот, и ручных). Идём по fills во времени, держим
 * net-размер; открытие текущей позы = момент, когда |net| ушёл от нуля (или
 * сменил знак). Бот-закрытие усыновлённой позы (Close-fill) при этом естественно
 * обнуляет net → фантомные «висящие» ноги, которые копила фильтрация бот-fills по
 * oid, физически невозможны (XPL incident 2026-06-17: adopt считал свежую позу
 * возрастом 6888мин и отказывал по too-old → поза без стопа → −$7.36).
 *
 * 🐛 ОКНО FILLS (2026-07-01): fetchUserFills отдаёт ~60д, и если позиция
 * ПЕРЕСЕКАЛА границу окна (открылась раньше, закрылась внутри), replay стартует с
 * ложного net=0 → постоянное смещение, которое НИКОГДА не обнуляется. HYPE:
 * первый fill в окне = Close Short → net поехал в +1.17, и каждый реальный выход
 * во флэт читался как «лонг 1.17 открыт» → ложное «too old» (175м), поза без
 * стопа. Фикс: якорим к ИСТИНЕ С БИРЖИ (`currentNet` = знаковый размер позиции
 * сейчас). offset = replayEndNet − currentNet — это net, занесённый из-за окна;
 * вычитаем его из всей траектории. Тогда флэт=0 определяется верно. currentNet
 * null (не передан) → offset 0 = прежнее поведение.
 *
 * @param {object}  args
 * @param {string}  args.coin
 * @param {Array}   args.fills — сырые HL fills (как из fetchUserFills), любой порядок.
 * @param {number|null} [args.currentNet] — знаковый размер позиции с биржи
 *   (>0 long, <0 short, 0 = флэт); null = не якорить (legacy).
 * @returns {number|null} unix ms открытия текущей позы, либо null если по монете
 *   нет открытой позы / открытие вне окна fills.
 */
export function resolveManualOpenTime({ coin, fills, currentNet = null }) {
  const C = String(coin).toUpperCase();
  const list = (fills || [])
    .filter((f) => f.coin?.toUpperCase() === C && typeof f.dir === 'string')
    .sort((a, b) => a.time - b.time);

  // 1-й проход: replay + максимальный размер fill (база для относительного EPS).
  let net = 0;
  let maxSz = 0;
  const traj = [];
  for (const f of list) {
    const sz = Math.abs(Number(f.sz) || 0);
    if (sz > maxSz) maxSz = sz;
    const isOpen = f.dir.startsWith('Open ');
    const isLong = f.dir.includes('Long');
    // long-открытие / short-закрытие → +sz; short-открытие / long-закрытие → −sz
    net += isOpen === isLong ? sz : -sz;
    traj.push({ time: f.time, net });
  }

  // Смещение из-за окна: чтобы траектория закончилась на истине с биржи.
  const offset = currentNet != null ? net - currentNet : 0;
  // Относительный EPS: жёсткий 1e-9 ложно «видел» позу из float-крошки на монетах
  // с большими размерами (мем-коины в млн единиц). 0.01% от крупнейшего fill.
  const EPS = Math.max(1e-9, 1e-4 * (maxSz || 1));

  let openTime = null;
  let cnetPrev = -offset; // истинный net ДО первого fill = −offset (занос из-за окна)
  for (const p of traj) {
    const cnet = p.net - offset;
    if (Math.abs(cnet) < EPS) {
      openTime = null;                                    // поза схлопнулась (флэт)
    } else if (Math.abs(cnetPrev) < EPS || (cnetPrev > 0) !== (cnet > 0)) {
      openTime = p.time;                                  // 0→поза или разворот знака
    }
    cnetPrev = cnet;
  }
  return openTime;
}

/**
 * Время открытия текущей ОТКРЫТОЙ ручной позиции по монете (unix ms) или null.
 * Источник — сырые HL fills (правда с биржи), см. resolveManualOpenTime. null →
 * не смогли определить (поза старше окна fills) → из осторожности НЕ подхватываем.
 * `currentNet` — знаковый размер позиции с биржи: якорит replay, чтобы окно fills
 * не ломало определение возраста (см. баг с усечением окна в resolveManualOpenTime).
 */
async function getManualOpenTime(coin, currentNet = null) {
  let fills;
  try {
    fills = await fetchUserFills(0); // 60d
  } catch (err) {
    logger.debug(`[Adopt] fetchUserFills failed: ${err.message}`);
    return null;
  }
  return resolveManualOpenTime({ coin, fills, currentNet });
}

/**
 * ntfy-пуш (best-effort). Тихий час 00–08 → priority=1 (без звука).
 * urgent=true — риск-алерт (memory feedback_quiet_tg: риск-алерты всегда со
 * звуком): priority=5, тихий час НЕ глушит. Экспорт: переиспользуется пик-алертом
 * в adoptSupervise.
 */
export async function fireAdoptNtfy(title, message, tags, { urgent = false } = {}) {
  const { url, token, priority: basePriority } = config.ntfy;
  const topic = process.env.NTFY_TOPIC_ADOPT || config.ntfy.topic;
  if (!url || !topic) return;
  try {
    const { default: https } = await import('node:https');
    const { default: http } = await import('node:http');
    const priority = urgent ? 5 : (isQuietHour() ? 1 : (basePriority ?? 3));
    const body = JSON.stringify({ topic, title, message, priority, tags });
    const u = new URL(`${url}/`);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await new Promise((resolve, reject) => {
      const req = lib.request(
        { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: '/', method: 'POST', headers },
        (res) => { res.resume(); res.on('end', resolve); },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    logger.warn(`[Adopt] ntfy failed: ${err.message}`);
  }
}

/**
 * Подхватывает ВСЕ свежие ручные позы (multi-slot) и ставит на каждую реальный
 * reduce-only стоп. Возвращает массив coin'ов усыновлённых поз (может быть пуст).
 *
 * manualPositions УЖЕ очищен от монет, которыми бот владеет (слот + ранее
 * усыновлённые adopt-позы), поэтому повторного подхвата той же монеты не будет.
 * Вызывается из orphanCheck при ADOPT_ENABLED, когда слот не держит бот-стратегия.
 *
 * @param {Array<{coin, szi, entryPx}>} manualPositions
 * @returns {Promise<string[]>} coin'ы усыновлённых поз
 */
export async function maybeAdoptManualPosition(manualPositions) {
  if (!config.trading.adoptEnabled) return [];
  if (!config.isProduction) return [];
  const list = Array.isArray(manualPositions) ? manualPositions : [];

  const now = Date.now();
  // First-seen учёт ДО early-return на пустом списке: иначе ушедшие монеты копились
  // бы в карте, а первый цикл с 0 поз не пометил бы boot (atStartup съехал бы).
  _bootObserved = updateFirstSeen(_firstSeen, list.map((p) => p.coin), now, _bootObserved);
  if (list.length === 0) return [];

  const maxAgeMs = config.trading.adoptMaxAgeMin * 60_000;
  const adopted = [];

  for (const ex of list) {
    const coin    = ex.coin;
    const side    = ex.szi < 0 ? 'short' : 'long';
    const entry   = ex.entryPx;
    const sz      = Math.abs(ex.szi);
    const sizeUsd = sz * entry;

    // ВНИМАНИЕ: Hunter cross-cooldown здесь НЕ применяется. Он защищает авто-входы
    // бота от «ловли ножа» после собственного close, но для adopt смысл обратный —
    // оператор уже вошёл руками сам, няньке остаётся лишь повесить защитный стоп. Раньше
    // гард оставлял такие позы вообще без стопа (cooldown 60м + max-age 10м = монета,
    // которую бот только что торговал, не усыновлялась никогда). Убрано 2026-06-16.

    // Гард: возраст. fills знают точное время входа → авторитетно. fills ещё нет
    // (лаг индексатора ~30с), но позу бот увидел РОДившейся при себе → свежак,
    // усыновляем сразу (entry≈first-seen, уточним бэкфиллом). Поза висела на старте
    // и fills молчат → возможен старый orphan → не трогаем (защита XPL).
    // ex.szi — знаковый размер позиции с биржи (истина): якорит replay fills,
    // чтобы усечение 60д-окна не давало ложный возраст (баг HYPE 2026-07-01).
    const openTime = await getManualOpenTime(coin, ex.szi);
    const firstSeen = _firstSeen.get(up(coin)) || null;
    const { decision, entryTime, ageMin, provisional } = decideAdoptByAge({
      openTime, firstSeen, now, maxAgeMs,
    });
    if (decision === 'unknown-age') {
      logger.info(`[Adopt] skip #${coin} — open time undetermined (старый orphan со старта, fills молчат)`);
      _adoptSkipReason.set(coin, 'возраст входа неизвестен');
      continue;
    }
    if (decision === 'too-old') {
      logger.info(`[Adopt] skip #${coin} — too old (${ageMin.toFixed(1)}min > ${config.trading.adoptMaxAgeMin}min)`);
      _adoptSkipReason.set(coin, `слишком старая (${ageMin.toFixed(0)}м > ${config.trading.adoptMaxAgeMin}м)`);
      continue;
    }
    if (provisional) {
      logger.info(`[Adopt] #${coin} — fill ещё не проиндексирован, усыновляю сразу как свежий (увидел рождение, age≈${ageMin.toFixed(1)}min); entry_time уточню бэкфиллом`);
    }

    // ── Жёсткий стоп (reduce-only) ──────────────
    // Дистанция: ATR(1h)×MULT (подстройка под волатильность) либо фикс-% фолбэк.
    const { distPct, basis } = await computeStopDistPct(coin);
    const plannedSl = side === 'short'
      ? entry * (1 + distPct / 100)
      : entry * (1 - distPct / 100);

    // ── Сирота-гард: цена УЖЕ за плановым стопом ────
    // Стоп ставить нельзя (триггер in-the-money → мгновенный market-close на
    // −6..−8%). Не усыновляем + громкий пуш: решение «резать/держать» — оператору.
    let livePrice = null;
    try {
      livePrice = await getLivePrice(coin);
    } catch (err) {
      logger.debug(`[Adopt] orphan-guard getLivePrice #${coin} failed: ${err.message}`);
    }
    if (isBeyondPlannedStop({ side, price: livePrice, plannedSl })) {
      const lossPct = (side === 'short'
        ? (livePrice - entry) / entry
        : (entry - livePrice) / entry) * 100;
      logger.warn(
        `[Adopt] 🚨 ОРФАН ГЛУБЖЕ СТОПА #${coin} ${side}: цена $${livePrice.toPrecision(6)} уже за ` +
          `плановым SL $${plannedSl.toPrecision(6)} (−${lossPct.toFixed(2)}% при стопе ${distPct.toFixed(2)}%). ` +
          `НЕ усыновляю — стоп сработал бы мгновенно. Решение за оператором.`,
      );
      _adoptSkipReason.set(coin, `уже глубже стопа (−${lossPct.toFixed(1)}%) — реши сам`);
      const lastAlert = _orphanAlertAt.get(up(coin)) || 0;
      if (now - lastAlert >= ORPHAN_REALERT_MS) {
        _orphanAlertAt.set(up(coin), now);
        await fireAdoptNtfy(
          `🚨 #${coin} ${side.toUpperCase()} уже глубже стопа`,
          `Поза $${sizeUsd.toFixed(0)} в −${lossPct.toFixed(2)}% — глубже плановой стоп-дистанции ` +
          `${distPct.toFixed(2)}%.\nБот НЕ ставит стоп (закрылась бы мгновенно по рынку).\n` +
          `Реши сам: резать или держать. Поза БЕЗ защиты.`,
          ['rotating_light'],
          { urgent: true },
        );
      }
      continue;
    }
    _orphanAlertAt.delete(up(coin)); // цена вернулась в норму → сможем алертить заново

    let szDecimals;
    try {
      ({ szDecimals } = resolveAsset(coin));
    } catch (err) {
      logger.warn(`[Adopt] skip #${coin} — resolveAsset failed: ${err.message}`);
      _adoptSkipReason.set(coin, 'не распознал тикер');
      continue;
    }

    // Ставим стоп ДО записи в БД: нет стопа → нет подхвата (без ложного «ведём»).
    let slOid;
    try {
      slOid = side === 'short'
        ? await placeHunterTrigger(coin, sz, plannedSl, 'sl', szDecimals)
        : await placeHunterLongTrigger(coin, sz, plannedSl, 'sl', szDecimals);
    } catch (err) {
      logger.error(
        `[Adopt] ❌ SL placement failed for #${coin} ${side} @ $${plannedSl.toPrecision(6)}: ${err.message}. ` +
        `NOT adopting — позиция остаётся в обычном hands-off.`,
      );
      _adoptSkipReason.set(coin, 'стоп не встал на бирже');
      continue;
    }

    // entry_equity для корректной оценки pnl при закрытии (integrityCheck Δequity).
    let entryEquity = null;
    try {
      const summary = await getAccountSummary();
      if (Number.isFinite(summary.equity) && summary.equity > 0) entryEquity = summary.equity;
    } catch {
      // best-effort — integrityCheck деградирует на fills-pnl
    }

    let id;
    try {
      id = savePosition({
        coin,
        size_usd:      sizeUsd,
        entry_price:   entry,
        entry_apy:     0,            // adopt не carry — APY неприменим
        entry_time:    entryTime,    // время входа из fills, либо провизорное first-seen
        mode:          'PRODUCTION',
        strategy_id:   'adopt',
        side,
        entry_equity:  entryEquity,
        sl_price:      plannedSl,
        hunter_sl_oid: slOid,        // → classifyClose пометит 'sl_trigger' при срабатывании
      });
    } catch (err) {
      // БД-запись не удалась, но стоп УЖЕ на бирже — это безопасно (поза защищена),
      // просто бот не «владеет» ею в БД. Логируем громко и ПРЕРЫВАЕМ проход: иначе
      // следующий тик увидит эту монету как «ручную» (нет DB-row) и попробует
      // усыновить снова → второй стоп. Уже усыновлённые в этом проходе — возвращаем.
      logger.error(`[Adopt] savePosition #${coin} failed ПОСЛЕ постановки стопа (oid=${slOid}): ${err.message}`);
      break;
    }

    // Усыновлено по провизорному (first-seen) времени — fill ещё не был
    // проиндексирован. Запоминаем, чтобы бэкфиллить реальный entry_time, когда
    // fill долетит (точная классификация 'adopted' в ленте/леджере).
    if (provisional) _provisionalAdopt.set(up(coin), { id, since: now });

    const distLabel = `−${distPct.toFixed(2)}% ${basis === 'atr' ? 'ATR' : 'фикс'}`;
    logger.info(
      `[Adopt] 🤝 adopted #${coin} ${side.toUpperCase()} (id=${id}) | ` +
      `entry=$${entry} size=$${sizeUsd.toFixed(2)} age=${ageMin.toFixed(1)}min | ` +
      `SL @ $${plannedSl.toPrecision(6)} (${distLabel}) oid=${slOid}`,
    );

    await fireAdoptNtfy(
      `Adopt #${coin} ${side.toUpperCase()} — стоп выставлен`,
      `Подхватил ручную позу $${sizeUsd.toFixed(0)} @ $${entry}\n` +
      `Стоп на бирже: $${plannedSl.toPrecision(6)} (${distLabel})\n` +
      `Дальше веду сам: храповик + трейл.`,
      ['handshake'],
    );

    // Тильт-алерт: новый ручной вход в день, где дневной стоп-лосс уже пробит.
    // Няньку НЕ отключаем (вход без стопа хуже), но кричим громко: 8 худших
    // дней съели −$130 (аудит 2026-07-02), и все они — серии входов в минусе.
    const dr = getLastDailyRiskStatus();
    if (dr?.halted && dr.dayKey === localDayKey(now)) {
      await fireAdoptNtfy(
        `⚠️ Тильт? Вход при пробитом дневном стопе`,
        `#${coin} ${side.toUpperCase()} усыновлён и защищён, НО день уже ` +
        `${dr.netUsd.toFixed(2)}$ (лимит −$${dr.limitUsd}).\n` +
        `Один тильт-день = две недели работы. Закрой терминал.`,
        ['warning'],
        { urgent: true },
      );
    }

    _adoptSkipReason.delete(coin); // усыновлена — вопрос «почему не adopted» снят
    adopted.push(coin); // multi-slot — продолжаем подхватывать остальные
  }

  return adopted;
}

/**
 * Бэкфилл реального entry_time для поз, усыновлённых по провизорному (first-seen)
 * времени (fill ещё не был проиндексирован на момент adopt). Когда HL наконец
 * отдаёт open-fill — записываем точное время входа, чтобы лента/леджер
 * классифицировали позу как 'adopted' по точному entry-матчу (ENTRY_MATCH_MS=3с),
 * а не как 'manual'. Дёшево: fills уже в 30с-кэше. Вызывается каждый цикл
 * orphanCheck. Если fill не пришёл за BACKFILL_GIVEUP_MS — бросаем (оставляем
 * провизорный entry_time, бот-закрытие всё равно классифицирует 'adopted' по oid).
 */
export async function reconcileProvisionalAdoptEntries() {
  if (_provisionalAdopt.size === 0) return;
  const now = Date.now();
  for (const [coin, info] of [..._provisionalAdopt]) {
    let realOpen = null;
    try {
      realOpen = await getManualOpenTime(coin);
    } catch {
      /* транзиент — попробуем в следующий цикл */
    }
    if (realOpen != null) {
      try {
        updatePositionEntryTime(info.id, realOpen);
        logger.info(`[Adopt] backfill entry_time #${coin} (id=${info.id}) → ${new Date(realOpen).toISOString()} (fill долетел)`);
      } catch (err) {
        logger.warn(`[Adopt] backfill entry_time #${coin} failed: ${err.message}`);
      }
      _provisionalAdopt.delete(coin);
    } else if (now - info.since > BACKFILL_GIVEUP_MS) {
      logger.debug(`[Adopt] entry_time backfill #${coin} — fill не появился за ${(BACKFILL_GIVEUP_MS / 60_000)}м, оставляю провизорное время`);
      _provisionalAdopt.delete(coin);
    }
  }
}
