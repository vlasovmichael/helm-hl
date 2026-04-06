import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const TG_API = config.telegram.token
  ? `https://api.telegram.org/bot${config.telegram.token}/sendMessage`
  : null;

/**
 * Отправляет HTML-сообщение в Telegram.
 * При ошибке — логирует, не бросает исключение.
 * Если токен/chatId не заданы — тихо пропускает.
 */
export async function sendMessage(text) {
  if (!TG_API || !config.telegram.chatId) return;

  try {
    await axios.post(TG_API, {
      chat_id:    config.telegram.chatId,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    logger.error(`[Reporter] Telegram send failed: ${err.message}`);
  }
}
