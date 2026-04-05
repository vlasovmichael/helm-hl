import 'dotenv/config';

export const config = {
    walletAddress: process.env.PUBLIC_WALLET_ADDRESS,
    minApy: parseFloat(process.env.MIN_APY_THRESHOLD || '30'),
    entryApy: parseFloat(process.env.ENTRY_APY_THRESHOLD || '60'),
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chat_id: process.env.TELEGRAM_CHAT_ID
    },
    rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',
    simulation: {
        initialBalance: 0,
        mode: true
    }
};

if (!config.walletAddress) {
    console.error('❌ ОШИБКА: PUBLIC_WALLET_ADDRESS не задан в .env');
    process.exit(1);
}
