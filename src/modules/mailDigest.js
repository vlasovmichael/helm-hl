// ─────────────────────────────────────────────────
//  Ежедневный итог сделок (почтовый дайджест за сутки)
// ─────────────────────────────────────────────────
// ЧЕСТНЫЕ ЦИФРЫ ИЗ FILLS. Источник — getAllRoundTrips() (реконструкция из HL
// userFills, тот же, что Monthly Ledger и P&L Summary на дашборде). Раньше
// дайджест читал таблицу `history` и видел лишь ~треть сделок (ручные/флипнутые
// трипы туда не пишутся) → «0 сделок · +$0.00», когда сделок были десятки.
//
// Что показываем: итог дня (net = pnl − fee), число сделок, win%, реальный
// payoff и нужный при нём винрейт, лучшая/худшая сделка, бот-строкой. БЕЗ
// per-trade «коуч-вердиктов»: тренд/MFE/MAE в fills нет, а достраивать их лишь
// по трети сделок из `history` = скрытая ложь. Разбор — на дашборде/в журнале.
//
// Дизайн — светлый Stripe-style (как appointment_tg_bot), email-safe inline.
// Шлётся cron'ом 21:05 (см. index.js). Fail-soft: sendMail сам тихо no-op.

import { logger } from '../core/logger.js';
import { sendMail, isMailEnabled } from '../core/mail.js';
import { getAllRoundTrips } from './dashboard/routes/manualTrades.js';
import { buildStrategiesPayload } from './dashboard/strategiesView.js';

const DAY_MS = 86_400_000;

// Внешний адрес дашборды (за прокси). Пусто — письмо идёт без ссылки.
const PUBLIC_URL = (process.env.DASHBOARD_PUBLIC_URL || '').replace(/\/$/, '');

// «Мои» сделки = решение принимал я (нянька-adopt / чистая рука), не автономный бот.
const MY_SOURCES = new Set(['adopted', 'manual']);

// Палитра (светлая, Stripe-style — как appointment_tg_bot).
const C = {
  text: '#1a1f36', body: '#3c4257', mut: '#697386', faint: '#8792a2',
  border: '#e6ebf1', card: '#ffffff', subtle: '#fcfdfe', page: '#f6f9fc',
  green: '#0a8a5f', greenBg: '#e3f6f0', red: '#cd2b4a', redBg: '#fcebef',
  amber: '#9a6a00', amberBg: '#fdf3e0', accent: '#635bff',
};

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
}
function fmtDate(now) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'long', timeZone: 'Europe/Warsaw',
  }).format(now);
}

// net money по трипу = price PnL − комиссии (контракт как DB realized_pnl).
function tripNet(t) {
  return (Number(t.pnl) || 0) - (Number(t.fee) || 0);
}

/**
 * HTML тела итога за последние 24ч.
 * @param {number} now
 * @param {Array}  tripsOverride — готовые round-trip'ы для превью/тестов (иначе из fills)
 * @returns {Promise<string|null>} null = слать нечего (нулевой день)
 */
