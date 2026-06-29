// ─────────────────────────────────────────────────
//  Watchlist — ntfy-будильник «моя монета задвигалась»
// ─────────────────────────────────────────────────
// Узкий будильник ТОЛЬКО по монетам watchlist (BTC/HYPE/SOL). Цель — не
// пропустить движение по своим 3 монетам, к которым идёт насмотренность
// (см. memory watchlist_narrow_discretionary). Это НЕ сигнал и НЕ воскрешение
// прибитого hotMoversAlerts (тот пушил continuation-вердикт по всей вселенной —
// безэджевый шум). Здесь: «иди посмотри», без стороны/входа/стопа.
//
// Сработка: монета внезапно двинулась (|Δprice| за окно ≥ MOVE_PCT) И OI это
// подтверждает (|ΔOI| за то же окно ≥ OI_PCT) — отсекает пустые фитили без
// набора позиции. Кулдаун на монету, чтобы не долбило.
//
// Данные считаем САМИ на своём интервале (не из дашборда — он молчит, когда
// браузер закрыт): live из state.latestHunter (ставит tick), история цены из
// priceHistory, история OI из oiHistory. Fail-soft: ошибки не валят бота.

import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { fireNtfy as fireNtfyCore } from '../core/ntfy.js';
import { state } from '../app/state.js';
import { getPriceNMinAgo } from '../core/priceHistory.js';
import { getOiNMinAgo } from '../core/oiHistory.js';

const ENABLED =
  (process.env.WATCHLIST_ALERT_ENABLED || 'true').toLowerCase() === 'true';

// Список монет-будильников. Дисциплинарная заметка → теперь явный конфиг.
// `*` = вся вселенная (только для теста «как выглядит»; на проде это спам, см.
// прибитый hotMoversAlerts). Иначе — явный список BTC,HYPE,SOL.
const RAW_WATCHLIST = (process.env.ALERT_WATCHLIST || 'BTC,HYPE,SOL').trim();
const WATCH_ALL = RAW_WATCHLIST === '*';
const WATCHLIST = RAW_WATCHLIST
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((s) => s && s !== '*');

// Скан каждые 15с (= цикл scout'а, который обновляет OI в state.latestHunter).
// Был 60с — это и был главный лаг детекта (OI-сёрдж приходил «поздно» не из-за
// данных, а потому что воркер их лениво опрашивал). Чаще смысла нет: OI в WS не
// приходит (allMids несёт только цены), свежее 15с он не станет без отдельной
// HL-подписки activeAssetCtx. Скан дешёвый — читает in-memory state, без HL-вызовов;
// кулдауны на монету не дают спамить. 2026-06-29.
const INTERVAL_MS =
  parseFloat(process.env.WATCHLIST_ALERT_INTERVAL_SEC || '15') * 1_000;
const WINDOW_MIN = parseFloat(process.env.WATCHLIST_ALERT_WINDOW_MIN || '5');
// Средняя чувствительность (2026-06-28): ±2.5%/5м хода + ≥3% OI за то же окно.
const MOVE_PCT = parseFloat(process.env.WATCHLIST_ALERT_MOVE_PCT || '2.5');
const OI_PCT = parseFloat(process.env.WATCHLIST_ALERT_OI_PCT || '3');
const COOLDOWN_MS =
  parseFloat(process.env.WATCHLIST_ALERT_COOLDOWN_MIN || '45') * 60_000;

// ── OI-сёрдж: независимый триггер «OI выше обычного» ──
// Отдельно от ценового будильника. Срабатывает на резкий набор/сброс позиций
// БЕЗ требования большого хода цены. Порог 3% = «синяя» подсветка OI на
// дашборде (hotMovers/render.js: var(--accent) при |ΔOI5m|≥3). Но окно тут
// КОРОЧЕ — 1 минута: ловим именно резкий всплеск (OI ползёт медленнее цены, 3%
// за 1м — это сильно). Данных хватает: OI снапшотится каждые 30с (oiHistory).
const OI_SURGE_ENABLED =
  (process.env.WATCHLIST_OI_SURGE_ENABLED || 'true').toLowerCase() === 'true';
const OI_SURGE_PCT = parseFloat(process.env.WATCHLIST_OI_SURGE_PCT || '3');
const OI_SURGE_WINDOW_MIN = parseFloat(process.env.WATCHLIST_OI_SURGE_WINDOW_MIN || '1');
const OI_SURGE_COOLDOWN_MS =
  parseFloat(process.env.WATCHLIST_OI_SURGE_COOLDOWN_MIN || '30') * 60_000;

const STATE_FILE = 'data/watchlist_alert_state.json';
const alertAt = new Map();   // coin → ts последнего ценового пуша (персист)
const oiAlertAt = new Map(); // coin → ts последнего OI-сёрдж пуша (персист)

function loadAlertState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    for (const [k, v] of Object.entries(raw.alertAt ?? {})) alertAt.set(k, v);
    for (const [k, v] of Object.entries(raw.oiAlertAt ?? {})) oiAlertAt.set(k, v);
  } catch {
    // нет файла / битый — с нуля
  }
}

function saveAlertState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      alertAt: Object.fromEntries(alertAt),
      oiAlertAt: Object.fromEntries(oiAlertAt),
    }));
  } catch (err) {
    logger.warn(`[WatchlistAlerts] state save failed: ${err.message}`);
  }
}

