// ─────────────────────────────────────────────────
//  Опрос публичной ленты TG-канала (t.me/s/<name>)
// ─────────────────────────────────────────────────
// Превью-страница отдаёт последние ~20 постов обычным GET — без API и аккаунта.
// Листания назад нет намеренно: старые посты для вотчера = известный исход.

import { logger } from '../core/logger.js';
import { parsePosts } from './tgSignals.js';

const TIMEOUT_MS = 15_000;

const unescapeTags = (s) => s
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '');

/**
 * HTML страницы канала → посты. Экспортируется ради тестов: сеть в них не ходит.
 * @param {string} html
 * @returns {Array<{id:number, ts:string|null, text:string}>}
 */
export function parseChannelHtml(html) {
  const out = [];
  // По data-post, не по классу: вложенные div'ы носят тот же префикс.
  const idx = [...String(html).matchAll(/data-post="[^/]+\/(\d+)"/g)];
  for (let i = 0; i < idx.length; i++) {
    const chunk = html.slice(idx[i].index, i + 1 < idx.length ? idx[i + 1].index : html.length);
    const ts = chunk.match(/<time[^>]*datetime="([^"]+)"/)?.[1] || null;
    const body = chunk.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="tgme_widget_message_(?:reply_markup|footer|bubble_end)|<\/div>)/,
    );
    out.push({ id: Number(idx[i][1]), ts, text: body ? unescapeTags(body[1]).trim() : '' });
  }
  return out;
}

/**
 * Свежие сигналы канала. Сетевая ошибка — не исключение, а пустой список:
 * недоступный t.me не должен ронять тик бота.
 * @param {string} channel
 * @param {(url:string)=>Promise<Response>} [fetchFn]
 * @returns {Promise<Array>} сигналы в порядке публикации
 */
export async function fetchChannelSignals(channel, fetchFn = fetch) {
  let html;
  try {
    const res = await fetchFn(`https://t.me/s/${channel}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.debug(`[TgSignal] ${channel}: HTTP ${res.status}`);
      return [];
    }
    html = await res.text();
  } catch (err) {
    logger.debug(`[TgSignal] ${channel} недоступен: ${err.message}`);
    return [];
  }
  return parsePosts(channel, parseChannelHtml(html));
}
