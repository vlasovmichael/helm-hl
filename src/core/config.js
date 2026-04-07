import 'dotenv/config';

const VALID_MODES = ['PAPER', 'PRODUCTION'];

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function loadConfig() {
  const mode = (process.env.TRADING_MODE || 'PAPER').toUpperCase();

  if (!VALID_MODES.includes(mode)) {
    throw new Error(`TRADING_MODE must be one of: ${VALID_MODES.join(', ')}. Got: "${mode}"`);
  }

  const privateKey = process.env.HL_PRIVATE_KEY || null;

  if (mode === 'PRODUCTION' && !privateKey) {
    throw new Error(
      'TRADING_MODE is PRODUCTION but HL_PRIVATE_KEY is not set. Refusing to start.',
    );
  }

  const walletAddress = requireEnv('PUBLIC_WALLET_ADDRESS');

  const minApy   = parseFloat(process.env.MIN_APY_THRESHOLD   || '30');
  const entryApy = parseFloat(process.env.ENTRY_APY_THRESHOLD || '60');
  const leverage = parseFloat(process.env.LEVERAGE             || '1');

  if (isNaN(minApy) || isNaN(entryApy) || isNaN(leverage)) {
    throw new Error('MIN_APY_THRESHOLD, ENTRY_APY_THRESHOLD and LEVERAGE must be valid numbers');
  }

  if (entryApy <= minApy) {
    throw new Error(
      `ENTRY_APY_THRESHOLD (${entryApy}) must be greater than MIN_APY_THRESHOLD (${minApy})`,
    );
  }

  return {
    mode,
    isProduction: mode === 'PRODUCTION',

    wallet: {
      address:    walletAddress,
      privateKey,
      rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',
    },

    trading: {
      minApy,
      entryApy,
      leverage,
    },

    telegram: {
      token:           process.env.TELEGRAM_BOT_TOKEN  || null,
      chatId:          process.env.TELEGRAM_CHAT_ID    || null,
      silentStartHour: parseInt(process.env.SILENT_START_HOUR ?? '23', 10),
      silentEndHour:   parseInt(process.env.SILENT_END_HOUR   ?? '8',  10),
    },
  };
}

// Единственный экземпляр — загружается один раз при старте
export const config = loadConfig();