// Свой топик (переиспользуем NTFY_TOPIC_MOVERS). priority + тихий час + журнал
// колокольчика + почту считает core fireNtfy.
async function fireNtfy(title, message, tags) {
  await fireNtfyCore({
    topic: process.env.NTFY_TOPIC_MOVERS || config.ntfy.topic,
    title,
    message,
    tags,
  });
}

const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

async function runOnce(now = Date.now()) {
  const snap = state.latestHunter;
  if (!Array.isArray(snap) || snap.length === 0) return;

  const watch = new Set(WATCHLIST);
  for (const item of snap) {
    if (!item?.coin || item.price == null) continue;
    if (!WATCH_ALL && !watch.has(item.coin)) continue;

    // ── OI-сёрдж (1м) — независимый триггер, БЕЗ ценового гейта ──
    // Резкий набор/сброс позиций сам по себе — повод глянуть. Не делаем
    // continue: монета может дать и OI-сёрдж, и ниже ценовой будильник.
    if (OI_SURGE_ENABLED && item.oiUsd != null) {
      const oiAgoSurge = getOiNMinAgo(item.coin, OI_SURGE_WINDOW_MIN, now);
      if (oiAgoSurge != null && oiAgoSurge > 0) {
        const oiSurgePct = ((item.oiUsd - oiAgoSurge) / oiAgoSurge) * 100;
        if (
          Math.abs(oiSurgePct) >= OI_SURGE_PCT &&
          now - (oiAlertAt.get(item.coin) ?? 0) >= OI_SURGE_COOLDOWN_MS
        ) {
          oiAlertAt.set(item.coin, now);
          saveAlertState();
          const oiUp = oiSurgePct >= 0;
          logger.info(
            `[WatchlistAlerts] 📊 OI #${item.coin} ${fmtPct(oiSurgePct)}/${OI_SURGE_WINDOW_MIN}m`,
          );
          await fireNtfy(
            `📊 OI #${item.coin} ${oiUp ? '▲' : '▼'} ${fmtPct(oiSurgePct)}`,
            `OI ${fmtPct(oiSurgePct)} за ${OI_SURGE_WINDOW_MIN}м — резкий ${oiUp ? 'набор' : 'сброс'} позиций.\n` +
              `Глянь график. Это будильник, не сделка — вход/стоп твои.`,
            [oiUp ? 'green_circle' : 'red_circle'],
          );
        }
      }
    }

    // Δprice за окно
    const pxAgo = getPriceNMinAgo(item.coin, WINDOW_MIN, now);
    if (pxAgo == null || pxAgo <= 0) continue;
    const movePct = ((item.price - pxAgo) / pxAgo) * 100;
    if (Math.abs(movePct) < MOVE_PCT) continue;

    // ΔOI за то же окно — подтверждение, что под движением набирают позицию
    const oiAgo = getOiNMinAgo(item.coin, WINDOW_MIN, now);
    if (item.oiUsd == null || oiAgo == null || oiAgo <= 0) continue;
    const oiPct = ((item.oiUsd - oiAgo) / oiAgo) * 100;
    if (Math.abs(oiPct) < OI_PCT) continue;

    // Кулдаун на монету
    if (now - (alertAt.get(item.coin) ?? 0) < COOLDOWN_MS) continue;
    alertAt.set(item.coin, now);
    saveAlertState();

    const up = movePct >= 0;
    logger.info(
      `[WatchlistAlerts] 👀 #${item.coin} ${fmtPct(movePct)}/${WINDOW_MIN}m, OI ${fmtPct(oiPct)}`,
    );
    await fireNtfy(
      `👀 #${item.coin} задвигалась ${fmtPct(movePct)}`,
      `${fmtPct(movePct)} за ${WINDOW_MIN}м, OI ${fmtPct(oiPct)} — набирают позицию.\n` +
        `Глянь график. Это будильник, не сделка — вход/стоп твои.`,
      // 👀 уже в заголовке — тег 'eyes' убран, иначе ntfy рисует двойной 👀.
      [up ? 'green_circle' : 'red_circle'],
    );
  }
}

/** Запуск воркера. Независим от открытого дашборда. */
export function startWatchlistAlerts() {
  if (!ENABLED) {
    logger.info('[WatchlistAlerts] disabled (WATCHLIST_ALERT_ENABLED=false)');
    return;
  }
  if (!WATCH_ALL && WATCHLIST.length === 0) {
    logger.info('[WatchlistAlerts] disabled — ALERT_WATCHLIST пуст');
    return;
  }
  loadAlertState();
  const timer = setInterval(() => {
    runOnce().catch((err) => logger.warn(`[WatchlistAlerts] tick failed: ${err.message}`));
  }, INTERVAL_MS);
  timer.unref?.();
  const coinsLabel = WATCH_ALL ? '* (вся вселенная)' : WATCHLIST.join(',');
  const oiSurgeLabel = OI_SURGE_ENABLED
    ? `OI-surge ±${OI_SURGE_PCT}%/${OI_SURGE_WINDOW_MIN}m (cd ${OI_SURGE_COOLDOWN_MS / 60_000}m)`
    : 'OI-surge off';
  logger.info(
    `[WatchlistAlerts] started — every ${INTERVAL_MS / 1000}s, coins=[${coinsLabel}], ` +
      `trigger ±${MOVE_PCT}%/${WINDOW_MIN}m + OI ±${OI_PCT}%, cooldown ${COOLDOWN_MS / 60_000}m | ${oiSurgeLabel}`,
  );
}

/** Сброс стейта (тесты). */
export function clearWatchlistAlertState() {
  alertAt.clear();
}
