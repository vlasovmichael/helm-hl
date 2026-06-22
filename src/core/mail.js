// ─────────────────────────────────────────────────
//  Почтовый seam — self-hosted Listmonk /api/tx
// ─────────────────────────────────────────────────
// Один транзакционный POST в Listmonk. Тот же подход, что у соседних проектов
// (atlas/digest, appointment_tg_bot): не сырой SMTP, а Listmonk /api/tx с
// Basic-auth и заранее заведённым tx-шаблоном (содержит {{ .Tx.Data.body_html | Safe }}).
//
// Fail-soft по образцу ntfy: если url/creds/template/to не заданы — isMailEnabled()
// = false и sendMail() тихо резолвит false. Никогда не бросает (письмо — не
// критичный путь, ошибка не должна валить бота/тик).
//
// Получатель один и фиксированный (сам оператор, MAIL_TO) — подписчиков не ведём,
// шлём прямой subscriber_email. Создаём подписчика лениво один раз (Listmonk
// требует, чтобы адрес существовал в базе для /api/tx).

import { config } from './config.js';
import { logger } from './logger.js';

function authHeader() {
  const { user, pass } = config.mail;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** Все ли env'ы почты заданы. */
export function isMailEnabled() {
  const m = config.mail;
  return !!(m.listmonkUrl && m.user && m.pass && m.templateId && m.to);
}

let _subscriberEnsured = false;

/**
 * Лениво заводит MAIL_TO как подписчика Listmonk (нужно для /api/tx). Идемпотентно:
 * 409/«already exists» считаем успехом. Кэшируем, чтобы не дёргать на каждое письмо.
 */
async function ensureSubscriber() {
  if (_subscriberEnsured) return true;
  const { listmonkUrl, to } = config.mail;
  try {
    const res = await fetch(`${listmonkUrl}/api/subscribers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
      body: JSON.stringify({ email: to, name: to, status: 'enabled', lists: [] }),
    });
    if (res.ok || res.status === 409) {
      _subscriberEnsured = true;
      return true;
    }
    const text = await res.text();
    if (res.status === 400 && /already|exist|duplicate/i.test(text)) {
      _subscriberEnsured = true;
      return true;
    }
    logger.warn(`[mail] ensureSubscriber ${res.status}: ${text.slice(0, 160)}`);
    return false;
  } catch (err) {
    logger.warn(`[mail] ensureSubscriber failed: ${err.message}`);
    return false;
  }
}

/**
 * Шлёт одно транзакционное письмо через Listmonk /api/tx. Тело передаётся в
 * data.body_html — tx-шаблон выводит его через {{ .Tx.Data.body_html | Safe }}.
 * Никогда не бросает.
 *
 * @param {{subject:string, html:string}} opts
 * @returns {Promise<boolean>} true если запрос ушёл (2xx), иначе false
 */
export async function sendMail({ subject, html } = {}) {
  if (!isMailEnabled()) return false;
  const { listmonkUrl, templateId, to, from } = config.mail;
  try {
    if (!(await ensureSubscriber())) return false;
    const body = {
      subscriber_email: to,
      template_id: templateId,
      data: { subject, body_html: html },
      content_type: 'html',
    };
    if (from) body.from_email = from;
    const res = await fetch(`${listmonkUrl}/api/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn(`[mail] /api/tx ${res.status}: ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`[mail] send failed: ${err.message}`);
    return false;
  }
}
