// ─────────────────────────────────────────────────
//  Adopt Mode — бот-нянька на ручные входы (Iter 1: SHADOW)
// ─────────────────────────────────────────────────
// План: plans/adopt-mode-plan.md
//
// Юзер открывает позицию руками → бот подхватывает её в СВОБОДНЫЙ слот как
// strategy_id='adopt' и (в будущих итерациях) ведёт дисциплинированный выход
// (стоп + BE-храповик + трейл). Главный леак ручной торговли — отсутствие
// стопа (memory trading-coaching-payoff-leak): бот чинит ВЫХОД, не вход.
//
// Iter 1 = SHADOW. Здесь мы ТОЛЬКО:
//   • детектим свежую ручную позу (≤ ADOPT_MAX_AGE_MIN, не в Hunter-cooldown),
//   • пишем её в positions как 'adopt' (занимает слот → Hunter не входит),
//   • логируем план выхода («где был бы стоп, когда взвёлся бы храповик/трейл»),
//   • шлём ntfy-пуш с пометкой SHADOW.
// ОРДЕРА НЕ СТАВИМ. Coordinator на sid='adopt' возвращает HOLD. Реальный стоп —
// Iter 2, храповик/трейл — Iter 3. Выход в Iter 1 = только ручное закрытие
// оператором (его ловит integrityCheck и пишет фактический pnl в ledger как 'adopt').

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  savePosition,
  getHistorySince,
  getArchivedHistorySince,
  getBotOidsSince,
} from '../core/database.js';
import { getAccountSummary } from '../modules/exchange.js';
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
 * первую подходящую). Возвращает coin усыновлённой позы или null.
 *
 * Вызывается из orphanCheck ТОЛЬКО когда слот свободен (нет позиции бота в БД)
 * и ADOPT_ENABLED. Гарды: возраст ≤ ADOPT_MAX_AGE_MIN, не в Hunter-cooldown,
 * возраст определяется (иначе пропуск).
 *
 * @param {Array<{coin, szi, entryPx}>} manualPositions
 * @returns {Promise<string|null>} coin усыновлённой позы
 */
export async function maybeAdoptManualPosition(manualPositions) {
  if (!config.trading.adoptEnabled) return null;
  if (!config.isProduction) return null;
  if (!Array.isArray(manualPositions) || manualPositions.length === 0) return null;

  const now = Date.now();
  const maxAgeMs = config.trading.adoptMaxAgeMin * 60_000;
  const stopPct  = config.trading.adoptStopPct;

  for (const ex of manualPositions) {
    const coin = ex.coin;

    // Гард: не подхватываем монету в Hunter cross-cooldown (после недавнего close).
    if (isHunterCrossCooldownActive(coin, now)) {
      logger.info(`[Adopt] skip #${coin} — Hunter cross-cooldown active`);
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

    // ── Усыновляем ──────────────────────────────
    const side    = ex.szi < 0 ? 'short' : 'long';
    const entry   = ex.entryPx;
    const sizeUsd = Math.abs(ex.szi) * entry;
    // Жёсткий стоп (Iter 1 — только план, ордер НЕ ставим).
    const plannedSl = side === 'short'
      ? entry * (1 + stopPct / 100)
      : entry * (1 - stopPct / 100);

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
        size_usd:     sizeUsd,
        entry_price:  entry,
        entry_apy:    0,             // adopt не carry — APY неприменим
        entry_time:   openTime,      // фактическое время ручного входа
        mode:         'PRODUCTION',
        strategy_id:  'adopt',
        side,
        entry_equity: entryEquity,
        // Iter 1: sl_price НЕ пишем — ордера нет, и чтобы никакой код не счёл
        // стоп выставленным. План стопа только в логе/пуше ниже.
      });
    } catch (err) {
      logger.error(`[Adopt] savePosition #${coin} failed: ${err.message}`);
      return null;
    }

    logger.info(
      `[Adopt] 🤝 SHADOW-adopted #${coin} ${side.toUpperCase()} (id=${id}) | ` +
      `entry=$${entry} size=$${sizeUsd.toFixed(2)} age=${ageMin.toFixed(1)}min`,
    );
    logger.info(
      `[Adopt] План выхода (SHADOW, ордера НЕ ставятся): ` +
      `стоп @ $${plannedSl.toPrecision(6)} (−${stopPct}% от входа) | ` +
      `BE-храповик при peak ≥ +${config.trading.adoptBeArmPct}% | ` +
      `трейл при peak ≥ +${config.trading.adoptTrailArmPct}%, ` +
      `give-back ${config.trading.adoptTrailGiveBackPct}% от пика`,
    );

    await fireAdoptNtfy(
      `🤝 SHADOW adopt #${coin} ${side.toUpperCase()}`,
      `Подхватил ручную позу $${sizeUsd.toFixed(0)} @ $${entry}\n` +
      `План: стоп $${plannedSl.toPrecision(6)} (−${stopPct}%), храповик +${config.trading.adoptBeArmPct}%, трейл +${config.trading.adoptTrailArmPct}%\n` +
      `⚠️ SHADOW — реальный стоп ещё НЕ выставлен (Iter 1). Выход держишь сам.`,
      ['handshake'],
    );

    return coin; // single-slot — усыновляем только одну за проход
  }

  return null;
}
