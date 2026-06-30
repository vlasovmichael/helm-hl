// ─────────────────────────────────────────────────
//  Ежедневный разбор сделок (коуч-дайджест за сутки)
// ─────────────────────────────────────────────────
// Не таблица-мусор, а РАЗБОР твоих сделок в духе «что хорошо / что плохо»:
//   • шапка-сводка: итог дня, win%, реальный payoff, «урок дня»;
//   • карточка на каждую ТВОЮ сделку (рука/adopt/manual_paper) с коуч-вердиктом —
//     вход по тренду 1ч или против, отдал ли прибыль (MFE-leak), активный выход
//     vs жёсткий стоп, просадка (MAE);
//   • бот-стратегии — одной строкой (только итог), чтобы не зашумлять.
//
// Разбор детерминированный (по записанным полям сделки, без LLM — нечего
// галлюцинировать). Дизайн — светлая карточная вёрстка как в appointment_tg_bot
// (Stripe-style), крупный шрифт, инлайн-стили (email-safe).
//
// Шлётся cron'ом 21:05 (см. index.js). Fail-soft: sendMail сам тихо no-op.

import { logger } from '../core/logger.js';
import { sendMail, isMailEnabled } from '../core/mail.js';
import { getHistorySince } from '../core/database.js';
import { buildStrategiesPayload } from './dashboard/strategiesView.js';

const DAY_MS = 86_400_000;

// «Мои» сделки — те, где решение принимал я (рука/нянька/бумажный журнал),
// а не автономный бот. Их и разбираем карточками.
const MY_STRATEGIES = new Set(['adopt', 'manual_paper']);
const MY_REASONS = new Set(['manual_close', 'offline_manual_close', 'manual']);

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
function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const d = abs >= 100 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 7;
  return v.toFixed(d);
}
function fmtHold(sec) {
  if (!sec || !Number.isFinite(sec)) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}
function fmtDate(now) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'long', timeZone: 'Europe/Warsaw',
  }).format(now);
}

// ── Коуч-разбор одной сделки → { good[], bad[], warn[], verdict } ──
function analyzeTrade(t) {
  const good = [], bad = [], warn = [];
  const side = t.side === 'long' ? 'long' : 'short';
  const pnl = Number(t.realized_pnl) || 0;
  const won = pnl > 0;
  const trend1h = t.entry_trend_1h_pct;
  const mfe = t.mfe_usd, mae = t.mae_pct;
  const reason = t.reason || '';

  // 1. Тренд 1ч на входе — главный леак «не лонгуй против тренда».
  if (trend1h != null && Number.isFinite(trend1h)) {
    const against = (side === 'long' && trend1h < -0.3) || (side === 'short' && trend1h > 0.3);
    const along = (side === 'long' && trend1h > 0.3) || (side === 'short' && trend1h < -0.3);
    if (against) {
      bad.push(`Вход против тренда 1ч (тренд шёл ${trend1h > 0 ? '↑' : '↓'} ${Math.abs(trend1h).toFixed(1)}%) — главный леак`);
    } else if (along) {
      good.push(`Вход по тренду 1ч (${trend1h > 0 ? '↑' : '↓'} ${Math.abs(trend1h).toFixed(1)}%)`);
    }
  }

  // 2. Отдал прибыль (MFE-leak) — был в плюсе, вышел хуже.
  if (mfe != null && Number.isFinite(mfe) && mfe > 0.3) {
    const giveback = mfe - pnl;
    if (pnl < 0) {
      bad.push(`Был в плюсе +$${mfe.toFixed(2)}, вышел в минус — прибыль превратилась в убыток`);
    } else if (giveback >= 0.5 && giveback > mfe * 0.4) {
      bad.push(`Был +$${mfe.toFixed(2)}, забрал ${fmtUsd(pnl)} — отдал $${giveback.toFixed(2)} прибыли`);
    }
  }

  // 3. Выход: активный (рука/трейл) vs жёсткий стоп.
  if (/sl_trigger|_sl$|^stop$|^sl$/.test(reason) && !won) {
    if (pnl <= -1.5) {
      warn.push(`Добежал до жёсткого стопа (${fmtUsd(pnl)}) — стоп стоял далеко, убыток крупный`);
    } else {
      good.push(`Стоп сработал — убыток ограничен (дисциплина)`);
    }
  } else if (/manual_close|trail_tp|adopt_trail/.test(reason) && won) {
    good.push(`Активный выход — забрал прибыль, не довёл до разворота`);
  } else if (/breakeven/.test(reason)) {
    good.push(`Вышел в безубыток — защитил позицию`);
  }

  // 4. Сидел в большой просадке (MAE) при выигрыше — повезло, риск был выше плана.
  if (won && mae != null && Number.isFinite(mae) && mae <= -2.5) {
    warn.push(`Сидел в просадке ${mae.toFixed(1)}% — риск был выше плана, в этот раз пронесло`);
  }

  // Вердикт одной фразой.
  let verdict;
  if (bad.length) verdict = won
    ? 'Сделка в плюс, но по процессу есть что чинить — повезло, не повторяй.'
    : 'Тут и есть утечка денег. Запомни ошибку, не сумму.';
  else if (won) verdict = 'Чистая сделка по процессу — так и держи.';
  else verdict = 'Минус по правилам — это норма дистанции, процесс верный.';

  return { good, bad, warn, verdict };
}

