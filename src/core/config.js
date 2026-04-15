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

  // ── Risk management ──
  // ── Liquidity whitelist (Scout) ──
  const liquidTopN       = parseInt(process.env.LIQUID_TOP_N        || '50', 10);
  const liquidMinVolume  = parseFloat(process.env.LIQUID_MIN_VOLUME || '10000000'); // $10M/24h
  const liquidCacheHours = parseFloat(process.env.LIQUID_CACHE_HOURS || '6');

  if (isNaN(liquidTopN) || liquidTopN < 1) {
    throw new Error(`LIQUID_TOP_N must be integer ≥ 1. Got: "${process.env.LIQUID_TOP_N}"`);
  }
  if (isNaN(liquidMinVolume) || liquidMinVolume < 0) {
    throw new Error(`LIQUID_MIN_VOLUME must be non-negative number. Got: "${process.env.LIQUID_MIN_VOLUME}"`);
  }
  if (isNaN(liquidCacheHours) || liquidCacheHours <= 0) {
    throw new Error(`LIQUID_CACHE_HOURS must be positive number. Got: "${process.env.LIQUID_CACHE_HOURS}"`);
  }

  const maxDrawdownPct = parseFloat(process.env.MAX_DRAWDOWN_PCT || '10');
  const cbMaxLosses    = parseInt(process.env.CB_MAX_LOSSES      || '3', 10);
  const cbPauseHours   = parseFloat(process.env.CB_PAUSE_HOURS   || '2');

  if (isNaN(maxDrawdownPct) || maxDrawdownPct <= 0 || maxDrawdownPct > 100) {
    throw new Error(`MAX_DRAWDOWN_PCT must be a number in (0, 100]. Got: "${process.env.MAX_DRAWDOWN_PCT}"`);
  }
  if (isNaN(cbMaxLosses) || cbMaxLosses < 1) {
    throw new Error(`CB_MAX_LOSSES must be integer ≥ 1. Got: "${process.env.CB_MAX_LOSSES}"`);
  }
  if (isNaN(cbPauseHours) || cbPauseHours <= 0) {
    throw new Error(`CB_PAUSE_HOURS must be positive number. Got: "${process.env.CB_PAUSE_HOURS}"`);
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
      liquidTopN,
      liquidMinVolume,
      liquidCacheMs: liquidCacheHours * 3_600_000,
    },

    risk: {
      maxDrawdownPct,                  // -X% от sessionStartEquity → стоп открытий
      cbMaxLosses,                     // макс убытков подряд в окне
      cbWindowMs:  60 * 60_000,        // окно скользящего счётчика (1ч, hardcoded)
      cbPauseMs:   cbPauseHours * 3_600_000,
    },

    telegram: {
      token:           process.env.TELEGRAM_BOT_TOKEN  || null,
      chatId:          process.env.TELEGRAM_CHAT_ID    || null,
      silentStartHour: parseInt(process.env.SILENT_START_HOUR || '22', 10),
      silentEndHour:   parseInt(process.env.SILENT_END_HOUR   || '9',  10),
    },

    // ── Binance (read-only, для Tax Collector) ──
    // Модуль taxCollector сам проверяет наличие ключей через isConfigured()
    // и тихо отключается, если их нет. Не блокируем старт бота.
    binance: {
      apiKey:    process.env.BINANCE_API_KEY    || null,
      apiSecret: process.env.BINANCE_API_SECRET || null,
    },
  };
}

// Единственный экземпляр — загружается один раз при старте
export const config = loadConfig();
