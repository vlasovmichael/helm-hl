// ─────────────────────────────────────────────────
//  Tax Outbox — публикация событий для tax-manager
// ─────────────────────────────────────────────────
// Идемпотентная вставка в tax_outbox. Дубликаты по event_id — no-op.
// Драйнит src/modules/taxCollector/pusher.js по cron каждые 15 мин.

import { getRawDb } from '../../core/database.js';

const VALID_KINDS = new Set([
  'revenue.subscription',
  'revenue.one_time',
  'refund.subscription',
  'cost.infra',
  'crypto.cost',
  'crypto.revenue',
]);

/**
 * @param {Object} ev
 * @param {string} ev.event_id      — глобально уникальный, стабильный (PK внешней системы)
 * @param {string|Date} ev.occurred_at — когда событие реально случилось
 * @param {string} ev.kind          — см. VALID_KINDS
 * @param {number} ev.amount        — в исходной валюте (НЕ центы)
 * @param {string} ev.currency      — 'PLN' | 'USD' | 'EUR'
 * @param {string} [ev.counterparty]
 * @param {string} [ev.doc_no]
 * @param {Object} [ev.raw]         — opaque audit blob
 */
export function emitTaxEvent(ev) {
  if (!ev?.event_id) throw new Error('emitTaxEvent: event_id required');
  if (!VALID_KINDS.has(ev.kind)) {
    throw new Error(`emitTaxEvent: unknown kind "${ev.kind}"`);
  }

  const occurredAtIso = ev.occurred_at instanceof Date
    ? ev.occurred_at.toISOString()
    : new Date(ev.occurred_at).toISOString();

  getRawDb()
    .prepare(`
      INSERT OR IGNORE INTO tax_outbox
        (event_id, occurred_at, kind, amount, currency, counterparty, doc_no, raw)
      VALUES (@event_id, @occurred_at, @kind, @amount, @currency, @counterparty, @doc_no, @raw)
    `)
    .run({
      event_id:     ev.event_id,
      occurred_at:  occurredAtIso,
      kind:         ev.kind,
      amount:       Number(ev.amount),
      currency:     String(ev.currency).toUpperCase(),
      counterparty: ev.counterparty || null,
      doc_no:       ev.doc_no || null,
      raw:          ev.raw ? JSON.stringify(ev.raw) : null,
    });
}
