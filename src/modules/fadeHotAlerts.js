// ─────────────────────────────────────────────────
//  Fade-high-ER alert-feed — ВСЕ гейтованные сетапы в ntfy (не только взятый слотом)
// ─────────────────────────────────────────────────
// Отдельный воркер (как hotMoversAlerts): сканит всю вселенную (state.latestHunter),
// и на КАЖДУЮ монету, где сработал fade-high-ER (ход30м≥3% И ER4ч≥0.47) в ГОРЯЧЕМ
// рынке (BTC 4ч ER ≥ порога — общий классификатор btcRegimeFromCandles), шлёт пуш.
// В отличие от paper-слота (одна сильнейшая поза за раз) — feed показывает все
// сетапы, чтобы оператор видел картину «правильное место в правильное время» целиком.
//
// НЕ путать со старым hotMoversAlerts (continuation, бэктест в минус, дефолт OFF) —
// тут пушится ТОЛЬКО fade-high-ER (эдж, переживший OOS). Сигнал, не сделка: вход и
// стоп — на стороне оператора; бот лишь подсвечивает редкий выдохшийся хвост.

import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { state } from '../app/state.js';
import { getPriceNMinAgo } from '../core/priceHistory.js';
import { getFifteenMinCandles } from './candleCache.js';
import { fireNtfy } from '../core/ntfy.js';
import {
  evaluateFadeHot,
  fadeHotZone,
  btcRegimeFromCandles,
  FADEHOT_MOVE_LB,
  FADEHOT_ER_WIN,
  FADEHOT_MOVE_THR,
  FADEHOT_STOP_PCT,
  FADEHOT_TIME_STOP_MIN,
  FADEHOT_REGIME_GATE,
  FADEHOT_BTC_ER_MIN,
  FADEHOT_BTC_COIN,
} from './fadeHotSignal.js';

const ENABLED       = (process.env.FADEHOT_ALERT_FEED_ENABLED || 'true').toLowerCase() === 'true';
const INTERVAL_MS   = parseFloat(process.env.FADEHOT_ALERT_INTERVAL_MIN || '1') * 60_000;
const COOLDOWN_MS   = parseFloat(process.env.FADEHOT_ALERT_COOLDOWN_MIN || '60') * 60_000; // не частить по монете
const PREGATE_MIN   = parseInt(process.env.FADEHOT_PREGATE_LOOKBACK_MIN || '30', 10);
const CANDLE_LB_MIN = (FADEHOT_ER_WIN + FADEHOT_MOVE_LB + 4) * 15;            // ≈5ч с запасом
const MAX_FETCH     = parseInt(process.env.FADEHOT_ALERT_MAX_FETCH || '12', 10); // кап тяжёлых fetch/скан
const TOPIC         = process.env.NTFY_TOPIC_FADEHOT || config.ntfy.topic;
// Холодный рынок (BTC ER < порога) — сетапы не торгуемы, но шлём их eyes-only в
// отдельный топик для тренировки глаза; боевая лента TOPIC остаётся чистой.
const COLD_TOPIC    = process.env.NTFY_TOPIC_FADEHOT_COLD || 'hl-fade-cold';
const STATE_FILE    = 'data/fadehot_alert_state.json';

const alertAt = new Map(); // 'coin:side' → ts (персист между рестартами)

function loadAlertState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw.alertAt ?? {})) alertAt.set(k, v);
  } catch { /* первый запуск — файла нет */ }
}
function saveAlertState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ alertAt: Object.fromEntries(alertAt) }));
  } catch (err) {
    logger.warn(`[FadeHotAlerts] state save failed: ${err.message}`);
  }
}

