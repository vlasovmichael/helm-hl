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
import { savePosition } from '../core/database.js';
import { getAccountSummary } from '../modules/exchange.js';
import {
  placeHunterTrigger,
  placeHunterLongTrigger,
} from '../modules/executor/hunterOpen.js';
import { resolveAsset } from '../modules/executor/fill-parser.js';
import { fetchUserFills } from '../modules/userFills.js';
import { isQuietHour } from '../modules/setupScannerAlerts.js';
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
 * знаковая сумма ВСЕХ fills (и бот, и ручных). Идём по fills во времени, держим
 * net-размер; открытие текущей позы = момент, когда |net| ушёл от нуля (или
 * сменил знак). Бот-закрытие усыновлённой позы (Close-fill) при этом естественно
 * обнуляет net → фантомные «висящие» ноги, которые копила фильтрация бот-fills по
 * oid, физически невозможны (XPL incident 2026-06-17: adopt считал свежую позу
 * возрастом 6888мин и отказывал по too-old → поза без стопа → −$7.36).
 *
 * @param {Array} fills — сырые HL fills (как из fetchUserFills), любой порядок.
 * @returns {number|null} unix ms открытия текущей позы, либо null если по монете
 *   нет открытой позы в пределах загруженного окна fills.
 */
export function resolveManualOpenTime({ coin, fills }) {
  const C = String(coin).toUpperCase();
  const list = (fills || [])
    .filter((f) => f.coin?.toUpperCase() === C && typeof f.dir === 'string')
    .sort((a, b) => a.time - b.time);

  const EPS = 1e-9;
  let net = 0;          // знаковый размер: >0 long, <0 short
  let openTime = null;
  for (const f of list) {
    const sz = Math.abs(Number(f.sz) || 0);
    const isOpen = f.dir.startsWith('Open ');
    const isLong = f.dir.includes('Long');
    // long-открытие / short-закрытие → +sz; short-открытие / long-закрытие → −sz
    const signed = isOpen === isLong ? sz : -sz;
    const prev = net;
    net += signed;
    if (Math.abs(net) < EPS) {
      openTime = null;                                    // поза схлопнулась
    } else if (Math.abs(prev) < EPS || (prev > 0) !== (net > 0)) {
      openTime = f.time;                                  // 0→поза или разворот знака
    }
  }
  return openTime;
}

/**
 * Время открытия текущей ОТКРЫТОЙ ручной позиции по монете (unix ms) или null.
 * Источник — сырые HL fills (правда с биржи), см. resolveManualOpenTime. null →
 * не смогли определить (поза старше окна fills) → из осторожности НЕ подхватываем.
 */
async function getManualOpenTime(coin) {
  let fills;
  try {
    fills = await fetchUserFills(0); // 60d
  } catch (err) {
    logger.debug(`[Adopt] fetchUserFills failed: ${err.message}`);
    return null;
  }
  return resolveManualOpenTime({ coin, fills });
}

/** ntfy-пуш (best-effort). Тихий час 00–08 → priority=1 (без звука). */
async function fireAdoptNtfy(title, message, tags) {
  const { url, token, priority: basePriority } = config.ntfy;
  const topic = process.env.NTFY_TOPIC_ADOPT || config.ntfy.topic;
  if (!url || !topic) return;
  try {
    const { default: https } = await import('node:https');
    const { default: http } = await import('node:http');
    const priority = isQuietHour() ? 1 : (basePriority ?? 3);
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
  if (!Array.isArray(manualPositions) || manualPositions.length === 0) return [];

  const now = Date.now();
  const maxAgeMs = config.trading.adoptMaxAgeMin * 60_000;
  const adopted = [];

  for (const ex of manualPositions) {
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

    // Гард: возраст. null → возраст неизвестен → не рискуем (возможно старый orphan).
    const openTime = await getManualOpenTime(coin);
    if (openTime == null) {
      logger.info(`[Adopt] skip #${coin} — open time undetermined (not adopting unknown-age orphan)`);
      _adoptSkipReason.set(coin, 'возраст входа неизвестен');
      continue;
    }
    const ageMin = (now - openTime) / 60_000;
    if (now - openTime > maxAgeMs) {
      logger.info(`[Adopt] skip #${coin} — too old (${ageMin.toFixed(1)}min > ${config.trading.adoptMaxAgeMin}min)`);
      _adoptSkipReason.set(coin, `слишком старая (${ageMin.toFixed(0)}м > ${config.trading.adoptMaxAgeMin}м)`);
      continue;
    }

    // ── Жёсткий стоп (reduce-only) ──────────────
    // Дистанция: ATR(1h)×MULT (подстройка под волатильность) либо фикс-% фолбэк.
    const { distPct, basis } = await computeStopDistPct(coin);
    const plannedSl = side === 'short'
      ? entry * (1 + distPct / 100)
      : entry * (1 - distPct / 100);

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
        entry_time:    openTime,     // фактическое время ручного входа
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

    _adoptSkipReason.delete(coin); // усыновлена — вопрос «почему не adopted» снят
    adopted.push(coin); // multi-slot — продолжаем подхватывать остальные
  }

  return adopted;
}