// ── Агрегат коуч-разбора по всем «моим» сделкам за сутки ──
// Считаем категории (а не рисуем карточку на каждую сделку — без пестроты).
function coachAggregate(trades) {
  const cat = {
    alongTrend: 0, activeExit: 0, breakeven: 0, stopDiscipline: 0,
    againstTrend: 0, giveback: 0, farStop: 0, heat: 0,
  };
  for (const t of trades) {
    const { good, bad, warn } = analyzeTrade(t);
    if (good.some((x) => x.includes('по тренду'))) cat.alongTrend++;
    if (good.some((x) => x.includes('Активный выход'))) cat.activeExit++;
    if (good.some((x) => x.includes('безубыток'))) cat.breakeven++;
    if (good.some((x) => x.includes('Стоп сработал'))) cat.stopDiscipline++;
    if (bad.some((x) => x.includes('против тренда'))) cat.againstTrend++;
    if (bad.some((x) => x.includes('отдал') || x.includes('превратилась'))) cat.giveback++;
    if (warn.some((x) => x.includes('жёсткого стопа'))) cat.farStop++;
    if (warn.some((x) => x.includes('просадке'))) cat.heat++;
  }
  return cat;
}

// Строка разбора: значок + «что» + счётчик. Спокойная, без заливки-плашки.
function coachLine(mark, color, text, count) {
  return (
    `<tr><td style="padding:7px 0;border-top:1px solid ${C.border}">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>` +
    `<td valign="top" style="width:22px;font-size:16px;font-weight:700;color:${color}">${mark}</td>` +
    `<td style="font-size:16px;line-height:1.45;color:${C.body}">${esc(text)}</td>` +
    `<td align="right" valign="top" style="font-size:15px;font-weight:700;color:${C.faint};white-space:nowrap">×${count}</td>` +
    `</tr></table></td></tr>`
  );
}

