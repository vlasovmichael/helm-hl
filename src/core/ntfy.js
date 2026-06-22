// ─────────────────────────────────────────────────
//  Общий ntfy-постер
// ─────────────────────────────────────────────────
// Один HTTP-POST в ntfy. Вынесён из hotMoversAlerts/setupScannerAlerts (там та же
// логика дублировалась) — чтобы fadehot-пуш и будущие потребители её переиспользовали.
// Тихий час (00–08 Europe/Warsaw → priority=1, без звука) — общий для всех алертов.

import { config } from './config.js';
import { logger } from './logger.js';
import { recordNotification } from './notifyLog.js';
import { sendMail, isMailEnabled } from './mail.js';

const QUIET_FROM = parseInt(process.env.NTFY_QUIET_FROM ?? '0', 10);
const QUIET_TO = parseInt(process.env.NTFY_QUIET_TO ?? '8', 10);

export function isQuietHour(now = Date.now()) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Warsaw' }).format(now),
    10,
  );
  return QUIET_FROM <= QUIET_TO ? hour >= QUIET_FROM && hour < QUIET_TO : hour >= QUIET_FROM || hour < QUIET_TO;
}

/**
 * POST в ntfy. В тихий час приоритет принудительно 1 (без звука), иначе — заданный
 * или config.ntfy.priority. Никогда не бросает — при ошибке логирует warn и резолвит false.
 *
 * @param {{topic?:string, title:string, message:string, tags?:string[], priority?:number, now?:number}} opts
 * @returns {Promise<boolean>} true если запрос ушёл, false если не настроено/ошибка
 */
export async function fireNtfy({ topic, title, message, tags = [], priority, now = Date.now() } = {}) {
  const { url, token } = config.ntfy;
  const t = topic || config.ntfy.topic;
  if (!url || !t) return false;
  try {
    const { default: https } = await import('node:https');
    const { default: http } = await import('node:http');
    const prio = isQuietHour(now) ? 1 : (priority ?? config.ntfy.priority ?? 3);
    const body = JSON.stringify({ topic: t, title, message, priority: prio, tags });
    const u = new URL(`${url}/`);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
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
    // Журнал для колокольчика + (опц.) мгновенное письмо. Письмо шлём только на
    // «горячие» пуши (effective priority ≥ 3) — холодные/тихие (cold-fades,
    // тихий час) копятся в дайджесте, но почту не дёргают. Fail-soft: не ждём
    // и не валим основной путь, если письмо не ушло.
    const hot = prio >= 3;
    const emailed = hot && config.mail.instant && isMailEnabled();
    recordNotification({ title, message, topic: t, tags, priority: prio, emailed, ts: now });
    if (emailed) {
      sendMail({
        subject: title,
        html: `<h2 style="margin:0 0 8px">${escapeHtml(title)}</h2>` +
          `<pre style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap;margin:0">${escapeHtml(message)}</pre>`,
      }).catch(() => {});
    }
    return true;
  } catch (err) {
    logger.warn(`[ntfy] post failed: ${err.message}`);
    return false;
  }
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
