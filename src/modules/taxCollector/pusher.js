// ─────────────────────────────────────────────────
//  Tax Pusher — drains tax_outbox → tax-manager
// ─────────────────────────────────────────────────
// Запускается раз в 15 мин (см. cron в src/index.js).
// Также можно гонять вручную: `node src/modules/taxCollector/pusher.js`.
//
// Retry policy:
//   200 OK         → mark pushed_at
//   4xx (не 401)   → poison pill, mark pushed_at + last_error, не ретраим
//   401/5xx/network → leave pushed_at NULL, push_attempts++, ретрай в след. cron

import axios from 'axios';
import crypto from 'crypto';
import { initDB, getRawDb } from '../../core/database.js';
import { logger } from '../../core/logger.js';

const BATCH = parseInt(process.env.TAX_PUSH_BATCH || '100', 10);

function readEnv() {
  return {
    URL:     process.env.TAX_MANAGER_URL,
    PROJECT: process.env.TAX_PROJECT,
    SECRET:  process.env.TAX_HMAC_SECRET,
  };
}

export function isConfigured() {
  const { URL, PROJECT, SECRET } = readEnv();
  return Boolean(URL && PROJECT && SECRET);
}

function sign(body, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { ts: String(ts), sig };
}

async function pushOne(row, env) {
  const payload = {
    project:      env.PROJECT,
    event_id:     row.event_id,
    occurred_at:  row.occurred_at,
    kind:         row.kind,
    amount:       parseFloat(row.amount),
    currency:     row.currency,
    counterparty: row.counterparty || undefined,
    doc_no:       row.doc_no || undefined,
    raw:          row.raw ? JSON.parse(row.raw) : undefined,
  };
  const body = JSON.stringify(payload);
  const { ts, sig } = sign(body, env.SECRET);
  const r = await axios.post(`${env.URL}/events`, body, {
    timeout: 10_000,
    headers: {
      'Content-Type':    'application/json',
      'X-Tax-Timestamp': ts,
      'X-Tax-Signature': sig,
    },
    validateStatus: () => true,
  });
  return { status: r.status, body: r.data };
}

/**
 * Драйнит outbox. Fail-soft: ничего не бросает наружу.
 * @returns {Promise<{ pushed:number, poison:number, retry:number, total:number }>}
 */
export async function drainOutbox() {
  const env = readEnv();
  if (!env.URL || !env.PROJECT || !env.SECRET) {
    logger.debug('[TaxPusher] не сконфигурирован (TAX_MANAGER_URL/PROJECT/HMAC_SECRET) — skip');
    return { pushed: 0, poison: 0, retry: 0, total: 0 };
  }

  const db = getRawDb();
  const rows = db.prepare(`
    SELECT id, event_id, occurred_at, kind, amount, currency, counterparty, doc_no, raw
      FROM tax_outbox WHERE pushed_at IS NULL ORDER BY created_at ASC LIMIT ?
  `).all(BATCH);

  if (rows.length === 0) {
    logger.debug('[TaxPusher] nothing to push');
    return { pushed: 0, poison: 0, retry: 0, total: 0 };
  }

  const markPushed = db.prepare(
    `UPDATE tax_outbox SET pushed_at = ?, last_error = NULL WHERE id = ?`,
  );
  const markPoison = db.prepare(
    `UPDATE tax_outbox SET pushed_at = ?, push_attempts = push_attempts + 1, last_error = ? WHERE id = ?`,
  );
  const markRetry = db.prepare(
    `UPDATE tax_outbox SET push_attempts = push_attempts + 1, last_error = ? WHERE id = ?`,
  );

  let pushed = 0, poison = 0, retry = 0;
  for (const row of rows) {
    let r;
    try {
      r = await pushOne(row, env);
    } catch (err) {
      retry++;
      markRetry.run(`network: ${err.message}`.slice(0, 500), row.id);
      continue;
    }
    if (r.status === 200) {
      pushed++;
      markPushed.run(Date.now(), row.id);
    } else if (r.status >= 400 && r.status < 500 && r.status !== 401) {
      poison++;
      markPoison.run(
        Date.now(),
        `poison ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`,
        row.id,
      );
    } else {
      retry++;
      markRetry.run(
        `http ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`,
        row.id,
      );
    }
  }

  logger.info(`[TaxPusher] pushed=${pushed} poison=${poison} retry=${retry} (of ${rows.length})`);
  return { pushed, poison, retry, total: rows.length };
}

// Standalone mode: `node src/modules/taxCollector/pusher.js`
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dotenv = await import('dotenv');
  dotenv.config();
  initDB();
  drainOutbox()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(`[TaxPusher] crashed: ${err.message}`);
      process.exit(1);
    });
}
