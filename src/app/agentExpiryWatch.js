// ─────────────────────────────────────────────────
//  Срок API-агента Hyperliquid
// ─────────────────────────────────────────────────
// Info API отдаёт роль адреса, но не дату окончания API-wallet. Поэтому срок
// берётся из HL_AGENT_EXPIRES_AT и остаётся видимым в health-плашке.

import { config } from '../core/config.js';
import { note } from '../core/healthRegistry.js';
import { logger } from '../core/logger.js';
import { fireNtfy } from '../core/ntfy.js';
import { getNotifications } from '../core/notifyLog.js';

const CHECK_EVERY_MS = 6 * 60 * 60_000;
const ALERT_DAYS = new Set([14, 7, 2]);

let timer = null;
const sent = new Set();

/** Дата без времени означает «действует включительно до конца UTC-дня». */
export function parseAgentExpiry(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    const at = Date.UTC(year, month - 1, day + 1);
    return Number.isFinite(at) ? { at, date: text } : null;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return { at, date: new Date(at).toISOString().slice(0, 10) };
}

function utcDay(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Чистый снимок срока: одинаково используется плашкой, сторожем и тестами. */
export function agentExpirySnapshot(value, now = Date.now()) {
  const expiry = parseAgentExpiry(value);
  if (!expiry) {
    return {
      status: 'fail',
      detail: 'HL_AGENT_EXPIRES_AT is missing or invalid',
      daysLeft: null,
      expiryDate: null,
    };
  }

  const daysLeft = Math.round((Date.parse(`${expiry.date}T00:00:00.000Z`) - utcDay(now)) / 86_400_000);
  if (now >= expiry.at) {
    return { status: 'fail', detail: `HL API agent expired on ${expiry.date}`, daysLeft, expiryDate: expiry.date };
  }
  if (daysLeft <= 2) {
    return { status: 'fail', detail: `HL API agent expires in ${daysLeft}d (${expiry.date})`, daysLeft, expiryDate: expiry.date };
  }
  if (daysLeft <= 14) {
    return { status: 'warn', detail: `HL API agent expires in ${daysLeft}d (${expiry.date})`, daysLeft, expiryDate: expiry.date };
  }
  return { status: 'pass', detail: `HL API agent valid until ${expiry.date} (${daysLeft}d)`, daysLeft, expiryDate: expiry.date };
}

export function agentExpiryAlert(snapshot) {
  return Number.isInteger(snapshot.daysLeft) && ALERT_DAYS.has(snapshot.daysLeft)
    ? snapshot.daysLeft
    : null;
}

function alertTitle(snapshot, days) {
  return `🚨 API-агент HL: ${days} д. до ${snapshot.expiryDate}`;
}

async function check(now = Date.now()) {
  const snapshot = agentExpirySnapshot(config.wallet.agentExpiresAt, now);
  note('hl_agent_expiry', {
    category: 'consistency',
    status: snapshot.status,
    detail: snapshot.detail,
    ttlMs: CHECK_EVERY_MS * 2,
  });

  const days = agentExpiryAlert(snapshot);
  if (days == null) return snapshot;

  const title = alertTitle(snapshot, days);
  const wasSent = sent.has(title) || getNotifications(100).some((n) => n.title === title);
  if (wasSent) return snapshot;

  const delivered = await fireNtfy({
    title,
    message: `API-агент действует до ${snapshot.expiryDate}. Обновите агентский ключ до этой даты: после истечения бот не сможет ставить защитные ордера.`,
    tags: ['rotating_light', 'key'],
    urgent: true,
    now,
  });
  if (delivered) sent.add(title);
  return snapshot;
}

/** Запускает сторожа только там, где агент реально может ставить ордера. */
export function startAgentExpiryWatch() {
  if (!config.isProduction || timer) return;
  check().catch((err) => logger.warn(`[AgentExpiry] check failed: ${err.message}`));
  timer = setInterval(() => {
    check().catch((err) => logger.warn(`[AgentExpiry] check failed: ${err.message}`));
  }, CHECK_EVERY_MS);
  timer.unref?.();
  logger.info('[AgentExpiry] started — urgent за 14, 7 и 2 дня');
}

export function stopAgentExpiryWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}
