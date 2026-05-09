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

  // ── Mode presets ──
  // AGGRESSIVE_MODE=true uses AGG_* defaults. Individual env vars override if set.
  const aggressive = (process.env.AGGRESSIVE_MODE || 'false').toLowerCase() === 'true';

  const aggMinApy    = parseFloat(process.env.AGG_MIN_APY            || '15');
  const aggEntryApy  = parseFloat(process.env.AGG_ENTRY_APY         || '25');
  const aggRoundTrip = parseFloat(process.env.AGG_ROUND_TRIP        || '0.0006');

  const minApy   = parseFloat(process.env.MIN_APY_THRESHOLD   || String(aggressive ? aggMinApy   : 30));
  const entryApy = parseFloat(process.env.ENTRY_APY_THRESHOLD || String(aggressive ? aggEntryApy : 60));
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

  // ── Strategy constants (shared by carry + fade) ──
  const roundTrip             = parseFloat(process.env.ROUND_TRIP              || String(aggressive ? aggRoundTrip : 0.001));
  const maxPaybackHours       = parseFloat(process.env.MAX_PAYBACK_HOURS       || '24');
  const maxBreakevenHours     = parseFloat(process.env.MAX_BREAKEVEN_HOURS     || '24');
  const negativeFundingTicks  = parseInt(process.env.NEGATIVE_FUNDING_TICKS    || '2',  10);
  const delistConfirmTicks    = parseInt(process.env.DELIST_CONFIRM_TICKS      || '3',  10);
  const delistCooldownMinutes = parseInt(process.env.DELIST_COOLDOWN_MINUTES   || '30', 10);
  const minEntryApyFloor      = parseFloat(process.env.MIN_ENTRY_APY_FLOOR    || '10');
  const predictedDropThreshold = parseFloat(process.env.PREDICTED_DROP_THRESHOLD || '30') / 100;
  const fundingGateMinutes    = parseInt(process.env.FUNDING_GATE_MINUTES      || '10', 10);

  // ── Fade strategy (Predicted Funding Fade) ──
  const fadeMaxHoldMinutes = parseInt(process.env.FADE_MAX_HOLD_MINUTES  || '120', 10);
  const fadeMinCurrentApy  = parseFloat(process.env.FADE_MIN_CURRENT_APY || '200');
  const fadeMinDropPct     = parseFloat(process.env.FADE_MIN_DROP_PCT    || '40') / 100;
  const fadeEnabled        = (process.env.FADE_ENABLED || 'true').toLowerCase() === 'true';

  // ── Carry trailing take-profit ──
  // Защита от сценария «unrealized PnL вырос до +20%, но дед ждёт negative_funding
  // и закрывается в ноль». Триггерим выход, когда позиция сдала GIVE_BACK% от пика.
  // ARM_PCT = пока unrealized < этого порога, peak не трекаем (фильтр шума).
  const carryTrailEnabled       = (process.env.CARRY_TRAIL_ENABLED || 'true').toLowerCase() === 'true';
  const carryTrailArmPct        = parseFloat(process.env.CARRY_TRAIL_ARM_PCT        || '3');
  const carryTrailArmPctEquity  = parseFloat(process.env.CARRY_TRAIL_ARM_PCT_EQUITY || '1.5');
  const carryTrailGiveBackPct   = parseFloat(process.env.CARRY_TRAIL_GIVE_BACK_PCT  || '25');
  const carrySpikeProtectionPct = parseFloat(process.env.CARRY_SPIKE_PROTECTION_PCT || '6');

  if (isNaN(carryTrailArmPct) || carryTrailArmPct <= 0) {
    throw new Error(`CARRY_TRAIL_ARM_PCT must be positive number. Got: "${process.env.CARRY_TRAIL_ARM_PCT}"`);
  }
  if (isNaN(carryTrailArmPctEquity) || carryTrailArmPctEquity <= 0) {
    throw new Error(`CARRY_TRAIL_ARM_PCT_EQUITY must be positive number. Got: "${process.env.CARRY_TRAIL_ARM_PCT_EQUITY}"`);
  }
  if (isNaN(carryTrailGiveBackPct) || carryTrailGiveBackPct <= 0 || carryTrailGiveBackPct >= 100) {
    throw new Error(`CARRY_TRAIL_GIVE_BACK_PCT must be in (0, 100). Got: "${process.env.CARRY_TRAIL_GIVE_BACK_PCT}"`);
  }
  if (isNaN(carrySpikeProtectionPct) || carrySpikeProtectionPct <= 0 || carrySpikeProtectionPct >= 100) {
    throw new Error(`CARRY_SPIKE_PROTECTION_PCT must be in (0, 100). Got: "${process.env.CARRY_SPIKE_PROTECTION_PCT}"`);
  }

  // ── Carry long side (symmetric to short on negative funding) ──
  // Default false: исторически Grandfather только шортил при положительном
  // funding. Long-ветка зеркальна: при отрицательном funding (шорты платят
  // лонгам) открываем long. Активируется ПОСЛЕ полного staged rollout
  // (Iter 1.0–1.4); пока флаг выключен — поведение идентично прежнему.
  const carryLongEnabled = (process.env.CARRY_LONG_ENABLED || 'false').toLowerCase() === 'true';

  // ── Market Regime: per-coin velocity entry gate (Iter A) ──
  // Защита от «шорта в зелёный рынок»: перед OPEN смотрим, что монета сделала
  // за последние N минут. Если выросла > pump% (для short) или упала > pump%
  // (для long) — skip entry. Default off — включается флагом.
  const marketRegimeVelocityEnabled =
    (process.env.MARKET_REGIME_VELOCITY_ENABLED || 'false').toLowerCase() === 'true';
  // Bucket 1: быстрый спайк (default 30мин/3%)
  const marketRegimeCoinPumpPct = parseFloat(process.env.MARKET_REGIME_COIN_PUMP_PCT || '3');
  const marketRegimeLookbackMin = parseFloat(process.env.MARKET_REGIME_LOOKBACK_MIN || '30');
  // Bucket 2: медленный pump→plateau (default 2ч/5%). XMR/TON-паттерн: pump за 2ч, потом
  // плато → 30-мин bucket пропускает, нужен второй уровень. Set MARKET_REGIME_LOOKBACK2_MIN=0
  // чтобы отключить второй bucket.
  const marketRegimeCoinPumpPct2 = parseFloat(process.env.MARKET_REGIME_COIN_PUMP_PCT2 || '5');
  const marketRegimeLookback2Min = parseFloat(process.env.MARKET_REGIME_LOOKBACK2_MIN || '120');

  if (isNaN(marketRegimeCoinPumpPct) || marketRegimeCoinPumpPct <= 0) {
    throw new Error(
      `MARKET_REGIME_COIN_PUMP_PCT must be positive. Got: "${process.env.MARKET_REGIME_COIN_PUMP_PCT}"`,
    );
  }
  if (isNaN(marketRegimeLookbackMin) || marketRegimeLookbackMin <= 0 || marketRegimeLookbackMin > 240) {
    throw new Error(
      `MARKET_REGIME_LOOKBACK_MIN must be in (0, 240]. Got: "${process.env.MARKET_REGIME_LOOKBACK_MIN}"`,
    );
  }
  if (isNaN(marketRegimeCoinPumpPct2) || marketRegimeCoinPumpPct2 <= 0) {
    throw new Error(
      `MARKET_REGIME_COIN_PUMP_PCT2 must be positive. Got: "${process.env.MARKET_REGIME_COIN_PUMP_PCT2}"`,
    );
  }
  if (isNaN(marketRegimeLookback2Min) || marketRegimeLookback2Min < 0 || marketRegimeLookback2Min > 240) {
    throw new Error(
      `MARKET_REGIME_LOOKBACK2_MIN must be in [0, 240]. Got: "${process.env.MARKET_REGIME_LOOKBACK2_MIN}"`,
    );
  }

  // ── Market Regime: BTC regime entry gate (Iter B) ──
  // Глобальный гейт: если BTC pumpнул > pct за последние N мин — блокируем
  // новые short-входы (рынок зелёный). Симметрично: BTC dumpнул > pct → блокируем
  // long-входы. Дополняет per-coin velocity gate (Iter A): coin может стоять
  // ровно, но BTC тащит весь рынок — short в зелёный рынок плохая идея.
  // Default off — включается флагом.
  const marketRegimeBtcEnabled =
    (process.env.MARKET_REGIME_BTC_ENABLED || 'false').toLowerCase() === 'true';
  const marketRegimeBtcPumpPct  = parseFloat(process.env.MARKET_REGIME_BTC_PUMP_PCT  || '2');
  const marketRegimeBtcLookbackMin = parseFloat(process.env.MARKET_REGIME_BTC_LOOKBACK_MIN || '60');

  if (isNaN(marketRegimeBtcPumpPct) || marketRegimeBtcPumpPct <= 0) {
    throw new Error(
      `MARKET_REGIME_BTC_PUMP_PCT must be positive. Got: "${process.env.MARKET_REGIME_BTC_PUMP_PCT}"`,
    );
  }
  if (isNaN(marketRegimeBtcLookbackMin) || marketRegimeBtcLookbackMin <= 0 || marketRegimeBtcLookbackMin > 240) {
    throw new Error(
      `MARKET_REGIME_BTC_LOOKBACK_MIN must be in (0, 240]. Got: "${process.env.MARKET_REGIME_BTC_LOOKBACK_MIN}"`,
    );
  }

  // ── Sniper-Hunter strategy (Volatility Spike Mean-Reversion) ──
  // Default false: включить вручную через HUNTER_ENABLED=true, когда будем готовы тестировать в PAPER.
  const hunterEnabled = (process.env.HUNTER_ENABLED || 'false').toLowerCase() === 'true';
  // Iter C: отдельный двойной gate для PROD-пути Hunter'а. Даже если HUNTER_ENABLED=true,
  // в isProduction режиме реальные ордера НЕ отправляются пока HUNTER_PROD_ENABLED=true.
  // Позволяет собирать PAPER-сигналы на боевом боте без риска реального исполнения.
  const hunterProdEnabled = (process.env.HUNTER_PROD_ENABLED || 'false').toLowerCase() === 'true';

  // Hunter-only leverage: умножает РАЗМЕР позиции (а не только маржинальный буфер).
  // На балансе $100 при utilization=0.5: 1x → $50 поза, 3x → $150, 5x → $250.
  // SL=2% при 5x = −5% от баланса; ликвидационный буфер уменьшается пропорционально.
  // Default 1 = поведение Iter C без изменений. Изолировано от carry/fade — там всегда 1x.
  const hunterLeverage = parseInt(process.env.HUNTER_LEVERAGE || '1', 10);
  if (!Number.isInteger(hunterLeverage) || hunterLeverage < 1 || hunterLeverage > 10) {
    throw new Error(`HUNTER_LEVERAGE must be integer in [1, 10]. Got: "${process.env.HUNTER_LEVERAGE}"`);
  }
  // Hunter хантит на более широкой вселенной, чем carry/fade (им нужна высокая ликвидность для
  // минимального slippage, Hunter'у — вариативность). Default $1M — захватывает 30–50 монет на HL
  // вместо ~12. PAPER-безопасно; для PROD (Iter C) потребуется size-cap и осторожность.
  const hunterMinVolume = parseFloat(process.env.HUNTER_MIN_VOLUME || '1000000');

  // Anti-trend filter: не шортим если цена N мин назад была ниже current на ≥M%
  // (значит за N мин уже был устойчивый рост — это тренд, не reversion-кандидат).
  const hunterTrendLookbackMin = parseFloat(process.env.HUNTER_TREND_LOOKBACK_MIN || '15');
  const hunterTrendMaxRisePct  = parseFloat(process.env.HUNTER_TREND_MAX_RISE_PCT || '8');
  // Post-SL cooldown: после SL Hunter блокирует эту монету на N минут.
  // Защита от паттерна APE 17:27→17:56→18:23 — повторные входы по более высокой цене.
  const hunterPostSlCooldownMin = parseFloat(process.env.HUNTER_POST_SL_COOLDOWN_MIN || '30');
  // Time-stop: позиция Hunter не должна висеть вечно. Mean-reversion обычно отрабатывает
  // за минуты-десятки. Если за HUNTER_TIME_STOP_MIN ни SL ни TP — закрываем по market.
  const hunterTimeStopMin = parseFloat(process.env.HUNTER_TIME_STOP_MIN || '60');

  if (isNaN(hunterTrendLookbackMin) || hunterTrendLookbackMin <= 0 || hunterTrendLookbackMin > 20) {
    throw new Error(`HUNTER_TREND_LOOKBACK_MIN must be in (0, 20]. Got: "${process.env.HUNTER_TREND_LOOKBACK_MIN}"`);
  }
  if (isNaN(hunterTrendMaxRisePct) || hunterTrendMaxRisePct <= 0) {
    throw new Error(`HUNTER_TREND_MAX_RISE_PCT must be positive. Got: "${process.env.HUNTER_TREND_MAX_RISE_PCT}"`);
  }
  if (isNaN(hunterPostSlCooldownMin) || hunterPostSlCooldownMin <= 0) {
    throw new Error(`HUNTER_POST_SL_COOLDOWN_MIN must be positive. Got: "${process.env.HUNTER_POST_SL_COOLDOWN_MIN}"`);
  }
  if (isNaN(hunterTimeStopMin) || hunterTimeStopMin <= 0) {
    throw new Error(`HUNTER_TIME_STOP_MIN must be positive. Got: "${process.env.HUNTER_TIME_STOP_MIN}"`);
  }

  // ── Carry: soft-sniper exit on negative_funding when in profit ──
  // Если funding ушёл в минус, но позиция в плюсе ≥X% — закрываем через snайпера
  // (maker, экономия 0.02% комиссии). Иначе — market (чтоб не терять время).
  const negativeFundingSoftExitMinPnlPct = parseFloat(
    process.env.NEGATIVE_FUNDING_SOFT_EXIT_MIN_PNL_PCT || '2',
  );
  if (isNaN(negativeFundingSoftExitMinPnlPct) || negativeFundingSoftExitMinPnlPct < 0) {
    throw new Error(
      `NEGATIVE_FUNDING_SOFT_EXIT_MIN_PNL_PCT must be ≥ 0. Got: "${process.env.NEGATIVE_FUNDING_SOFT_EXIT_MIN_PNL_PCT}"`,
    );
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

    aggressive,

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
      roundTrip,
      maxPaybackHours,
      maxBreakevenHours,
      negativeFundingTicks,
      delistConfirmTicks,
      delistCooldownMinutes,
      minEntryApyFloor,
      predictedDropThreshold,
      fundingGateMinutes,
      liquidTopN,
      liquidMinVolume,
      liquidCacheMs: liquidCacheHours * 3_600_000,
      fadeEnabled,
      fadeMaxHoldMinutes,
      fadeMinCurrentApy,
      fadeMinDropPct,
      hunterEnabled,
      hunterProdEnabled,
      hunterLeverage,
      hunterMinVolume,
      hunterTrendLookbackMin,
      hunterTrendMaxRisePct,
      hunterPostSlCooldownMin,
      hunterTimeStopMin,
      carryTrailEnabled,
      carryTrailArmPct,
      carryTrailArmPctEquity,
      carryTrailGiveBackPct,
      carrySpikeProtectionPct,
      carryLongEnabled,
      marketRegimeVelocityEnabled,
      marketRegimeCoinPumpPct,
      marketRegimeLookbackMin,
      marketRegimeCoinPumpPct2,
      marketRegimeLookback2Min,
      marketRegimeBtcEnabled,
      marketRegimeBtcPumpPct,
      marketRegimeBtcLookbackMin,
      negativeFundingSoftExitMinPnlPct,
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
