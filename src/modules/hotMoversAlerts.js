// ─────────────────────────────────────────────────
//  Hot Movers — ntfy-алерт «мувер стал enterable»
// ─────────────────────────────────────────────────
// Пуш, когда монета с НАПРАВЛЕННЫМ Setup (trend/fade, OI-подтверждён, score
// ≥ порога) ПЕРЕХОДИТ в чейз-зону 🎯 — т.е. цена улетела, а теперь откатилась
// к базе и вход созрел (не чейз вертикальной свечи). Зеркалит карточку Hot
// Movers (Setup + колонка Enter), логика в hotMoversSetup.js.
//
// Данные считаем САМИ на своём интервале (не из дашборда — он молчит, когда
// браузер закрыт): live-снапшот из state.latestHunter (ставит tick, в т.ч. в
// HANDS-OFF), история цены из priceHistory, история OI из dashboard/server.
//
// ⚠️ Контекст-алерт, не команда: без цен входа/выхода, без TP/SL. Решение и
// инвалидация — у оператора. Fail-soft: ошибки не валят бота.

import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { state } from '../app/state.js';
import { getPriceNMinAgo } from '../core/priceHistory.js';
import {
  buildCoinFeatures,
  evaluateCoinAlert,
  computeBreadthFlush,
  deriveOiKind,
} from './hotMoversSetup.js';

const ENABLED =
  (process.env.HOT_MOVERS_ALERT_ENABLED || 'true').toLowerCase() === 'true';
const INTERVAL_MS =
  parseFloat(process.env.HOT_MOVERS_ALERT_INTERVAL_MIN || '2') * 60_000;
// Порог силы для пуша (визуальный бейдж активен с 1.5; пуш строже, чтобы не
// частить). Требуется ещё и подтверждённый режим (trend/fade).
const MIN_SCORE = parseFloat(process.env.HOT_MOVERS_ALERT_MIN_SCORE || '3');
const COOLDOWN_MS =
  parseFloat(process.env.HOT_MOVERS_ALERT_COOLDOWN_H || '4') * 3_600_000;

// ── ntfy + тихий час (00–08 Europe/Warsaw: шлём с priority=1, без звука) ──
const QUIET_FROM = parseInt(process.env.HOT_MOVERS_QUIET_FROM ?? '0', 10);
const QUIET_TO = parseInt(process.env.HOT_MOVERS_QUIET_TO ?? '8', 10);

export function isQuietHour(now = Date.now()) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric', hour12: false, timeZone: 'Europe/Warsaw',
    }).format(now),
    10,
  );
  return QUIET_FROM <= QUIET_TO
    ? hour >= QUIET_FROM && hour < QUIET_TO
    : hour >= QUIET_FROM || hour < QUIET_TO;
}

async function fireNtfy(title, message, tags) {
  const { url, token } = config.ntfy;
  const topic = process.env.NTFY_TOPIC_MOVERS || config.ntfy.topic;
  if (!url || !topic) return;
  try {
    const { default: https } = await import('node:https');
    const { default: http } = await import('node:http');
    const priority = isQuietHour() ? 1 : (config.ntfy.priority ?? 3);
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
    logger.warn(`[MoversAlerts] ntfy failed: ${err.message}`);
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

const prevByCoin = new Map(); // coin → { side, state }
const alertAt = new Map();    // 'coin:side' → ts (персист)

const STATE_FILE = 'data/hotmovers_alert_state.json';

function loadAlertState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    for (const [k, v] of Object.entries(raw.alertAt ?? {})) alertAt.set(k, v);
  } catch {
    // нет файла / битый — с нуля
  }
}

function saveAlertState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ alertAt: Object.fromEntries(alertAt) }));
  } catch (err) {
    logger.warn(`[MoversAlerts] state save failed: ${err.message}`);
  }
}

async function runOnce(now = Date.now()) {
  const snap = state.latestHunter;
  if (!Array.isArray(snap) || snap.length === 0) return;
  const ts = state.latestHunterAt || now;
  // Ленивый импорт: модуль тянет config/exchange — не грузим на старте/в тестах.
  const { getOiNMinAgo, getHtfTrend } = await import('./dashboard/routes/movers.js');
  const deps = { priceNMinAgo: getPriceNMinAgo, oiNMinAgo: getOiNMinAgo };

  // Breadth-слив: считаем фичи по всем монетам один раз, чтобы fade против
  // синхронного делевереджа (лов ножа) не стрелял в ntfy.
  const featByCoin = new Map();
  const rows = [];
  for (const item of snap) {
    if (!item?.coin || item.price == null) continue;
    const feats = buildCoinFeatures(item, ts, deps);
    featByCoin.set(item.coin, feats);
    rows.push(feats);
  }
  const flush = computeBreadthFlush(rows);

  for (const item of snap) {
    if (!item?.coin || item.price == null) continue;
    const feats = featByCoin.get(item.coin);
    // HTF-тренд нужен только fade-сетапам (OI↓). Дёргаем 1h-свечи лишь для них,
    // чтобы не бомбить API по всей вселенной (cache 5мин/60с всё равно гасит).
    const htfTrend =
      deriveOiKind(feats) === 'down'
        ? await getHtfTrend(item.coin, item.price, ts)
        : null;
    const res = evaluateCoinAlert(item, feats, prevByCoin, MIN_SCORE, flush, htfTrend);
    if (!res.fire) continue;

    const key = `${item.coin}:${res.side}`;
    if (now - (alertAt.get(key) ?? 0) < COOLDOWN_MS) continue;
    alertAt.set(key, now);
    saveAlertState();

    const ext = res.chase.extDir;
    const extStr = ext != null ? `${ext >= 0 ? '+' : ''}${ext.toFixed(1)}%` : '—';
    const win = res.chase.win ? `${res.chase.win}m` : '15m';
    logger.info(
      `[MoversAlerts] 🎯 enterable: ${res.mode.toUpperCase()} ${res.side} #${item.coin} (ext ${extStr}/${win}, score ${res.score.toFixed(1)})`,
    );
    await fireNtfy(
      `🎯 ${res.side} enterable #${item.coin}`,
      `${res.mode.toUpperCase()} ${res.side} · цена у базы (${extStr} в сторону сделки за ${win})\n` +
        `улетела → откатилась, чейза нет. Setup score ${res.score.toFixed(1)}.\n` +
        `Вход и стоп — твои. Смотри 5m.`,
      [res.side === 'LONG' ? 'green_circle' : 'red_circle'],
    );
  }
}

/** Запуск воркера. Независим от открытого дашборда. */
export function startHotMoversAlerts() {
  if (!ENABLED) {
    logger.info('[MoversAlerts] disabled (HOT_MOVERS_ALERT_ENABLED=false)');
    return;
  }
  loadAlertState();
  const timer = setInterval(() => {
    runOnce().catch((err) => logger.warn(`[MoversAlerts] tick failed: ${err.message}`));
  }, INTERVAL_MS);
  timer.unref?.();
  logger.info(
    `[MoversAlerts] started — every ${INTERVAL_MS / 60_000}min, minScore=${MIN_SCORE}, topic=${process.env.NTFY_TOPIC_MOVERS || config.ntfy.topic || '—'}`,
  );
}

/** Сброс стейта (тесты). */
export function clearMoversAlertState() {
  prevByCoin.clear();
  alertAt.clear();
}
