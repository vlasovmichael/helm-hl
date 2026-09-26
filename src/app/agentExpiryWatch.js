// ─────────────────────────────────────────────────
//  Срок API-агента Hyperliquid
// ─────────────────────────────────────────────────
// Срок берётся с биржи (extraAgents) по адресу ключа из HL_AGENT_PRIVATE_KEY:
// перевыпуск агента не требует править даты руками.

import { Wallet } from 'ethers';

import { config } from '../core/config.js';
import { hlInfo, HL_PRIORITY } from '../core/hlClient.js';
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
      detail: 'HL API agent expiry is missing or invalid',
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

/** Адрес агента из его ключа; null — ключа агента нет или он битый. */
export function agentAddress(privateKey) {
  if (!privateKey) return null;
  try {
    return new Wallet(privateKey).address.toLowerCase();
  } catch {
    return null;
  }
}

/** Срок агента из ответа extraAgents биржи (ISO); null — такого агента на аккаунте нет. */
export function agentValidUntil(agents, address) {
  const row = (Array.isArray(agents) ? agents : []).find((a) => String(a?.address).toLowerCase() === address);
  const ms = Number(row?.validUntil);
  return row && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Снимок срока по живому списку агентов биржи. */
export function liveAgentSnapshot(agents, address, now = Date.now()) {
  const validUntil = agentValidUntil(agents, address);
  if (validUntil) return agentExpirySnapshot(validUntil, now);
  return {
    status: 'fail',
    detail: `HL API agent ${address.slice(0, 8)}… is not registered on the account — orders will be rejected`,
    daysLeft: null,
    expiryDate: null,
    missing: true,
  };
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
  const address = agentAddress(config.wallet.agentPrivateKey);
  if (!address) {
    note('hl_agent_expiry', {
      category: 'consistency',
      status: 'warn',
      detail: 'no agent key — trading with the main wallet key',
      ttlMs: CHECK_EVERY_MS * 2,
    });
    return null;
  }
  const agents = await hlInfo(
    { type: 'extraAgents', user: config.wallet.address },
    { label: 'agent-expiry', priority: HL_PRIORITY.LOW },
  );
  const snapshot = liveAgentSnapshot(agents, address, now);
  note('hl_agent_expiry', {
    category: 'consistency',
    status: snapshot.status,
    detail: snapshot.detail,
    ttlMs: CHECK_EVERY_MS * 2,
  });

  const days = agentExpiryAlert(snapshot);
  if (days == null && !snapshot.missing) return snapshot;

  const title = snapshot.missing ? '🚨 API-агент HL не найден на бирже' : alertTitle(snapshot, days);
  const wasSent = sent.has(title) || getNotifications(100).some((n) => n.title === title);
  if (wasSent) return snapshot;

  const delivered = await fireNtfy({
    title,
    message: snapshot.missing
      ? 'Ключа агента из .env нет среди агентов аккаунта: бот не сможет ставить защитные ордера. Выпустите агента и обновите HL_AGENT_PRIVATE_KEY.'
      : `API-агент действует до ${snapshot.expiryDate}. Обновите агентский ключ до этой даты: после истечения бот не сможет ставить защитные ордера.`,
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
