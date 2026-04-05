import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from './logger.js';

export async function sendTelegramMessage(text) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${config.telegram.token}/sendMessage`,
            {
                chat_id: config.telegram.chat_id,
                text,
                parse_mode: 'HTML',
            }
        );
    } catch (err) {
        logger.error(`Failed to send Telegram message: ${err.message}`);
    }
}
