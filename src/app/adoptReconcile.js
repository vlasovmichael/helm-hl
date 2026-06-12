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
// Hunter-cooldown, размер ≤ ADOPT_MAX_SIZE_USD (safety rail на обкатку).
// Стоп reduce-only — может только ЗАКРЫТЬ позу, не нарастить/не развернуть.
// Ставим стоп ДО записи в БД: если постановка не удалась — НЕ усыновляем
// (остаёшься в обычном hands-off, без ложного «бот ведёт»).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  savePosition,
  getHistorySince,
  getArchivedHistorySince,
  getBotOidsSince,
} from '../core/database.js';
import { getAccountSummary } from '../modules/exchange.js';
import {
  placeHunterTrigger,
  placeHunterLongTrigger,
} from '../modules/executor/production.js';
import { resolveAsset } from '../modules/executor/fill-parser.js';
import { fetchUserFills, reconstructManualTrades } from '../modules/userFills.js';
import { isHunterCrossCooldownActive } from '../modules/hunterCrossCooldown.js';
import { isQuietHour } from '../modules/setupScannerAlerts.js';

/**
 * Время открытия текущей ОТКРЫТОЙ ручной позиции по монете (unix ms) или null.
 * Используем reconstructManualTrades (тот же источник, что дашборд) — он
 * отслеживает running size по fills и отдаёт entryTime открытой ноги, исключая
 * fills бота по oid. null → не смогли определить (тогда из осторожности НЕ
 * подхватываем — не усыновляем позу неизвестного возраста).
 */
async function getManualOpenTime(coin) {
  let fills;
  try {
    fills = await fetchUserFills(0); // 60d
  } catch (err) {
    logger.debug(`[Adopt] fetchUserFills failed: ${err.message}`);
    return null;
  }
  const botTrades = [
    ...getHistorySince(0).map((t) => ({ coin: t.coin, entry_time: t.entry_time, closed_at: t.closed_at })),
    ...getArchivedHistorySince(0).map((t) => ({ coin: t.coin, entry_time: t.entry_time, closed_at: t.closed_at })),
  ];
  const botOidSet = getBotOidsSince(0);
  const trades = reconstructManualTrades(fills, botTrades, botOidSet);
  const open = trades.find(
    (t) => t.status === 'open' && t.coin.toUpperCase() === coin.toUpperCase(),
  );
  return open ? open.entryTime : null;
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
 * Подхватывает ОДНУ свежую ручную позу в свободный слот (single-slot → берём
 * первую подходящую) и ставит реальный reduce-only стоп. Возвращает coin
 * усыновлённой позы или null.
 *
 * Вызывается из orphanCheck ТОЛЬКО когда слот свободен (нет позиции бота в БД)
 * и ADOPT_ENABLED.
 *
 * @param {Array<{coin, szi, entryPx}>} manualPositions
 * @returns {Promise<string|null>} coin усыновлённой позы
 */
export async function maybeAdoptManualPosition(manualPositions) {
  if (!config.trading.adoptEnabled) return null;
  if (!config.isProduction) return null;
  if (!Array.isArray(manualPositions) || manualPositions.length === 0) return null;

  const now = Date.now();
  const maxAgeMs  = config.trading.adoptMaxAgeMin * 60_000;
  const stopPct   = config.trading.adoptStopPct;
  const maxSizeUsd = config.trading.adoptMaxSizeUsd;

  for (const ex of manualPositions) {
    const coin    = ex.coin;
    const side    = ex.szi < 0 ? 'short' : 'long';
    const entry   = ex.entryPx;
    const sz      = Math.abs(ex.szi);
    const sizeUsd = sz * entry;

    // Гард: не подхватываем монету в Hunter cross-cooldown (после недавнего close).
    if (isHunterCrossCooldownActive(coin, now)) {
      logger.info(`[Adopt] skip #${coin} — Hunter cross-cooldown active`);
      continue;
    }

    // Гард: safety rail на обкатку — только мелкие позы (0 = без лимита).
    if (maxSizeUsd > 0 && sizeUsd > maxSizeUsd) {
      logger.info(`[Adopt] skip #${coin} — size $${sizeUsd.toFixed(2)} > ADOPT_MAX_SIZE_USD $${maxSizeUsd}`);
      continue;
    }

    // Гард: возраст. null → возраст неизвестен → не рискуем (возможно старый orphan).
    const openTime = await getManualOpenTime(coin);
    if (openTime == null) {
      logger.info(`[Adopt] skip #${coin} — open time undetermined (not adopting unknown-age orphan)`);
      continue;
    }
    const ageMin = (now - openTime) / 60_000;
    if (now - openTime > maxAgeMs) {
      logger.info(`[Adopt] skip #${coin} — too old (${ageMin.toFixed(1)}min > ${config.trading.adoptMaxAgeMin}min)`);
      continue;
    }

    // ── Жёсткий стоп (reduce-only) ──────────────
    const plannedSl = side === 'short'
      ? entry * (1 + stopPct / 100)
      : entry * (1 - stopPct / 100);

    let szDecimals;
    try {
      ({ szDecimals } = resolveAsset(coin));
    } catch (err) {
      logger.warn(`[Adopt] skip #${coin} — resolveAsset failed: ${err.message}`);
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
      // просто бот не «владеет» ею в БД. Логируем громко, не падаем.
      logger.error(`[Adopt] savePosition #${coin} failed ПОСЛЕ постановки стопа (oid=${slOid}): ${err.message}`);
      return null;
    }

    logger.info(
      `[Adopt] 🤝 adopted #${coin} ${side.toUpperCase()} (id=${id}) | ` +
      `entry=$${entry} size=$${sizeUsd.toFixed(2)} age=${ageMin.toFixed(1)}min | ` +
      `SL @ $${plannedSl.toPrecision(6)} (−${stopPct}%) oid=${slOid}`,
    );

    await fireAdoptNtfy(
      `🤝 Adopt #${coin} ${side.toUpperCase()} — стоп выставлен`,
      `Подхватил ручную позу $${sizeUsd.toFixed(0)} @ $${entry}\n` +
      `Стоп на бирже: $${plannedSl.toPrecision(6)} (−${stopPct}%)\n` +
      `Дальше веду сам. Храповик/трейл — на подходе.`,
      ['handshake'],
    );

    return coin; // single-slot — усыновляем только одну за проход
  }

  return null;
}
