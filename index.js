import { logger } from './src/utils/logger.js';
import { sendTelegramMessage } from './src/utils/telegram.js';
import { getWalletBalanceInUsd } from './src/services/wallet.js';
import { getMarketData } from './src/api/hyperliquid.js';
import { initBalance, processTick, getStats } from './src/engine/simulator.js';

const TICK_INTERVAL_MS   = 5 * 60 * 1000;      // 5 минут
const REPORT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 часа

function formatUptime(startedAt) {
    const hours = (Date.now() - startedAt) / 3_600_000;
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    return `${hours.toFixed(1)} h`;
}

function formatPosition(position) {
    if (!position) return '🏷 Active Pos: <i>none</i>';

    const heldMs = Date.now() - position.entryTime;
    const hh = String(Math.floor(heldMs / 3_600_000)).padStart(2, '0');
    const mm = String(Math.floor((heldMs % 3_600_000) / 60_000)).padStart(2, '0');

    return `🏷 Active Pos: <b>${position.coin}</b> (APY: ${position.entryApy.toFixed(2)}%, Time: ${hh}:${mm})`;
}

function formatReport() {
    const { balance, position, startedAt, startBalance } = getStats();
    const profit = balance - startBalance;
    const profitPct = startBalance > 0 ? (profit / startBalance) * 100 : 0;
    const profitSign = profit >= 0 ? '+' : '';

    return [
        `📊 <b>HL Paper Scanner</b>`,
        ``,
        `🏦 Balance: <b>$${balance.toFixed(2)}</b>`,
        `📈 Profit: <b>${profitSign}$${profit.toFixed(2)} (${profitSign}${profitPct.toFixed(2)}%)</b>`,
        formatPosition(position),
        `🕒 Uptime: ${formatUptime(startedAt)}`,
    ].join('\n');
}

async function tick() {
    try {
        const marketData = await getMarketData();
        await processTick(marketData);
    } catch (err) {
        if (err.message.startsWith('Stale data')) {
            logger.warn(`Tick skipped: ${err.message}`);
        } else {
            logger.error(`Tick failed: ${err.message}`);
        }
    }
}

async function sendReport() {
    logger.info('Sending report to Telegram...');
    await sendTelegramMessage(formatReport());
}

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[SYSTEM] ${signal} received, shutting down...`);

    const { balance, history, startBalance } = getStats();
    const profit = balance - startBalance;
    const profitSign = profit >= 0 ? '+' : '';

    await sendTelegramMessage(
        `🛑 <b>Бот остановлен</b> (${signal})\n\n` +
        `🏦 Итоговый баланс: <b>$${balance.toFixed(2)}</b>\n` +
        `📈 Профит: <b>${profitSign}$${profit.toFixed(2)}</b>\n` +
        `🔁 Сделок закрыто: ${history.length}`
    );

    logger.info('[SYSTEM] Goodbye.');
    process.exit(0);
}

async function main() {
    try {
        logger.info('[SYSTEM] HL Paper Scanner starting...');

        const walletBalance = await getWalletBalanceInUsd();
        await initBalance(walletBalance);

        const { startBalance } = getStats();
        await sendTelegramMessage(
            `🚀 <b>Бот запущен!</b>\n\n🏦 Начальный баланс: <b>$${startBalance.toFixed(2)}</b>`
        );

        // Первый тик сразу, затем первый отчёт
        await tick();
        await sendReport();

        const tickTimer   = setInterval(tick, TICK_INTERVAL_MS);
        const reportTimer = setInterval(sendReport, REPORT_INTERVAL_MS);

        const stop = (signal) => async () => {
            clearInterval(tickTimer);
            clearInterval(reportTimer);
            await shutdown(signal);
        };

        process.on('SIGINT',  stop('SIGINT'));
        process.on('SIGTERM', stop('SIGTERM'));

    } catch (err) {
        logger.error(`[FATAL] ${err.message}`);
        process.exit(1);
    }
}

main();
