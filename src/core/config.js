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
  const carryEnabled = (process.env.CARRY_ENABLED || 'true').toLowerCase() === 'true';

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
  // ── Setup Scanner snapshot interval (manual-helper, не торговая логика) ──
  const setupSnapshotIntervalMin = parseInt(process.env.SETUP_SNAPSHOT_INTERVAL_MIN || '60', 10);
  if (isNaN(setupSnapshotIntervalMin) || setupSnapshotIntervalMin < 1) {
    throw new Error(`SETUP_SNAPSHOT_INTERVAL_MIN must be integer ≥ 1. Got: "${process.env.SETUP_SNAPSHOT_INTERVAL_MIN}"`);
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
  // ARM_PCT_EQUITY: 1.5→1.2 (2026-05-11) — фиксируем wins чуть раньше, чтоб
  // увеличить hit-rate trailing TP против дешёвых проседаний.
  const carryTrailArmPctEquity  = parseFloat(process.env.CARRY_TRAIL_ARM_PCT_EQUITY || '1.2');
  const carryTrailGiveBackPct   = parseFloat(process.env.CARRY_TRAIL_GIVE_BACK_PCT  || '25');
  // SPIKE_PROTECTION_PCT: 6→4 (2026-05-11) — VVV в логах PROD дважды стопанулась
  // на 6% (-$2.94, -$2.61) и съела 5 wins по +$0.55-0.95. Cap loss до ~$1.5.
  const carrySpikeProtectionPct = parseFloat(process.env.CARRY_SPIKE_PROTECTION_PCT || '4');
  // LOSS_COOLDOWN_MIN: после price_spike_protection монета банится на N минут.
  // Защита от паттерна VVV 2026-05-10/11: stop-out → монета снова #1 по APY →
  // re-entry через 17ч → второй stop-out. Дефолт 720мин (12ч).
  const carryLossCooldownMin = parseFloat(process.env.CARRY_LOSS_COOLDOWN_MIN || '720');

  // ── Дед v2: breakeven храповик + «цена > фандинг» ──
  // Проблема: дед — funding-машина, держит позицию ради высокого APY и отдаёт
  // реальный ценовой подарок ($1+) обратно в 0, ждя negative_funding/apy_below.
  // На депо $50-100 funding = шум, деньги делает движение цены (carry = mean-rev).
  //
  // BE_RATCHET: как только цена дала даже небольшой плюс (peak ≥ arm), ставим
  // жёсткий пол на breakeven. Дед больше НИКОГДА не отдаёт подарок в 0 — выходит
  // в безубыток. Ловит подарки МЕНЬШЕ trail-arm (1.2% eq). Arm двойной: $-порог
  // ИЛИ %-equity порог (что сработает первым), чтоб защищать и мелкое депо.
  //   FLOOR_PCT_EQUITY: пол по цене как % equity. 0 = чистый breakeven.
  const carryBeRatchetEnabled = (process.env.CARRY_BE_RATCHET_ENABLED || 'true').toLowerCase() === 'true';
  const carryBeArmPctEquity   = parseFloat(process.env.CARRY_BE_ARM_PCT_EQUITY || '0.5');
  const carryBeArmUsd         = parseFloat(process.env.CARRY_BE_ARM_USD         || '0.40');
  const carryBeFloorPctEquity = parseFloat(process.env.CARRY_BE_FLOOR_PCT_EQUITY || '0');
  // PRICE_OVER_FUNDING: пока цена в плюсе и trail/ratchet взведён — funding-выходы
  // (apy_below / apy_decay / stale) НЕ выдёргивают деда. Пусть trail едет, выход
  // отдаём ценовой логике. Hard-выходы (negative_funding, spike) остаются.
  const carryPriceOverFunding = (process.env.CARRY_PRICE_OVER_FUNDING || 'true').toLowerCase() === 'true';
  if (isNaN(carryBeArmPctEquity) || carryBeArmPctEquity <= 0) {
    throw new Error(`CARRY_BE_ARM_PCT_EQUITY must be positive number. Got: "${process.env.CARRY_BE_ARM_PCT_EQUITY}"`);
  }
  if (isNaN(carryBeArmUsd) || carryBeArmUsd < 0) {
    throw new Error(`CARRY_BE_ARM_USD must be ≥ 0. Got: "${process.env.CARRY_BE_ARM_USD}"`);
  }
  if (isNaN(carryBeFloorPctEquity) || carryBeFloorPctEquity < 0) {
    throw new Error(`CARRY_BE_FLOOR_PCT_EQUITY must be ≥ 0. Got: "${process.env.CARRY_BE_FLOOR_PCT_EQUITY}"`);
  }

  // Vol-based position sizing для carry: на high-vol монетах режем размер позиции,
  // чтобы lose-trade не съедал N win-trades. Формула: size × clamp(1 - volIdx × penalty, minMult, 1).
  // penalty=50, minMult=0.4: VolIdx=0.003→×1.00, 0.008→×0.60, 0.015→×0.40.
  const carryVolSizePenalty = parseFloat(process.env.CARRY_VOL_SIZE_PENALTY || '50');
  const carryVolSizeMinMult = parseFloat(process.env.CARRY_VOL_SIZE_MIN_MULT || '0.4');
  if (isNaN(carryVolSizePenalty) || carryVolSizePenalty < 0) {
    throw new Error(`CARRY_VOL_SIZE_PENALTY must be ≥ 0. Got: "${process.env.CARRY_VOL_SIZE_PENALTY}"`);
  }
  if (isNaN(carryVolSizeMinMult) || carryVolSizeMinMult <= 0 || carryVolSizeMinMult > 1) {
    throw new Error(`CARRY_VOL_SIZE_MIN_MULT must be in (0, 1]. Got: "${process.env.CARRY_VOL_SIZE_MIN_MULT}"`);
  }

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
  if (isNaN(carryLossCooldownMin) || carryLossCooldownMin < 0) {
    throw new Error(`CARRY_LOSS_COOLDOWN_MIN must be ≥ 0. Got: "${process.env.CARRY_LOSS_COOLDOWN_MIN}"`);
  }

  // ── Carry "smart guards" против тихих позиций ──
  // FARTCOIN 2026-05-13: вход @ APY 37%, держал 16h при PnL≈$0 (флэт), trail так и не армился,
  // dynamic hold lock = 23.5h. Три ортогональные защиты:
  //   1) STALE_TIMEOUT — если за N мин ни разу не достигли STALE_MIN_PNL_EQUITY% от equity → close
  //   2) APY_DECAY_EXIT_RATIO — если slowApy/entryApy < ratio → игнорим hold lock, выходим
  //   3) MAX_HOLD_MIN — hard cap для dynamic hold lock (страховка против APY≈0 глюка + длинных хвостов)
  // 0 = выключить соответствующий guard.
  const carryStaleTimeoutMin    = parseFloat(process.env.CARRY_STALE_TIMEOUT_MIN    || '360');
  const carryStaleMinPnlEquity  = parseFloat(process.env.CARRY_STALE_MIN_PNL_EQUITY || '0.5');
  const carryApyDecayExitRatio  = parseFloat(process.env.CARRY_APY_DECAY_EXIT_RATIO || '0.5');
  const carryMaxHoldMin         = parseFloat(process.env.CARRY_MAX_HOLD_MIN         || '480');

  if (isNaN(carryStaleTimeoutMin) || carryStaleTimeoutMin < 0) {
    throw new Error(`CARRY_STALE_TIMEOUT_MIN must be ≥ 0. Got: "${process.env.CARRY_STALE_TIMEOUT_MIN}"`);
  }
  if (isNaN(carryStaleMinPnlEquity) || carryStaleMinPnlEquity < 0) {
    throw new Error(`CARRY_STALE_MIN_PNL_EQUITY must be ≥ 0. Got: "${process.env.CARRY_STALE_MIN_PNL_EQUITY}"`);
  }
  if (isNaN(carryApyDecayExitRatio) || carryApyDecayExitRatio < 0 || carryApyDecayExitRatio >= 1) {
    throw new Error(`CARRY_APY_DECAY_EXIT_RATIO must be in [0, 1). Got: "${process.env.CARRY_APY_DECAY_EXIT_RATIO}"`);
  }
  if (isNaN(carryMaxHoldMin) || carryMaxHoldMin < 0) {
    throw new Error(`CARRY_MAX_HOLD_MIN must be ≥ 0. Got: "${process.env.CARRY_MAX_HOLD_MIN}"`);
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

  // Доля баланса на позицию Hunter. SHORT и Long разделены: данные 2026-05-15
  // показали у SHORT положительное матожидание (+$0.56/сделку на 12 PROD-trades),
  // у Long — отрицательное. Поэтому SHORT поднимаем стадийно, Long держим
  // консервативно. Итоговый нотиональный множитель к балансу = util × hunterLeverage.
  const hunterBalanceUtil     = parseFloat(process.env.HUNTER_BALANCE_UTILIZATION      || '0.5');
  const hunterLongBalanceUtil = parseFloat(process.env.HUNTER_LONG_BALANCE_UTILIZATION || '0.5');
  if (isNaN(hunterBalanceUtil) || hunterBalanceUtil <= 0 || hunterBalanceUtil > 0.95) {
    throw new Error(`HUNTER_BALANCE_UTILIZATION must be in (0, 0.95]. Got: "${process.env.HUNTER_BALANCE_UTILIZATION}"`);
  }
  if (isNaN(hunterLongBalanceUtil) || hunterLongBalanceUtil <= 0 || hunterLongBalanceUtil > 0.95) {
    throw new Error(`HUNTER_LONG_BALANCE_UTILIZATION must be in (0, 0.95]. Got: "${process.env.HUNTER_LONG_BALANCE_UTILIZATION}"`);
  }

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

  // ── Hunter trailing TP (Iter D) ──
  // Trail заменяет fixed TP-trigger когда unrealized пересекает ARM_PCT.
  // ARM_PCT < HUNTER_TP_PCT (3%) — arm раньше, чтобы успеть cancel exchange TP.
  // GIVE_BACK_PCT — доля peak'а, которую готовы отдать обратно перед close.
  // SHADOW_LOG: если true — логируем "would-have-trailed" события даже когда
  // основной флаг false. Используется для оценки эффекта до PROD-активации.
  const hunterTrailEnabled      = (process.env.HUNTER_TRAIL_ENABLED || 'false').toLowerCase() === 'true';
  const hunterTrailShadowLog    = (process.env.HUNTER_TRAIL_SHADOW_LOG || 'true').toLowerCase() === 'true';
  const hunterTrailArmPct       = parseFloat(process.env.HUNTER_TRAIL_ARM_PCT       || '2');
  const hunterTrailGiveBackPct  = parseFloat(process.env.HUNTER_TRAIL_GIVE_BACK_PCT || '30');

  if (isNaN(hunterTrailArmPct) || hunterTrailArmPct <= 0 || hunterTrailArmPct >= 3) {
    throw new Error(`HUNTER_TRAIL_ARM_PCT must be in (0, 3) — strictly less than HUNTER_TP_PCT=3. Got: "${process.env.HUNTER_TRAIL_ARM_PCT}"`);
  }
  if (isNaN(hunterTrailGiveBackPct) || hunterTrailGiveBackPct <= 0 || hunterTrailGiveBackPct >= 100) {
    throw new Error(`HUNTER_TRAIL_GIVE_BACK_PCT must be in (0, 100). Got: "${process.env.HUNTER_TRAIL_GIVE_BACK_PCT}"`);
  }

  // ── Hunter Long (Iter E.1) — Long-after-dump, зеркало Hunter SHORT ──
  // Default false: PAPER-only включается отдельно. Заняла слот после Fade soft-kill.
  // Все параметры зеркальны HUNTER_* но с собственными дефолтами под dump-сторону:
  // anti-trend агрессивнее (6% vs 8%) — дампы чаще = real news (delist/scam).
  const hunterLongEnabled         = (process.env.HUNTER_LONG_ENABLED         || 'false').toLowerCase() === 'true';
  // Iter E.3: PROD-gate, mirror HUNTER_PROD_ENABLED. Реальные ордера на бирже
  // только при HUNTER_LONG_PROD_ENABLED=true в isProduction режиме.
  const hunterLongProdEnabled     = (process.env.HUNTER_LONG_PROD_ENABLED    || 'false').toLowerCase() === 'true';
  const hunterLongDumpPct         = parseFloat(process.env.HUNTER_LONG_DUMP_PCT         || '3.0');
  const hunterLongSlPct           = parseFloat(process.env.HUNTER_LONG_SL_PCT           || '2.0');
  const hunterLongTpPct           = parseFloat(process.env.HUNTER_LONG_TP_PCT           || '3.0');
  const hunterLongTrendLookbackMin = parseFloat(process.env.HUNTER_LONG_TREND_LOOKBACK_MIN || '15');
  const hunterLongTrendMaxDropPct = parseFloat(process.env.HUNTER_LONG_TREND_MAX_DROP_PCT || '6');
  const hunterLongPostSlCooldownMin = parseFloat(process.env.HUNTER_LONG_POST_SL_COOLDOWN_MIN || '180');
  const hunterLongTimeStopMin     = parseFloat(process.env.HUNTER_LONG_TIME_STOP_MIN     || '60');

  // ── Hunter Long entry filters (2026-05-20: после анализа Hunter LONG −$1.93/12tr) ──
  // Min-OI / min-volume гард: отсекаем low-liquidity монеты, склонные к halt/delist.
  // TST −$1.80 (external_close) — кейс-мотивация. Null → пропуск (deg. graceful при
  // API-сбоях scout'а), число ниже порога → continue + лог.
  const hunterLongMinOiUsd      = parseFloat(process.env.HUNTER_LONG_MIN_OI_USD       || '500000');
  const hunterLongMinVol24hUsd  = parseFloat(process.env.HUNTER_LONG_MIN_VOL_24H_USD  || '5000000');
  // Consecutive-SL ban: после N подряд SL'ов на одной монете (в окне WINDOW_HOURS)
  // ставим длинный бан BAN_HOURS. Защита от serial-loser паттерна (SAGA ×2 SL 2026-05-14).
  // Стандартный postSlCooldown остаётся базовой защитой (минуты), это — добавка поверх.
  const hunterLongSlStreakBan      = parseInt(process.env.HUNTER_LONG_SL_STREAK_BAN       || '2', 10);
  const hunterLongSlStreakWindowH  = parseFloat(process.env.HUNTER_LONG_SL_STREAK_WINDOW_HOURS || '6');
  const hunterLongSlStreakBanH     = parseFloat(process.env.HUNTER_LONG_SL_STREAK_BAN_HOURS    || '24');

  // Cross-strategy cooldown: после ЛЮБОГО close (SHORT или LONG) монета на N минут
  // запрещена для второй Hunter-стратегии. Защита от подбора ножа после успешного
  // шорта (SAGA 2026-05-13: SHORT TP +$1.13 → LONG ×2 SL).
  const hunterCrossCooldownMin = parseFloat(process.env.HUNTER_CROSS_COOLDOWN_MIN || '60');
  if (isNaN(hunterCrossCooldownMin) || hunterCrossCooldownMin <= 0) {
    throw new Error(`HUNTER_CROSS_COOLDOWN_MIN must be positive. Got: "${process.env.HUNTER_CROSS_COOLDOWN_MIN}"`);
  }

  // ── Strategy #4: trend_follow (codename Chill Boy) ─────────
  // Vol-squeeze breakout trend-follower. План: memory/trend_follow_plan.md.
  // Iter F.1b: paper only. PROD-gate (CHILL_BOY_PROD_ENABLED) — Iter F.3.
  const chillBoyEnabled        = (process.env.CHILL_BOY_ENABLED        || 'false').toLowerCase() === 'true';
  const chillBoyProdEnabled    = (process.env.CHILL_BOY_PROD_ENABLED   || 'false').toLowerCase() === 'true';
  const chillBoyAtrShort       = parseInt(process.env.CHILL_BOY_ATR_SHORT       || '20', 10);
  const chillBoyAtrLong        = parseInt(process.env.CHILL_BOY_ATR_LONG        || '50', 10);
  const chillBoySqueezeRatio   = parseFloat(process.env.CHILL_BOY_SQUEEZE_RATIO || '0.7');
  const chillBoyBreakoutMult   = parseFloat(process.env.CHILL_BOY_BREAKOUT_MULT || '0.5');
  const chillBoySlAtrMult      = parseFloat(process.env.CHILL_BOY_SL_ATR_MULT   || '1.5');
  const chillBoyTpAtrMult      = parseFloat(process.env.CHILL_BOY_TP_ATR_MULT   || '3.0');
  const chillBoyTimeStopHours  = parseFloat(process.env.CHILL_BOY_TIME_STOP_HOURS || '6');
  const chillBoyBalanceUtil    = parseFloat(process.env.CHILL_BOY_BALANCE_UTILIZATION || '0.5');
  const chillBoyPostSlCooldownMin = parseFloat(process.env.CHILL_BOY_POST_SL_COOLDOWN_MIN || '120');
  // Радар-алерты: TG-уведомление при каждом обнаруженном пробое (signal-radar),
  // независимо от того, входит ли бот. Дедуп per-coin раз в COOLDOWN_MIN.
  const chillBoyAlertEnabled     = (process.env.CHILL_BOY_ALERT_ENABLED || 'true').toLowerCase() === 'true';
  const chillBoyAlertCooldownMin = parseFloat(process.env.CHILL_BOY_ALERT_COOLDOWN_MIN || '45');
  // Виртуальный paper-баланс ChillBoy: позволяет shadow-сделкам открываться,
  // даже когда реальный free-balance занят carry. 0 = старое поведение (real balance).
  const chillBoyPaperVirtualBalance = parseFloat(process.env.CHILL_BOY_PAPER_VIRTUAL_BALANCE || '0');
  // Util только для virtual paper-режима (compound sandbox). Реальный paper
  // продолжает использовать CHILL_BOY_BALANCE_UTILIZATION.
  const chillBoyPaperVirtualUtil = parseFloat(process.env.CHILL_BOY_PAPER_VIRTUAL_UTILIZATION || '0.9');

  // ── Risk-based position sizing (cross-strategy: Hunter / Hunter Long / ChillBoy) ──
  const riskBasedSizing  = (process.env.RISK_BASED_SIZING  || 'false').toLowerCase() === 'true';
  const riskSizingShadow = (process.env.RISK_SIZING_SHADOW || 'true').toLowerCase() === 'true';
  const riskPctPerTrade  = parseFloat(process.env.RISK_PCT_PER_TRADE || '0.01');
  if (!Number.isInteger(chillBoyAtrShort) || chillBoyAtrShort < 5 || chillBoyAtrShort >= chillBoyAtrLong) {
    throw new Error(`CHILL_BOY_ATR_SHORT must be integer in [5, CHILL_BOY_ATR_LONG). Got: "${process.env.CHILL_BOY_ATR_SHORT}"`);
  }
  if (!Number.isInteger(chillBoyAtrLong) || chillBoyAtrLong < 10 || chillBoyAtrLong > 200) {
    throw new Error(`CHILL_BOY_ATR_LONG must be integer in [10, 200]. Got: "${process.env.CHILL_BOY_ATR_LONG}"`);
  }
  if (isNaN(chillBoySqueezeRatio) || chillBoySqueezeRatio <= 0 || chillBoySqueezeRatio >= 1) {
    throw new Error(`CHILL_BOY_SQUEEZE_RATIO must be in (0, 1). Got: "${process.env.CHILL_BOY_SQUEEZE_RATIO}"`);
  }
  if (isNaN(chillBoyBreakoutMult) || chillBoyBreakoutMult < 0) {
    throw new Error(`CHILL_BOY_BREAKOUT_MULT must be ≥ 0. Got: "${process.env.CHILL_BOY_BREAKOUT_MULT}"`);
  }
  if (isNaN(chillBoySlAtrMult) || chillBoySlAtrMult <= 0) {
    throw new Error(`CHILL_BOY_SL_ATR_MULT must be positive. Got: "${process.env.CHILL_BOY_SL_ATR_MULT}"`);
  }
  if (isNaN(chillBoyTpAtrMult) || chillBoyTpAtrMult <= 0 || chillBoyTpAtrMult <= chillBoySlAtrMult) {
    throw new Error(`CHILL_BOY_TP_ATR_MULT must be > CHILL_BOY_SL_ATR_MULT (ниже = плохой R:R). Got: "${process.env.CHILL_BOY_TP_ATR_MULT}"`);
  }
  if (isNaN(chillBoyTimeStopHours) || chillBoyTimeStopHours <= 0) {
    throw new Error(`CHILL_BOY_TIME_STOP_HOURS must be positive. Got: "${process.env.CHILL_BOY_TIME_STOP_HOURS}"`);
  }
  if (isNaN(chillBoyBalanceUtil) || chillBoyBalanceUtil <= 0 || chillBoyBalanceUtil > 0.95) {
    throw new Error(`CHILL_BOY_BALANCE_UTILIZATION must be in (0, 0.95]. Got: "${process.env.CHILL_BOY_BALANCE_UTILIZATION}"`);
  }
  if (isNaN(chillBoyPostSlCooldownMin) || chillBoyPostSlCooldownMin <= 0) {
    throw new Error(`CHILL_BOY_POST_SL_COOLDOWN_MIN must be positive. Got: "${process.env.CHILL_BOY_POST_SL_COOLDOWN_MIN}"`);
  }
  if (isNaN(chillBoyPaperVirtualBalance) || chillBoyPaperVirtualBalance < 0) {
    throw new Error(`CHILL_BOY_PAPER_VIRTUAL_BALANCE must be ≥ 0. Got: "${process.env.CHILL_BOY_PAPER_VIRTUAL_BALANCE}"`);
  }
  if (isNaN(chillBoyPaperVirtualUtil) || chillBoyPaperVirtualUtil <= 0 || chillBoyPaperVirtualUtil > 0.95) {
    throw new Error(`CHILL_BOY_PAPER_VIRTUAL_UTILIZATION must be in (0, 0.95]. Got: "${process.env.CHILL_BOY_PAPER_VIRTUAL_UTILIZATION}"`);
  }

  // ── Candy Girl — SIGNAL-ONLY радар (1h EMA-тренд + 5m pullback-reclaim) ──
  // ⚠️ НЕ стратегия: радар алертов для ручной торговли. План: memory/candy_girl_idea.md.
  // Никогда не открывает позицию. Master-флаг default OFF.
  const candyGirlEnabled            = (process.env.CANDY_GIRL_ENABLED || 'false').toLowerCase() === 'true';
  const candyGirlAlertEnabled       = (process.env.CANDY_GIRL_ALERT_ENABLED || 'true').toLowerCase() === 'true';
  const candyGirlFast1h             = parseInt(process.env.CANDY_GIRL_FAST_1H  || '20', 10);
  const candyGirlSlow1h             = parseInt(process.env.CANDY_GIRL_SLOW_1H  || '200', 10);
  const candyGirlSlopeLookback      = parseInt(process.env.CANDY_GIRL_SLOPE_LOOKBACK || '10', 10);
  const candyGirlEma5m              = parseInt(process.env.CANDY_GIRL_EMA_5M   || '20', 10);
  const candyGirlPullbackLookback   = parseInt(process.env.CANDY_GIRL_PULLBACK_LOOKBACK || '6', 10);
  const candyGirlRr                 = parseFloat(process.env.CANDY_GIRL_RR || '2');
  const candyGirlAlertCooldownMin   = parseFloat(process.env.CANDY_GIRL_ALERT_COOLDOWN_MIN || '45');
  const candyGirlMaxSignalsPerTick  = parseInt(process.env.CANDY_GIRL_MAX_SIGNALS_PER_TICK || '3', 10);
  // 4h higher-timeframe confluence: сигнал валиден только если 4h-тренд совпадает
  // с 1h-трендом. EMA20/50 на 4h (≈8 дней истории), легче чем EMA200 на 1h.
  const candyGirlHtfConfluence      = (process.env.CANDY_GIRL_HTF_CONFLUENCE || 'true').toLowerCase() === 'true';
  const candyGirlFast4h             = parseInt(process.env.CANDY_GIRL_FAST_4H  || '20', 10);
  const candyGirlSlow4h             = parseInt(process.env.CANDY_GIRL_SLOW_4H  || '50', 10);
  const candyGirlSlopeLookback4h    = parseInt(process.env.CANDY_GIRL_SLOPE_LOOKBACK_4H || '5', 10);
  // Логирование сигналов в БД + авто-резолв TP-before-SL (замер точности).
  const candyGirlSignalLogEnabled   = (process.env.CANDY_GIRL_SIGNAL_LOG_ENABLED || 'true').toLowerCase() === 'true';
  const candyGirlSignalTimeoutMin   = parseInt(process.env.CANDY_GIRL_SIGNAL_TIMEOUT_MIN || '240', 10);
  if (!Number.isInteger(candyGirlFast4h) || candyGirlFast4h < 2 || candyGirlFast4h >= candyGirlSlow4h) {
    throw new Error(`CANDY_GIRL_FAST_4H must be integer in [2, CANDY_GIRL_SLOW_4H). Got: "${process.env.CANDY_GIRL_FAST_4H}"`);
  }
  if (!Number.isInteger(candyGirlSlow4h) || candyGirlSlow4h < 5 || candyGirlSlow4h > 200) {
    throw new Error(`CANDY_GIRL_SLOW_4H must be integer in [5, 200]. Got: "${process.env.CANDY_GIRL_SLOW_4H}"`);
  }
  if (!Number.isInteger(candyGirlSlopeLookback4h) || candyGirlSlopeLookback4h < 1) {
    throw new Error(`CANDY_GIRL_SLOPE_LOOKBACK_4H must be positive integer. Got: "${process.env.CANDY_GIRL_SLOPE_LOOKBACK_4H}"`);
  }
  if (!Number.isInteger(candyGirlSignalTimeoutMin) || candyGirlSignalTimeoutMin < 1) {
    throw new Error(`CANDY_GIRL_SIGNAL_TIMEOUT_MIN must be positive integer. Got: "${process.env.CANDY_GIRL_SIGNAL_TIMEOUT_MIN}"`);
  }
  if (!Number.isInteger(candyGirlFast1h) || candyGirlFast1h < 2 || candyGirlFast1h >= candyGirlSlow1h) {
    throw new Error(`CANDY_GIRL_FAST_1H must be integer in [2, CANDY_GIRL_SLOW_1H). Got: "${process.env.CANDY_GIRL_FAST_1H}"`);
  }
  if (!Number.isInteger(candyGirlSlow1h) || candyGirlSlow1h < 10 || candyGirlSlow1h > 400) {
    throw new Error(`CANDY_GIRL_SLOW_1H must be integer in [10, 400]. Got: "${process.env.CANDY_GIRL_SLOW_1H}"`);
  }
  if (!Number.isInteger(candyGirlSlopeLookback) || candyGirlSlopeLookback < 1) {
    throw new Error(`CANDY_GIRL_SLOPE_LOOKBACK must be positive integer. Got: "${process.env.CANDY_GIRL_SLOPE_LOOKBACK}"`);
  }
  if (!Number.isInteger(candyGirlEma5m) || candyGirlEma5m < 2) {
    throw new Error(`CANDY_GIRL_EMA_5M must be integer ≥ 2. Got: "${process.env.CANDY_GIRL_EMA_5M}"`);
  }
  if (!Number.isInteger(candyGirlPullbackLookback) || candyGirlPullbackLookback < 1) {
    throw new Error(`CANDY_GIRL_PULLBACK_LOOKBACK must be positive integer. Got: "${process.env.CANDY_GIRL_PULLBACK_LOOKBACK}"`);
  }
  if (isNaN(candyGirlRr) || candyGirlRr <= 0) {
    throw new Error(`CANDY_GIRL_RR must be positive. Got: "${process.env.CANDY_GIRL_RR}"`);
  }
  if (isNaN(candyGirlAlertCooldownMin) || candyGirlAlertCooldownMin <= 0) {
    throw new Error(`CANDY_GIRL_ALERT_COOLDOWN_MIN must be positive. Got: "${process.env.CANDY_GIRL_ALERT_COOLDOWN_MIN}"`);
  }
  if (!Number.isInteger(candyGirlMaxSignalsPerTick) || candyGirlMaxSignalsPerTick < 1) {
    throw new Error(`CANDY_GIRL_MAX_SIGNALS_PER_TICK must be positive integer. Got: "${process.env.CANDY_GIRL_MAX_SIGNALS_PER_TICK}"`);
  }

  // ── Candy Girl paper-слот (Iter 2): зеркало ChillBoy shadow-слота ──
  // Радар (выше) только сигналит; paper-слот торгует лучший ранжированный сигнал
  // виртуально, чтобы собрать P&L с комиссиями перед PROD-гейтом. План:
  // memory/candy_girl_strategy_plan.md. PROD-путь пока НЕ построен — даже при
  // candyGirlProdEnabled=true open идёт в PAPER; флаг лишь глушит shadow-слот.
  const candyGirlProdEnabled        = (process.env.CANDY_GIRL_PROD_ENABLED || 'false').toLowerCase() === 'true';
  const candyGirlPaperVirtualBalance = parseFloat(process.env.CANDY_GIRL_PAPER_VIRTUAL_BALANCE || '0');
  const candyGirlPaperVirtualUtil   = parseFloat(process.env.CANDY_GIRL_PAPER_VIRTUAL_UTILIZATION || '0.9');
  const candyGirlBalanceUtil        = parseFloat(process.env.CANDY_GIRL_BALANCE_UTILIZATION || '0.5');
  if (isNaN(candyGirlPaperVirtualBalance) || candyGirlPaperVirtualBalance < 0) {
    throw new Error(`CANDY_GIRL_PAPER_VIRTUAL_BALANCE must be ≥ 0. Got: "${process.env.CANDY_GIRL_PAPER_VIRTUAL_BALANCE}"`);
  }
  if (isNaN(candyGirlPaperVirtualUtil) || candyGirlPaperVirtualUtil <= 0 || candyGirlPaperVirtualUtil > 0.95) {
    throw new Error(`CANDY_GIRL_PAPER_VIRTUAL_UTILIZATION must be in (0, 0.95]. Got: "${process.env.CANDY_GIRL_PAPER_VIRTUAL_UTILIZATION}"`);
  }
  if (isNaN(candyGirlBalanceUtil) || candyGirlBalanceUtil <= 0 || candyGirlBalanceUtil > 0.95) {
    throw new Error(`CANDY_GIRL_BALANCE_UTILIZATION must be in (0, 0.95]. Got: "${process.env.CANDY_GIRL_BALANCE_UTILIZATION}"`);
  }

  // ── Strategy #5: Fader — contrarian fade scalper (PAPER-only) ──
  // План: plans/fader-strategy-plan.md.
  const faderEnabled            = (process.env.FADER_ENABLED || 'false').toLowerCase() === 'true';
  const faderVirtualBalance     = parseFloat(process.env.FADER_VIRTUAL_BALANCE      || '0');
  const faderNominalUsd         = parseFloat(process.env.FADER_NOMINAL_USD          || '50');
  const faderLeverage           = parseFloat(process.env.FADER_LEVERAGE             || '2');
  const faderSpikeWindowMin     = parseFloat(process.env.FADER_SPIKE_WINDOW_MIN     || '5');
  const faderSpikePctMin        = parseFloat(process.env.FADER_SPIKE_PCT_MIN        || '1.5');
  const faderChopRatioMin       = parseFloat(process.env.FADER_CHOP_RATIO_MIN       || '2.0');
  const faderChopTrendBreakMin  = parseFloat(process.env.FADER_CHOP_TREND_BREAK_MIN || '1.5');
  const faderEdgeBandPct        = parseFloat(process.env.FADER_EDGE_BAND_PCT        || '0.25');
  const faderTpReclaimFrac      = parseFloat(process.env.FADER_TP_RECLAIM_FRAC      || '0.4');
  const faderTpFloorUsd         = parseFloat(process.env.FADER_TP_FLOOR_USD         || '0.20');
  const faderTpCeilingUsd       = parseFloat(process.env.FADER_TP_CEILING_USD       || '2.00');
  const faderAdverseKillPct     = parseFloat(process.env.FADER_ADVERSE_KILL_PCT     || '0.20');
  const faderTimeStopHours      = parseFloat(process.env.FADER_TIME_STOP_HOURS      || '24');
  const faderReentryCooldownMin = parseFloat(process.env.FADER_REENTRY_COOLDOWN_MIN || '10');
  const faderLossStreakLimit    = parseInt(process.env.FADER_LOSS_STREAK_LIMIT     || '3', 10);
  const faderLossStreakWindowMin= parseFloat(process.env.FADER_LOSS_STREAK_WINDOW_MIN || '60');
  const faderLossStreakPauseMin = parseFloat(process.env.FADER_LOSS_STREAK_PAUSE_MIN  || '60');
  const faderFeeRoundtripPct    = parseFloat(process.env.FADER_FEE_ROUNDTRIP_PCT    || '0.09'); // 0.045% × 2
  const faderSlippageRoundtripUsd = parseFloat(process.env.FADER_SLIPPAGE_ROUNDTRIP_USD || '0.10');

  if (isNaN(faderVirtualBalance) || faderVirtualBalance < 0) {
    throw new Error(`FADER_VIRTUAL_BALANCE must be ≥ 0. Got: "${process.env.FADER_VIRTUAL_BALANCE}"`);
  }
  if (isNaN(faderNominalUsd) || faderNominalUsd <= 0) {
    throw new Error(`FADER_NOMINAL_USD must be positive. Got: "${process.env.FADER_NOMINAL_USD}"`);
  }
  if (isNaN(faderLeverage) || faderLeverage <= 0 || faderLeverage > 20) {
    throw new Error(`FADER_LEVERAGE must be in (0, 20]. Got: "${process.env.FADER_LEVERAGE}"`);
  }
  if (isNaN(faderSpikeWindowMin) || faderSpikeWindowMin <= 0) {
    throw new Error(`FADER_SPIKE_WINDOW_MIN must be positive. Got: "${process.env.FADER_SPIKE_WINDOW_MIN}"`);
  }
  if (isNaN(faderSpikePctMin) || faderSpikePctMin <= 0) {
    throw new Error(`FADER_SPIKE_PCT_MIN must be positive. Got: "${process.env.FADER_SPIKE_PCT_MIN}"`);
  }
  if (isNaN(faderChopRatioMin) || faderChopRatioMin <= 0) {
    throw new Error(`FADER_CHOP_RATIO_MIN must be positive. Got: "${process.env.FADER_CHOP_RATIO_MIN}"`);
  }
  if (isNaN(faderChopTrendBreakMin) || faderChopTrendBreakMin <= 0 || faderChopTrendBreakMin > faderChopRatioMin) {
    throw new Error(`FADER_CHOP_TREND_BREAK_MIN must be in (0, FADER_CHOP_RATIO_MIN]. Got: "${process.env.FADER_CHOP_TREND_BREAK_MIN}"`);
  }
  if (isNaN(faderEdgeBandPct) || faderEdgeBandPct <= 0 || faderEdgeBandPct >= 0.5) {
    throw new Error(`FADER_EDGE_BAND_PCT must be in (0, 0.5). Got: "${process.env.FADER_EDGE_BAND_PCT}"`);
  }
  if (isNaN(faderTpReclaimFrac) || faderTpReclaimFrac <= 0 || faderTpReclaimFrac >= 1) {
    throw new Error(`FADER_TP_RECLAIM_FRAC must be in (0, 1). Got: "${process.env.FADER_TP_RECLAIM_FRAC}"`);
  }
  if (isNaN(faderTpFloorUsd) || faderTpFloorUsd < 0) {
    throw new Error(`FADER_TP_FLOOR_USD must be ≥ 0. Got: "${process.env.FADER_TP_FLOOR_USD}"`);
  }
  if (isNaN(faderTpCeilingUsd) || faderTpCeilingUsd <= faderTpFloorUsd) {
    throw new Error(`FADER_TP_CEILING_USD must be > FADER_TP_FLOOR_USD. Got: "${process.env.FADER_TP_CEILING_USD}"`);
  }
  if (isNaN(faderAdverseKillPct) || faderAdverseKillPct <= 0 || faderAdverseKillPct >= 1) {
    throw new Error(`FADER_ADVERSE_KILL_PCT must be in (0, 1). Got: "${process.env.FADER_ADVERSE_KILL_PCT}"`);
  }
  if (isNaN(faderTimeStopHours) || faderTimeStopHours <= 0) {
    throw new Error(`FADER_TIME_STOP_HOURS must be positive. Got: "${process.env.FADER_TIME_STOP_HOURS}"`);
  }
  if (isNaN(faderReentryCooldownMin) || faderReentryCooldownMin < 0) {
    throw new Error(`FADER_REENTRY_COOLDOWN_MIN must be ≥ 0. Got: "${process.env.FADER_REENTRY_COOLDOWN_MIN}"`);
  }
  if (!Number.isInteger(faderLossStreakLimit) || faderLossStreakLimit < 1) {
    throw new Error(`FADER_LOSS_STREAK_LIMIT must be integer ≥ 1. Got: "${process.env.FADER_LOSS_STREAK_LIMIT}"`);
  }
  if (isNaN(faderFeeRoundtripPct) || faderFeeRoundtripPct < 0) {
    throw new Error(`FADER_FEE_ROUNDTRIP_PCT must be ≥ 0. Got: "${process.env.FADER_FEE_ROUNDTRIP_PCT}"`);
  }
  if (isNaN(faderSlippageRoundtripUsd) || faderSlippageRoundtripUsd < 0) {
    throw new Error(`FADER_SLIPPAGE_ROUNDTRIP_USD must be ≥ 0. Got: "${process.env.FADER_SLIPPAGE_ROUNDTRIP_USD}"`);
  }
  if (isNaN(riskPctPerTrade) || riskPctPerTrade <= 0 || riskPctPerTrade > 0.1) {
    throw new Error(`RISK_PCT_PER_TRADE must be in (0, 0.1]. Got: "${process.env.RISK_PCT_PER_TRADE}"`);
  }

  if (isNaN(hunterLongDumpPct) || hunterLongDumpPct <= 0) {
    throw new Error(`HUNTER_LONG_DUMP_PCT must be positive. Got: "${process.env.HUNTER_LONG_DUMP_PCT}"`);
  }
  if (isNaN(hunterLongSlPct) || hunterLongSlPct <= 0 || hunterLongSlPct >= 100) {
    throw new Error(`HUNTER_LONG_SL_PCT must be in (0, 100). Got: "${process.env.HUNTER_LONG_SL_PCT}"`);
  }
  if (isNaN(hunterLongTpPct) || hunterLongTpPct <= 0) {
    throw new Error(`HUNTER_LONG_TP_PCT must be positive. Got: "${process.env.HUNTER_LONG_TP_PCT}"`);
  }
  if (isNaN(hunterLongTrendLookbackMin) || hunterLongTrendLookbackMin <= 0 || hunterLongTrendLookbackMin > 60) {
    throw new Error(`HUNTER_LONG_TREND_LOOKBACK_MIN must be in (0, 60]. Got: "${process.env.HUNTER_LONG_TREND_LOOKBACK_MIN}"`);
  }
  if (isNaN(hunterLongTrendMaxDropPct) || hunterLongTrendMaxDropPct <= 0) {
    throw new Error(`HUNTER_LONG_TREND_MAX_DROP_PCT must be positive. Got: "${process.env.HUNTER_LONG_TREND_MAX_DROP_PCT}"`);
  }
  if (isNaN(hunterLongPostSlCooldownMin) || hunterLongPostSlCooldownMin <= 0) {
    throw new Error(`HUNTER_LONG_POST_SL_COOLDOWN_MIN must be positive. Got: "${process.env.HUNTER_LONG_POST_SL_COOLDOWN_MIN}"`);
  }
  if (isNaN(hunterLongTimeStopMin) || hunterLongTimeStopMin <= 0) {
    throw new Error(`HUNTER_LONG_TIME_STOP_MIN must be positive. Got: "${process.env.HUNTER_LONG_TIME_STOP_MIN}"`);
  }
  if (isNaN(hunterLongMinOiUsd) || hunterLongMinOiUsd < 0) {
    throw new Error(`HUNTER_LONG_MIN_OI_USD must be ≥ 0. Got: "${process.env.HUNTER_LONG_MIN_OI_USD}"`);
  }
  if (isNaN(hunterLongMinVol24hUsd) || hunterLongMinVol24hUsd < 0) {
    throw new Error(`HUNTER_LONG_MIN_VOL_24H_USD must be ≥ 0. Got: "${process.env.HUNTER_LONG_MIN_VOL_24H_USD}"`);
  }
  if (!Number.isInteger(hunterLongSlStreakBan) || hunterLongSlStreakBan < 1) {
    throw new Error(`HUNTER_LONG_SL_STREAK_BAN must be integer ≥ 1. Got: "${process.env.HUNTER_LONG_SL_STREAK_BAN}"`);
  }
  if (isNaN(hunterLongSlStreakWindowH) || hunterLongSlStreakWindowH <= 0) {
    throw new Error(`HUNTER_LONG_SL_STREAK_WINDOW_HOURS must be positive. Got: "${process.env.HUNTER_LONG_SL_STREAK_WINDOW_HOURS}"`);
  }
  if (isNaN(hunterLongSlStreakBanH) || hunterLongSlStreakBanH <= 0) {
    throw new Error(`HUNTER_LONG_SL_STREAK_BAN_HOURS must be positive. Got: "${process.env.HUNTER_LONG_SL_STREAK_BAN_HOURS}"`);
  }

  // Iter E.2: trailing TP для Hunter Long (PAPER). Зеркало HUNTER_TRAIL_*.
  // ARM_PCT < HUNTER_LONG_TP_PCT — иначе fixed TP сработает раньше trail.
  const hunterLongTrailEnabled     = (process.env.HUNTER_LONG_TRAIL_ENABLED     || 'false').toLowerCase() === 'true';
  const hunterLongTrailShadowLog   = (process.env.HUNTER_LONG_TRAIL_SHADOW_LOG  || 'true').toLowerCase() === 'true';
  const hunterLongTrailArmPct      = parseFloat(process.env.HUNTER_LONG_TRAIL_ARM_PCT      || '2');
  const hunterLongTrailGiveBackPct = parseFloat(process.env.HUNTER_LONG_TRAIL_GIVE_BACK_PCT || '30');

  if (isNaN(hunterLongTrailArmPct) || hunterLongTrailArmPct <= 0 || hunterLongTrailArmPct >= hunterLongTpPct) {
    throw new Error(
      `HUNTER_LONG_TRAIL_ARM_PCT must be in (0, ${hunterLongTpPct}) — strictly less than HUNTER_LONG_TP_PCT. Got: "${process.env.HUNTER_LONG_TRAIL_ARM_PCT}"`,
    );
  }
  if (isNaN(hunterLongTrailGiveBackPct) || hunterLongTrailGiveBackPct <= 0 || hunterLongTrailGiveBackPct >= 100) {
    throw new Error(`HUNTER_LONG_TRAIL_GIVE_BACK_PCT must be in (0, 100). Got: "${process.env.HUNTER_LONG_TRAIL_GIVE_BACK_PCT}"`);
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
      setupSnapshotIntervalMin,
      carryEnabled,
      fadeEnabled,
      fadeMaxHoldMinutes,
      fadeMinCurrentApy,
      fadeMinDropPct,
      hunterEnabled,
      hunterProdEnabled,
      hunterLeverage,
      hunterBalanceUtil,
      hunterLongBalanceUtil,
      hunterMinVolume,
      hunterTrendLookbackMin,
      hunterTrendMaxRisePct,
      hunterPostSlCooldownMin,
      hunterTimeStopMin,
      hunterTrailEnabled,
      hunterTrailShadowLog,
      hunterTrailArmPct,
      hunterTrailGiveBackPct,
      hunterLongEnabled,
      hunterLongProdEnabled,
      hunterLongDumpPct,
      hunterLongSlPct,
      hunterLongTpPct,
      hunterLongTrendLookbackMin,
      hunterLongTrendMaxDropPct,
      hunterLongPostSlCooldownMin,
      hunterLongTimeStopMin,
      hunterLongMinOiUsd,
      hunterLongMinVol24hUsd,
      hunterLongSlStreakBan,
      hunterLongSlStreakWindowH,
      hunterLongSlStreakBanH,
      hunterLongTrailEnabled,
      hunterLongTrailShadowLog,
      hunterLongTrailArmPct,
      hunterLongTrailGiveBackPct,
      hunterCrossCooldownMin,
      chillBoyEnabled,
      chillBoyProdEnabled,
      chillBoyAtrShort,
      chillBoyAtrLong,
      chillBoySqueezeRatio,
      chillBoyBreakoutMult,
      chillBoySlAtrMult,
      chillBoyTpAtrMult,
      chillBoyTimeStopHours,
      chillBoyBalanceUtil,
      chillBoyPostSlCooldownMin,
      chillBoyAlertEnabled,
      chillBoyAlertCooldownMin,
      chillBoyPaperVirtualBalance,
      chillBoyPaperVirtualUtil,
      // ── Candy Girl радар (signal-only) ──
      candyGirlEnabled,
      candyGirlAlertEnabled,
      candyGirlFast1h,
      candyGirlSlow1h,
      candyGirlSlopeLookback,
      candyGirlEma5m,
      candyGirlPullbackLookback,
      candyGirlRr,
      candyGirlAlertCooldownMin,
      candyGirlMaxSignalsPerTick,
      candyGirlHtfConfluence,
      candyGirlFast4h,
      candyGirlSlow4h,
      candyGirlSlopeLookback4h,
      candyGirlSignalLogEnabled,
      candyGirlSignalTimeoutMin,
      candyGirlProdEnabled,
      candyGirlPaperVirtualBalance,
      candyGirlPaperVirtualUtil,
      candyGirlBalanceUtil,
      faderEnabled,
      faderVirtualBalance,
      faderNominalUsd,
      faderLeverage,
      faderSpikeWindowMin,
      faderSpikePctMin,
      faderChopRatioMin,
      faderChopTrendBreakMin,
      faderEdgeBandPct,
      faderTpReclaimFrac,
      faderTpFloorUsd,
      faderTpCeilingUsd,
      faderAdverseKillPct,
      faderTimeStopHours,
      faderReentryCooldownMin,
      faderLossStreakLimit,
      faderLossStreakWindowMin,
      faderLossStreakPauseMin,
      faderFeeRoundtripPct,
      faderSlippageRoundtripUsd,
      riskBasedSizing,
      riskSizingShadow,
      riskPctPerTrade,
      carryTrailEnabled,
      carryTrailArmPct,
      carryTrailArmPctEquity,
      carryTrailGiveBackPct,
      carrySpikeProtectionPct,
      carryLossCooldownMin,
      carryBeRatchetEnabled,
      carryBeArmPctEquity,
      carryBeArmUsd,
      carryBeFloorPctEquity,
      carryPriceOverFunding,
      carryVolSizePenalty,
      carryVolSizeMinMult,
      carryStaleTimeoutMin,
      carryStaleMinPnlEquity,
      carryApyDecayExitRatio,
      carryMaxHoldMin,
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