/** Один проход скана. Экспортируется для тестов (fetchCandles инжектится). */
export async function runOnce(now = Date.now(), fetchCandles = getFifteenMinCandles) {
  const snap = state.latestHunter;
  if (!Array.isArray(snap) || snap.length === 0) return;

  // ── Дешёвый пре-гейт: монеты с ходом 30м ≥ порога (без HL-запросов) ──
  const candidates = [];
  for (const item of snap) {
    if (!item?.coin || item.price == null) continue;
    const past = getPriceNMinAgo(item.coin, PREGATE_MIN, now);
    if (past == null || !(past > 0)) continue;
    if (Math.abs(((item.price - past) / past) * 100) < FADEHOT_MOVE_THR) continue;
    candidates.push(item);
  }
  const breadth = candidates.length;
  if (candidates.length === 0) return;

  // ── Гейт режима: горячий рынок (BTC трендит) → боевой топик; холодный →
  //    тот же сетап, но eyes-only в COLD_TOPIC (не торгуем, тренируем глаз) ──
  let btcER = null;
  let hot = true;
  if (FADEHOT_REGIME_GATE) {
    let regime = { btcER: null, hot: false };
    try {
      regime = btcRegimeFromCandles(await fetchCandles(FADEHOT_BTC_COIN, CANDLE_LB_MIN, now));
    } catch { /* нет свечей BTC */ }
    btcER = regime.btcER;
    hot = regime.hot;
  }

  // ── Подтверждение по 15m-свечам + пуш каждого сетапа ──
  for (const item of candidates.slice(0, MAX_FETCH)) {
    let candles;
    try {
      candles = await fetchCandles(item.coin, CANDLE_LB_MIN, now);
    } catch {
      candles = null;
    }
    if (!candles) continue;

    const v = evaluateFadeHot(candles);
    if (!v.fired) continue;

    // Cooldown разведён по режиму: холодный пуш не глушит последующий
    // боевой по той же монете (cold→hot переход проходит сразу).
    const key = `${item.coin}:${v.side}${hot ? '' : ':cold'}`;
    if (now - (alertAt.get(key) ?? 0) < COOLDOWN_MS) continue;
    alertAt.set(key, now);
    saveAlertState();

    const { stop } = fadeHotZone(v.side, item.price, FADEHOT_STOP_PCT);
    const arrow = v.side === 'SHORT' ? '🔻' : '🔺';
    const moveStr = `${v.move >= 0 ? '+' : ''}${v.move.toFixed(1)}%`;
    const erStr = btcER == null ? 'n/a' : btcER.toFixed(2);

    if (hot) {
      logger.info(`[FadeHotAlerts] 🎯 FADE ${v.side} #${item.coin} | ход30м ${moveStr}, ER ${v.er.toFixed(2)}, BTC ER ${erStr}`);
      await fireNtfy({
        topic: TOPIC,
        title: `${arrow} FADE ${v.side} ${item.coin}`,
        message:
          `ход 30м ${moveStr} · ER ${v.er.toFixed(2)} (выдохшийся хвост)\n` +
          `вход ~$${item.price} · стоп ${FADEHOT_STOP_PCT}% · удержание до ${Math.round(FADEHOT_TIME_STOP_MIN / 60)}ч (стоп $${stop.toFixed(6)})\n` +
          `режим: BTC ER ${erStr} · breadth ${breadth} (рынок горячий)\n` +
          `сигнал, не сделка — вход/стоп твои, смотри 5m`,
        tags: ['fire', v.side === 'SHORT' ? 'chart_with_downwards_trend' : 'chart_with_upwards_trend'],
        now,
      });
    } else {
      logger.info(`[FadeHotAlerts] ❄️ COLD FADE ${v.side} #${item.coin} | ход30м ${moveStr}, ER ${v.er.toFixed(2)}, BTC ER ${erStr} → ${COLD_TOPIC} (eyes-only)`);
      await fireNtfy({
        topic: COLD_TOPIC,
        title: `❄️ COLD · fade ${v.side} ${item.coin}`,
        message:
          `ход 30м ${moveStr} · ER ${v.er.toFixed(2)} (выдохшийся хвост)\n` +
          `зона ~$${item.price} · стоп ${FADEHOT_STOP_PCT}% (стоп $${stop.toFixed(6)})\n` +
          `режим: BTC ER ${erStr} < ${FADEHOT_BTC_ER_MIN} — рынок ХОЛОДНЫЙ\n` +
          `НЕ входить — только тренировка глаза, смотри 5m`,
        tags: ['snowflake'],
        priority: 2,
        now,
      });
    }
  }
}

/** Запуск воркера. Независим от paper-слота и открытого дашборда. */
export function startFadeHotAlerts() {
  if (!ENABLED) {
    logger.info('[FadeHotAlerts] disabled (FADEHOT_ALERT_FEED_ENABLED=false)');
    return;
  }
  loadAlertState();
  const timer = setInterval(() => {
    runOnce().catch((err) => logger.warn(`[FadeHotAlerts] tick failed: ${err.message}`));
  }, INTERVAL_MS);
  timer.unref?.();
  logger.info(`[FadeHotAlerts] started — every ${INTERVAL_MS / 60_000}min, cooldown ${COOLDOWN_MS / 60_000}min, topic=${TOPIC || '—'}, cold→${COLD_TOPIC}`);
}

/** Сброс стейта (тесты). */
export function clearFadeHotAlertState() {
  alertAt.clear();
}
