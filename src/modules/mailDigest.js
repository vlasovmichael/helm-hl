// ─────────────────────────────────────────────────
//  Ежедневный почтовый дайджест (отчёт за сутки)
// ─────────────────────────────────────────────────
// «Туда можно отправлять всякие отчёты, статистику» — одно письмо в день:
//   • какие сигналы/пуши прилетели за сутки (из notifyLog),
//   • сводка по стратегиям (день/неделя/всего P&L, win-rate) — из того же
//     payload, что таблица Strategies на дашборде.
//
// Шлётся cron'ом (см. index.js). Fail-soft: sendMail сам тихо no-op, если почта
// не настроена; здесь ловим всё, чтобы крон не падал.

import { logger } from '../core/logger.js';
import { sendMail, isMailEnabled } from '../core/mail.js';
import { getNotificationsSince } from '../core/notifyLog.js';
import { buildStrategiesPayload } from './dashboard/strategiesView.js';

const DAY_MS = 86_400_000;

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
}

function fmtTime(ts) {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw',
  }).format(ts);
}

/** HTML тела дайджеста за последние 24ч. */
export function buildDigestHtml(now = Date.now()) {
  const since = now - DAY_MS;
  const notes = getNotificationsSince(since);

  const notesHtml = notes.length
    ? notes
        .slice()
        .reverse()
        .map(
          (n) =>
            `<tr><td style="padding:4px 8px;color:#888;white-space:nowrap">${fmtTime(n.ts)}</td>` +
            `<td style="padding:4px 8px">${esc(n.title)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="2" style="padding:8px;color:#888">За сутки пушей не было.</td></tr>';

  let stratHtml = '';
  try {
    const { rows } = buildStrategiesPayload();
    const active = rows.filter((r) => r.status === 'live' || r.status === 'paper');
    stratHtml = active.length
      ? active
          .map((r) => {
            const e = r.edge || {};
            const wr = e.winRate != null ? `${(e.winRate * 100).toFixed(0)}%` : '—';
            return (
              `<tr><td style="padding:4px 8px">${esc(r.label)}</td>` +
              `<td style="padding:4px 8px;color:#888">${esc(r.status)}</td>` +
              `<td style="padding:4px 8px;text-align:right">${fmtUsd(r.pnl?.day)}</td>` +
              `<td style="padding:4px 8px;text-align:right">${fmtUsd(r.pnl?.week)}</td>` +
              `<td style="padding:4px 8px;text-align:right">${fmtUsd(r.pnl?.all)}</td>` +
              `<td style="padding:4px 8px;text-align:right;color:#888">${e.trades ?? 0}/${wr}</td></tr>`
            );
          })
          .join('')
      : '<tr><td colspan="6" style="padding:8px;color:#888">Нет активных стратегий.</td></tr>';
  } catch (err) {
    logger.warn(`[mailDigest] strategies block failed: ${err.message}`);
    stratHtml = '<tr><td colspan="6" style="padding:8px;color:#888">—</td></tr>';
  }

  const date = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'long', timeZone: 'Europe/Warsaw',
  }).format(now);

  return (
    `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#222">` +
    `<h2 style="margin:0 0 4px">Helm · дайджест за ${date}</h2>` +
    `<p style="margin:0 0 16px;color:#888">Пушей за сутки: ${notes.length}</p>` +
    `<h3 style="margin:16px 0 4px">Стратегии</h3>` +
    `<table style="border-collapse:collapse;width:100%;font-size:13px">` +
    `<thead><tr style="text-align:left;color:#888;border-bottom:1px solid #ddd">` +
    `<th style="padding:4px 8px">Стратегия</th><th style="padding:4px 8px">Статус</th>` +
    `<th style="padding:4px 8px;text-align:right">День</th><th style="padding:4px 8px;text-align:right">Неделя</th>` +
    `<th style="padding:4px 8px;text-align:right">Всего</th><th style="padding:4px 8px;text-align:right">Сделок/WR</th>` +
    `</tr></thead><tbody>${stratHtml}</tbody></table>` +
    `<h3 style="margin:20px 0 4px">Пуши за сутки</h3>` +
    `<table style="border-collapse:collapse;width:100%;font-size:13px"><tbody>${notesHtml}</tbody></table>` +
    `</div>`
  );
}

/** Собирает и шлёт дайджест. Возвращает true если письмо ушло. */
export async function sendDailyDigest(now = Date.now()) {
  if (!isMailEnabled()) {
    logger.info('[mailDigest] skipped — mail not configured');
    return false;
  }
  const date = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', timeZone: 'Europe/Warsaw',
  }).format(now);
  const ok = await sendMail({ subject: `Helm · дайджест ${date}`, html: buildDigestHtml(now) });
  logger.info(`[mailDigest] daily digest ${ok ? 'sent' : 'failed'}`);
  return ok;
}