export async function buildDigestHtml(now = Date.now(), tripsOverride = null) {
  const since = now - DAY_MS;

  let trips = tripsOverride;
  if (!trips) {
    try {
      trips = await getAllRoundTrips();
    } catch (err) {
      logger.warn(`[mailDigest] fills fetch failed: ${err.message}`);
      trips = [];
    }
  }

  // «Мои» закрытые сделки в окне суток.
  const myTrades = (trips || []).filter(
    (t) => MY_SOURCES.has(t.source) && t.status === 'closed'
      && Number.isFinite(t.closeTime) && t.closeTime >= since && t.closeTime <= now
      && Number.isFinite(tripNet(t)),
  );

  const n = myTrades.length;
  // Нулевой день (реальная отправка) — слать нечего.
  if (n === 0 && tripsOverride === null) return null;

  const nets = myTrades.map(tripNet);
  const wins = myTrades.filter((t) => tripNet(t) > 0);
  const losses = myTrades.filter((t) => tripNet(t) < 0);
  const net = nets.reduce((s, v) => s + v, 0);
  const winPct = n ? Math.round((wins.length / n) * 100) : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + tripNet(t), 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + tripNet(t), 0) / losses.length) : 0;
  const payoff = avgLoss ? (avgWin / avgLoss) : (avgWin ? Infinity : 0);
  const payoffStr = Number.isFinite(payoff) ? payoff.toFixed(2) : (avgWin ? '∞' : '—');

  // Разбивка нянька/рука — честный факт, без вердиктов.
  const adopt = myTrades.filter((t) => t.source === 'adopted');
  const hand = myTrades.filter((t) => t.source === 'manual');
  const splitLine = (label, arr) => {
    if (!arr.length) return '';
    const s = arr.reduce((a, t) => a + tripNet(t), 0);
    return `${label} <strong style="color:${C.text}">${arr.length}</strong> (<span style="color:${s >= 0 ? C.green : C.red}">${fmtUsd(s)}</span>)`;
  };
  const split = [splitLine('nanny', adopt), splitLine('by hand', hand)].filter(Boolean).join(' · ');

  // Лучшая/худшая сделка — факт из fills.
  let extremes = '';
  if (n) {
    const best = myTrades.reduce((a, b) => (tripNet(b) > tripNet(a) ? b : a));
    const worst = myTrades.reduce((a, b) => (tripNet(b) < tripNet(a) ? b : a));
    const cell = (t) => `${esc(t.coin)} ${t.side === 'short' ? '↓' : '↑'} <strong>${fmtUsd(tripNet(t))}</strong>`;
    extremes =
      `<div style="font-size:15px;line-height:1.7;color:${C.body};margin-top:6px">` +
      `Best: <span style="color:${C.green}">${cell(best)}</span><br>` +
      `Worst: <span style="color:${C.red}">${cell(worst)}</span></div>`;
  }

  // Бот-стратегии одной строкой.
  let botLine = '';
  try {
    const { rows } = buildStrategiesPayload();
    const botNet = rows
      .filter((r) => !MY_SOURCES.has(r.id) && (r.status === 'live' || r.status === 'paper'))
      .reduce((s, r) => s + (r.pnl?.day || 0), 0);
    botLine = `Bots (autonomous) today: <strong style="color:${botNet >= 0 ? C.green : C.red}">${fmtUsd(botNet)}</strong>`;
  } catch (err) {
    logger.warn(`[mailDigest] bot line failed: ${err.message}`);
  }

  // Сводка одной спокойной строкой.
  const payoffColor = !losses.length ? C.body : payoff >= 1 ? C.green : C.red;
  const summaryLine =
    `<div style="font-size:16px;line-height:1.6;color:${C.body};margin-bottom:4px">` +
    `<strong style="color:${C.text}">${n}</strong> ${n === 1 ? 'trade' : 'trades'} · ` +
    `win <strong style="color:${C.text}">${winPct}%</strong> · ` +
    `payoff <strong style="color:${payoffColor}">${payoffStr}</strong>` +
    (losses.length && payoff < 1
      ? ` <span style="color:${C.mut}">(at this payoff you need win ≥ ${Math.round((1 / (1 + payoff)) * 100)}% to be green)</span>`
      : '') +
    `</div>` +
    (split ? `<div style="font-size:15px;color:${C.mut};margin-bottom:2px">${split}</div>` : '');

  // Всё в один контейнер 600px, светлый фон.
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:${C.text}">` +

    // Заголовок
    `<div style="font-size:13px;font-weight:600;color:${C.accent};text-transform:uppercase;letter-spacing:.08em">Helm · daily wrap</div>` +
    `<div style="font-size:26px;font-weight:700;color:${C.text};margin:4px 0 2px">${fmtDate(now)}</div>` +
    `<div style="font-size:16px;color:${C.mut};margin-bottom:18px">Day result: <strong style="color:${net >= 0 ? C.green : C.red};font-size:18px">${fmtUsd(net)}</strong></div>` +

    summaryLine +
    extremes +

    // Бот одной строкой
    (botLine ? `<div style="font-size:14px;color:${C.mut};margin-top:22px;padding-top:16px;border-top:1px solid ${C.border}">${botLine}</div>` : '') +

    // Подпись
    `<div style="font-size:13px;color:${C.faint};line-height:1.6;margin-top:18px">` +
    `Numbers come from HL fills (the same source as the dashboard Ledger), not from the history table. Trade review lives in the journal. ` +
    // Ссылка на журнал появляется, только если известен внешний адрес дашборды:
    // внутренний http://hl-paper-scanner:3010 из письма не открыть.
    (PUBLIC_URL ? `<a href="${PUBLIC_URL}/journal" style="color:${C.accent};text-decoration:none">Open the journal →</a>` : '') +
    `</div>` +

    `</div>`
  );
}

/** Собирает и шлёт итог. Возвращает true если письмо ушло. */
export async function sendDailyDigest(now = Date.now()) {
  if (!isMailEnabled()) {
    logger.info('[mailDigest] skipped — mail not configured');
    return false;
  }
  const date = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', timeZone: 'Europe/Warsaw',
  }).format(now);
  const html = await buildDigestHtml(now);
  if (!html) {
    logger.info('[mailDigest] skipped — no trades to review today');
    return false;
  }
  const ok = await sendMail({ subject: `Helm · daily wrap ${date}`, html });
  logger.info(`[mailDigest] daily digest ${ok ? 'sent' : 'failed'}`);
  return ok;
}
