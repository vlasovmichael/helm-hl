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

  const agentPrivateKey = process.env.HL_AGENT_PRIVATE_KEY || null;

  if (mode === 'PRODUCTION' && !agentPrivateKey && !privateKey) {
    throw new Error(
      'TRADING_MODE is PRODUCTION but neither HL_AGENT_PRIVATE_KEY nor HL_PRIVATE_KEY is set. ' +
      'Set HL_AGENT_PRIVATE_KEY (recommended) or HL_PRIVATE_KEY. Refusing to start.',
    );
  }

  if (mode === 'PRODUCTION' && !agentPrivateKey) {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  WARNING: Using HL_PRIVATE_KEY (main wallet) instead of HL_AGENT_PRIVATE_KEY (agent). ' +
      'Agent wallet is strongly recommended for production — it cannot withdraw funds.',
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
      address:         walletAddress,
      privateKey,                                        // основной ключ (fallback)
      agentPrivateKey: process.env.HL_AGENT_PRIVATE_KEY || null,  // ключ агента для торговли
      rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',
    },

    trading: {
      minApy,
      entryApy,
      exitBuffer:        parseFloat(process.env.EXIT_BUFFER           || '5'),
      leverage,
      minHoldMinutes:    parseInt(process.env.MIN_HOLD_TIME_MINUTES   || '60',  10),
      breathingMinutes:  parseInt(process.env.BREATHING_MINUTES       || '30',  10),
      fakeBalance:       process.env.FAKE_BALANCE ? parseFloat(process.env.FAKE_BALANCE) : null,
      // Монеты, которые нельзя торговать (HLP-индексы, деривативы и т.п.)
      coinBlacklist:     new Set(
        (process.env.COIN_BLACKLIST || 'STBL')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
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