// ── «Урок дня»: самый частый косяк за сутки ──
function lessonOfDay(myTrades) {
  const counts = { againstTrend: 0, giveback: 0, farStop: 0, heat: 0 };
  for (const t of myTrades) {
    const { bad, warn } = analyzeTrade(t);
    if (bad.some((x) => x.includes('против тренда'))) counts.againstTrend++;
    if (bad.some((x) => x.includes('отдал') || x.includes('превратилась'))) counts.giveback++;
    if (warn.some((x) => x.includes('жёсткого стопа'))) counts.farStop++;
    if (warn.some((x) => x.includes('просадке'))) counts.heat++;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] === 0) return 'Сегодня по процессу чисто — так и держи. Терпение на вход важнее количества сделок.';
  const msg = {
    againstTrend: 'Чаще всего сегодня входил против тренда 1ч. Правило №1: над 200-й — только лонги, под — только шорты. Цена летит сквозь линию красными свечами — не лезь.',
    giveback: 'Чаще всего сегодня отдавал прибыль обратно. Был в плюсе — фиксируй или подтягивай стоп в безубыток. Payoff важнее винрейта.',
    farStop: 'Сегодня несколько сделок добежали до жёсткого стопа с крупным минусом. Стоп ставь за структуру, а размер считай от него — тогда −1R маленький.',
    heat: 'Сегодня сидел в больших просадках. Пронесло — но это не план. Стоп ближе, размер меньше.',
  }[top[0]];
  return msg;
}

/** HTML тела разбора за последние 24ч. `rows` — для превью/тестов (иначе из БД). */
export function buildDigestHtml(now = Date.now(), rows = null) {
  const since = now - DAY_MS;
  const all = rows || getHistorySince(since) || [];

  // «Мои» сделки для карточек.
  const myTrades = all.filter(
    (t) => MY_STRATEGIES.has(t.strategy_id) || MY_REASONS.has(t.reason),
  );

  // Сводка дня по «моим».
  const n = myTrades.length;
  const wins = myTrades.filter((t) => (t.realized_pnl || 0) > 0);
  const losses = myTrades.filter((t) => (t.realized_pnl || 0) < 0);
  const net = myTrades.reduce((s, t) => s + (t.realized_pnl || 0), 0);
  const winPct = n ? Math.round((wins.length / n) * 100) : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.realized_pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.realized_pnl, 0) / losses.length) : 0;
  const payoff = avgLoss ? (avgWin / avgLoss) : (avgWin ? Infinity : 0);
  const payoffStr = Number.isFinite(payoff) ? payoff.toFixed(2) : (avgWin ? '∞' : '—');

  // Бот-стратегии одной строкой.
  let botLine = '';
  try {
    const { rows } = buildStrategiesPayload();
    const botNet = rows
      .filter((r) => !MY_STRATEGIES.has(r.id) && (r.status === 'live' || r.status === 'paper'))
      .reduce((s, r) => s + (r.pnl?.day || 0), 0);
    botLine = `Боты (автономные) за день: <strong style="color:${botNet >= 0 ? C.green : C.red}">${fmtUsd(botNet)}</strong>`;
  } catch (err) {
    logger.warn(`[mailDigest] bot line failed: ${err.message}`);
  }

  // Агрегат разбора (без покарточно — спокойно).
  const cat = coachAggregate(myTrades);
  const goodRows =
    (cat.alongTrend ? coachLine('✓', C.green, 'Вход по тренду 1ч', cat.alongTrend) : '') +
    (cat.activeExit ? coachLine('✓', C.green, 'Активный выход — забрал прибыль', cat.activeExit) : '') +
    (cat.stopDiscipline ? coachLine('✓', C.green, 'Стоп сработал — убыток ограничен', cat.stopDiscipline) : '') +
    (cat.breakeven ? coachLine('✓', C.green, 'Вышел в безубыток', cat.breakeven) : '');
  const badRows =
    (cat.againstTrend ? coachLine('✕', C.red, 'Вход против тренда 1ч — главный леак', cat.againstTrend) : '') +
    (cat.giveback ? coachLine('✕', C.red, 'Отдал прибыль обратно (был в плюсе)', cat.giveback) : '') +
    (cat.farStop ? coachLine('!', C.amber, 'Добежал до далёкого стопа — крупный минус', cat.farStop) : '') +
    (cat.heat ? coachLine('!', C.amber, 'Сидел в большой просадке — риск выше плана', cat.heat) : '');

  const section = (title, body) =>
    `<div style="font-size:13px;font-weight:700;color:${C.faint};text-transform:uppercase;letter-spacing:.05em;margin:22px 0 4px">${title}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>`;

  // Сводка одной спокойной строкой (без пёстрых плиток).
  const payoffColor = !n || !losses.length ? C.body : payoff >= 1 ? C.green : C.red;
  const summaryLine =
    `<div style="font-size:16px;line-height:1.6;color:${C.body};margin-bottom:4px">` +
    `<strong style="color:${C.text}">${n}</strong> ${n === 1 ? 'сделка' : 'сделок'} · ` +
    `win <strong style="color:${C.text}">${n ? winPct + '%' : '—'}</strong> · ` +
    `payoff <strong style="color:${payoffColor}">${payoffStr}</strong>` +
    (n && losses.length && payoff < 1
      ? ` <span style="color:${C.mut}">(чтобы быть в плюсе при таком payoff нужен win ≥ ${Math.round((1 / (1 + payoff)) * 100)}%)</span>`
      : '') +
    `</div>`;

  // Всё в один контейнер 600px, светлый фон.
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:${C.text}">` +

    // Заголовок
    `<div style="font-size:13px;font-weight:600;color:${C.accent};text-transform:uppercase;letter-spacing:.08em">Helm · коуч-разбор</div>` +
    `<div style="font-size:26px;font-weight:700;color:${C.text};margin:4px 0 2px">${fmtDate(now)}</div>` +
    `<div style="font-size:16px;color:${C.mut};margin-bottom:18px">Итог дня: <strong style="color:${net >= 0 ? C.green : C.red};font-size:18px">${fmtUsd(net)}</strong></div>` +

    summaryLine +

    // Урок дня — единственный акцентный блок
    `<table role="presentation" width="100%" style="background:${C.amberBg};border-radius:10px;margin:18px 0 4px">` +
    `<tr><td style="padding:16px 20px">` +
    `<div style="font-size:12px;font-weight:700;color:${C.amber};text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Урок дня</div>` +
    `<div style="font-size:17px;line-height:1.55;color:${C.text}">${esc(lessonOfDay(myTrades))}</div>` +
    `</td></tr></table>` +

    // Разбор: что хорошо / что чинить (или пустой день)
    (n
      ? (goodRows ? section('Что по процессу хорошо', goodRows) : '') +
        (badRows ? section('Что чинить', badRows) : '')
      : `<div style="font-size:16px;line-height:1.6;color:${C.body};margin-top:22px">` +
        `Сегодня сделок не было. Пустой день — тоже результат: лучшая сделка часто та, которую не сделал.</div>`) +

    // Бот одной строкой
    (botLine ? `<div style="font-size:14px;color:${C.mut};margin-top:22px;padding-top:16px;border-top:1px solid ${C.border}">${botLine}</div>` : '') +

    // Подпись
    `<div style="font-size:13px;color:${C.faint};line-height:1.6;margin-top:18px">` +
    `Разбор по фактам сделки (тренд 1ч, MFE/MAE, причина выхода) — без угадывания. Цель — проверять процесс, а не результат. ` +
    `<a href="https://dashboard.example.com/journal.html" style="color:${C.accent};text-decoration:none">Открыть журнал →</a></div>` +

    `</div>`
  );
}

/** Собирает и шлёт разбор. Возвращает true если письмо ушло. */
export async function sendDailyDigest(now = Date.now()) {
  if (!isMailEnabled()) {
    logger.info('[mailDigest] skipped — mail not configured');
    return false;
  }
  const date = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', timeZone: 'Europe/Warsaw',
  }).format(now);
  const ok = await sendMail({ subject: `Helm · разбор сделок ${date}`, html: buildDigestHtml(now) });
  logger.info(`[mailDigest] daily review ${ok ? 'sent' : 'failed'}`);
  return ok;
}
