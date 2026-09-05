import 'dotenv/config';
import { parseTpGrid } from '../modules/tpGrid.js';

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function loadConfig() {
  // isProduction = «не тестовый прогон»: глобального paper-режима нет, прод
  // всегда живой. Реальные ордера дополнительно гейтятся *_PROD_ENABLED, так
  // что локальный запуск без них ордеров не шлёт.
  // 🚨 NODE_ENV=test в проде превратит бота в симулятор — не ставить.
  const isProduction = process.env.NODE_ENV !== 'test';
  const mode = isProduction ? 'PRODUCTION' : 'PAPER';

  const privateKey = process.env.HL_PRIVATE_KEY || null;

  const agentPrivateKey = process.env.HL_AGENT_PRIVATE_KEY || null;

  if (isProduction && !agentPrivateKey && !privateKey) {
    throw new Error(
      'PRODUCTION run but neither HL_AGENT_PRIVATE_KEY nor HL_PRIVATE_KEY is set. ' +
      'Set HL_AGENT_PRIVATE_KEY (recommended) or HL_PRIVATE_KEY. Refusing to start.',
    );
  }

  if (isProduction && !agentPrivateKey) {
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
  // ── Setup Scanner snapshot interval (manual-helper, не торговая логика) ──
  const setupSnapshotIntervalMin = parseInt(process.env.SETUP_SNAPSHOT_INTERVAL_MIN || '60', 10);
  if (isNaN(setupSnapshotIntervalMin) || setupSnapshotIntervalMin < 1) {
    throw new Error(`SETUP_SNAPSHOT_INTERVAL_MIN must be integer ≥ 1. Got: "${process.env.SETUP_SNAPSHOT_INTERVAL_MIN}"`);
  }

  if (isNaN(liquidCacheHours) || liquidCacheHours <= 0) {
    throw new Error(`LIQUID_CACHE_HOURS must be positive number. Got: "${process.env.LIQUID_CACHE_HOURS}"`);
  }

  // ── Strategy constants (funding / exit math, shared) ──
  const roundTrip             = parseFloat(process.env.ROUND_TRIP              || '0.001');

  // Минимальный объём монеты, ниже — не торгуем. HUNTER_MIN_VOLUME читаем как
  // фолбэк: без него деплой со старым .env сбросит порог на дефолт.
  const minVolumeUsd = parseFloat(
    process.env.MIN_VOLUME_USD || process.env.HUNTER_MIN_VOLUME || '1000000',
  );

  // Anti-trend filter: не шортим если цена N мин назад была ниже current на ≥M%
  // (значит за N мин уже был устойчивый рост — это тренд, не reversion-кандидат).
  const trendLookbackMin = parseFloat(
    process.env.TREND_LOOKBACK_MIN || process.env.HUNTER_TREND_LOOKBACK_MIN || '15',
  );
  // HTF anti-trend filter: не шортим спайк, если за 1ч цена уже выросла на ≥M%
  // — часовик ещё разгоняется, спайк = продолжение, а не выдох.
  // 0/Infinity → выключен, окно фиксировано 60мин (HUNTER_TREND_1H_MIN).

  if (isNaN(trendLookbackMin) || trendLookbackMin <= 0 || trendLookbackMin > 20) {
    throw new Error(`TREND_LOOKBACK_MIN must be in (0, 20]. Got: "${process.env.TREND_LOOKBACK_MIN}"`);
  }

  // SL safety-buffer: софтверный hunter_sl при ЖИВОМ биржевом триггере
  // (hunter_sl_oid) — страховка, а не дублёр. Market-close на тике исполняется
  // хуже resting-триггера, поэтому софт-стоп ждёт, пока цена уйдёт ЗА sl_price
  // на N% — это признак, что биржевой триггер не сработал.
  // В paper триггера нет → буфер игнорируется (strategistHunter checkHunterExit).

  // Shadow exits: measurement-only. Пишем would-be P&L альтернативных выходов
  // (time-decay TP + chandelier ATR-trail) в shadow_exits на каждом close, НЕ
  // трогая реальные выходы. Агрегат в /strategies. Default on — это лог.

  // ── Hunter Long entry filters ──
  // Min-OI / min-volume гард: отсекаем low-liquidity монеты, склонные к
  // halt/delist. Null → пропуск (graceful при сбое scout'а), число ниже порога
  // → continue + лог.
  // Consecutive-SL ban: после N подряд SL'ов на одной монете (в окне
  // WINDOW_HOURS) — длинный бан BAN_HOURS поверх минутного postSlCooldown.

  // Cross-strategy cooldown: после ЛЮБОГО close монета на N минут запрещена для
  // второй Hunter-стратегии — иначе за успешным шортом идёт подбор ножа.


  // ── Риск на сделку в % от депо ────────────────────────────────────────────
  // Единственная величина в риск-модели, которая переносится между счетами:
  // 5% это $0.21 на депо $4 и $1000 на $20 000. Дистанция стопа остаётся по ATR
  // (волатильность монеты), а РАЗМЕР позиции из них выводится:
  //   нотионал = депо × RISK_PCT / дистанция_стопа.
  // Бот размер не навязывает (вход ручной) — он считает его и говорит, когда
  // фактический риск выше порога. Сужать стоп под слишком крупную позу нельзя:
  // это меняет вынос движением на вынос шумом.
  const adoptRiskPct = parseFloat(process.env.ADOPT_RISK_PCT || '5');
  if (!Number.isFinite(adoptRiskPct) || adoptRiskPct <= 0 || adoptRiskPct >= 100) {
    throw new Error(`ADOPT_RISK_PCT must be in (0, 100). Got: "${process.env.ADOPT_RISK_PCT}"`);
  }

  // ── TP-лимитка на бирже при подхвате ──────────────────────────────────────
  // Цель ставится СРАЗУ вместе со стопом и висит в книге reduce-only: исполняется
  // мейкером и не зависит от того, проснулся ли бот. Дистанция считается не от
  // ATR напрямую, а от фактической дистанции стопа (сам стоп уже по ATR и зажат
  // в ADOPT_STOP_MIN/MAX_PCT) — только так заявленный R:R не плывёт в зажатых
  // случаях. RR=1 значит «цель на том же расстоянии, что и стоп», то есть
  // breakeven-winrate 50%; RR=0.5 требует уже 67%, RR=0.33 — 75%.
  const adoptTpEnabled = (process.env.ADOPT_TP_ENABLED || 'true').toLowerCase() === 'true';
  const adoptTpRr      = parseFloat(process.env.ADOPT_TP_RR      || '1');
  const adoptTpMaxPct  = parseFloat(process.env.ADOPT_TP_MAX_PCT || '15');
  if (!Number.isFinite(adoptTpRr) || adoptTpRr <= 0 || adoptTpRr > 10) {
    throw new Error(`ADOPT_TP_RR must be in (0, 10]. Got: "${process.env.ADOPT_TP_RR}"`);
  }
  if (!Number.isFinite(adoptTpMaxPct) || adoptTpMaxPct <= 0 || adoptTpMaxPct >= 50) {
    throw new Error(`ADOPT_TP_MAX_PCT must be in (0, 50). Got: "${process.env.ADOPT_TP_MAX_PCT}"`);
  }

  // ── Выход лимиткой (post-only) вместо маркета ──────────────────────────────
  // Бот кладёт reduce-only Alo на свою сторону книги и ждёт; не налилось за
  // CLOSE_LIMIT_WAIT_MS — отменяет и добивает маркетом. 🚨 Фолбэк обязателен:
  // выход, который «может не исполниться», — это не выход.
  const closeLimitEnabled = (process.env.CLOSE_LIMIT_ENABLED || 'true').toLowerCase() === 'true';
  const closeLimitWaitMs  = parseInt(process.env.CLOSE_LIMIT_WAIT_MS  || '20000', 10);
  const closeLimitPollMs  = parseInt(process.env.CLOSE_LIMIT_POLL_MS  || '2000', 10);
  if (!Number.isFinite(closeLimitWaitMs) || closeLimitWaitMs < 1000 || closeLimitWaitMs > 300000) {
    throw new Error(`CLOSE_LIMIT_WAIT_MS must be in [1000, 300000]. Got: "${process.env.CLOSE_LIMIT_WAIT_MS}"`);
  }
  if (!Number.isFinite(closeLimitPollMs) || closeLimitPollMs < 250 || closeLimitPollMs > closeLimitWaitMs) {
    throw new Error(`CLOSE_LIMIT_POLL_MS must be in [250, CLOSE_LIMIT_WAIT_MS]. Got: "${process.env.CLOSE_LIMIT_POLL_MS}"`);
  }

  // ── Adopt Mode — бот-нянька на ручные входы (plans/adopt-mode-plan.md) ──
  // Ручная поза подхватывается в свободный слот как strategy_id='adopt', бот
  // сразу ставит реальный reduce-only стоп на бирже.
  const adoptEnabled          = (process.env.ADOPT_ENABLED || 'false').toLowerCase() === 'true';
  // «Бумажный adopt»: выход бумажных поз (manual_paper) ведётся той же
  // механикой, что реальный adopt, но без денег.
  const manualPaperAdoptEnabled = (process.env.MANUAL_PAPER_ADOPT_ENABLED || 'true').toLowerCase() === 'true';
  // ── Форвард по чужим прогнозам: сигнал TG-канала → бумажная поза ──────────
  // Размер крошечный и плечо 1 намеренно: замер про направление канала, а не
  // про то, сколько мы бы заработали.
  const tgSignalEnabled = (process.env.TG_SIGNAL_ENABLED || 'false').toLowerCase() === 'true';
  // `хэндл|Подпись` через запятую. Хэндлы держим в окружении, а не в коде:
  // это данные замера, и в публичном репозитории им делать нечего.
  const tgSignalChannels = String(process.env.TG_SIGNAL_CHANNELS || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [handle, label] = c.split('|').map((x) => x.trim());
      return { handle, label: label || handle };
    })
    .filter((c) => c.handle);
  const tgSignalSizeUsd = parseFloat(process.env.TG_SIGNAL_SIZE_USD || '10');
  const tgSignalLeverage = parseFloat(process.env.TG_SIGNAL_LEVERAGE || '1');
  const tgSignalPollMin = parseFloat(process.env.TG_SIGNAL_POLL_MIN || '5');
  const tgSignalMaxAgeMin = parseFloat(process.env.TG_SIGNAL_MAX_AGE_MIN || '30');
  const tgSignalDedupHours = parseFloat(process.env.TG_SIGNAL_DEDUP_HOURS || '6');
  const tgSignalMaxSlots = parseFloat(process.env.TG_SIGNAL_MAX_SLOTS || '10');
  if (!Number.isFinite(tgSignalSizeUsd) || tgSignalSizeUsd <= 0) {
    throw new Error(`TG_SIGNAL_SIZE_USD must be > 0. Got: "${process.env.TG_SIGNAL_SIZE_USD}"`);
  }
  if (!Number.isFinite(tgSignalLeverage) || tgSignalLeverage < 1 || tgSignalLeverage > 50) {
    throw new Error(`TG_SIGNAL_LEVERAGE must be in [1, 50]. Got: "${process.env.TG_SIGNAL_LEVERAGE}"`);
  }
  if (!Number.isFinite(tgSignalPollMin) || tgSignalPollMin < 1) {
    throw new Error(`TG_SIGNAL_POLL_MIN must be >= 1. Got: "${process.env.TG_SIGNAL_POLL_MIN}"`);
  }
  // 🚨 Возраст поста — предохранитель от подглядывания: без потолка первый
  // запуск открыл бы позы по прогнозам с известным исходом.
  if (!Number.isFinite(tgSignalMaxAgeMin) || tgSignalMaxAgeMin <= 0 || tgSignalMaxAgeMin > 240) {
    throw new Error(`TG_SIGNAL_MAX_AGE_MIN must be in (0, 240]. Got: "${process.env.TG_SIGNAL_MAX_AGE_MIN}"`);
  }
  if (!Number.isFinite(tgSignalDedupHours) || tgSignalDedupHours <= 0) {
    throw new Error(`TG_SIGNAL_DEDUP_HOURS must be > 0. Got: "${process.env.TG_SIGNAL_DEDUP_HOURS}"`);
  }
  if (!Number.isFinite(tgSignalMaxSlots) || tgSignalMaxSlots < 1) {
    throw new Error(`TG_SIGNAL_MAX_SLOTS must be >= 1. Got: "${process.env.TG_SIGNAL_MAX_SLOTS}"`);
  }
  // Максимальный возраст позы, которую ещё можно усыновить. 6ч ловит ручные
  // входы, даже если бот их заметил не сразу, и отсекает древние orphan'ы.
  // 🚨 Короткое окно (были 10мин) — мина: cooldown истекает позже окна, и поза
  // не усыновляется никогда.
  const adoptMaxAgeMin        = parseFloat(process.env.ADOPT_MAX_AGE_MIN        || '360');
  // Жёсткий стоп: ATR-режим подстраивает дистанцию под волатильность монеты
  // (фейдеру нужен воздух — фикс-% либо душит, либо болтается). dist = ATR(1h,14)
  // × MULT, зажат в [MIN_PCT, MAX_PCT]. Фолбэк на фикс-% если свечей/ATR нет.
  const adoptStopMode         = (process.env.ADOPT_STOP_MODE || 'atr').toLowerCase(); // 'atr' | 'pct'
  const adoptStopPct          = parseFloat(process.env.ADOPT_STOP_PCT           || '5');
  const adoptAtrMult          = parseFloat(process.env.ADOPT_ATR_MULT           || '1.5');
  const adoptStopMinPct       = parseFloat(process.env.ADOPT_STOP_MIN_PCT       || '2');
  const adoptStopMaxPct       = parseFloat(process.env.ADOPT_STOP_MAX_PCT       || '8');
  // Сопровождение (per-tick, мягче жёсткого стопа на бирже): BE-храповик + трейл,
  // переиспуск механики Hunter D3/трейла. ARM ≤ STOP_PCT логически (берём подарки
  // меньше стоп-дистанции). FLOOR 0 = безубыток.
  const adoptBeArmPct         = parseFloat(process.env.ADOPT_BE_ARM_PCT         || '1.5');
  const adoptBeFloorPct       = parseFloat(process.env.ADOPT_BE_FLOOR_PCT       || '0');
  // ⛔ Трейл выключен: отдавал обратно ~40% пика вместо обещанных 30%.
  // Флаг оставлен, чтобы вернуть поведение переменной, а не откатом кода.
  const adoptTrailEnabled     = (process.env.ADOPT_TRAIL_ENABLED || 'false').toLowerCase() === 'true';
  const adoptTrailArmPct      = parseFloat(process.env.ADOPT_TRAIL_ARM_PCT      || '2');
  const adoptTrailGiveBackPct = parseFloat(process.env.ADOPT_TRAIL_GIVE_BACK_PCT || '30');
  if (isNaN(adoptStopPct) || adoptStopPct <= 0 || adoptStopPct >= 20) {
    throw new Error(`ADOPT_STOP_PCT must be in (0, 20). Got: "${process.env.ADOPT_STOP_PCT}"`);
  }
  if (adoptStopMode !== 'atr' && adoptStopMode !== 'pct') {
    throw new Error(`ADOPT_STOP_MODE must be 'atr' or 'pct'. Got: "${process.env.ADOPT_STOP_MODE}"`);
  }
  if (isNaN(adoptAtrMult) || adoptAtrMult <= 0) {
    throw new Error(`ADOPT_ATR_MULT must be > 0. Got: "${process.env.ADOPT_ATR_MULT}"`);
  }
  if (isNaN(adoptStopMinPct) || adoptStopMinPct <= 0 || adoptStopMinPct >= adoptStopMaxPct) {
    throw new Error(`ADOPT_STOP_MIN_PCT must be in (0, ADOPT_STOP_MAX_PCT). Got: "${process.env.ADOPT_STOP_MIN_PCT}"`);
  }
  if (isNaN(adoptStopMaxPct) || adoptStopMaxPct >= 20) {
    throw new Error(`ADOPT_STOP_MAX_PCT must be < 20. Got: "${process.env.ADOPT_STOP_MAX_PCT}"`);
  }
  if (isNaN(adoptMaxAgeMin) || adoptMaxAgeMin <= 0) {
    throw new Error(`ADOPT_MAX_AGE_MIN must be > 0. Got: "${process.env.ADOPT_MAX_AGE_MIN}"`);
  }
  if (isNaN(adoptBeArmPct) || adoptBeArmPct <= 0) {
    throw new Error(`ADOPT_BE_ARM_PCT must be > 0. Got: "${process.env.ADOPT_BE_ARM_PCT}"`);
  }
  if (isNaN(adoptBeFloorPct) || adoptBeFloorPct < 0 || adoptBeFloorPct >= adoptBeArmPct) {
    throw new Error(`ADOPT_BE_FLOOR_PCT must be in [0, ADOPT_BE_ARM_PCT). Got: "${process.env.ADOPT_BE_FLOOR_PCT}"`);
  }
  if (isNaN(adoptTrailArmPct) || adoptTrailArmPct <= 0) {
    throw new Error(`ADOPT_TRAIL_ARM_PCT must be > 0. Got: "${process.env.ADOPT_TRAIL_ARM_PCT}"`);
  }
  if (isNaN(adoptTrailGiveBackPct) || adoptTrailGiveBackPct <= 0 || adoptTrailGiveBackPct >= 100) {
    throw new Error(`ADOPT_TRAIL_GIVE_BACK_PCT must be in (0, 100). Got: "${process.env.ADOPT_TRAIL_GIVE_BACK_PCT}"`);
  }
  // Time-cut SHADOW: measurement-only. Не показала MFE ≥ GREEN_PCT за MIN минут
  // → would-be выход по текущей цене, пишем в shadow_exits. Торговлю не трогает.
  const adoptTimecutShadowEnabled = (process.env.ADOPT_TIMECUT_SHADOW_ENABLED || 'true').toLowerCase() === 'true';
  const adoptTimecutMin           = parseFloat(process.env.ADOPT_TIMECUT_MIN       || '75');
  const adoptTimecutGreenPct      = parseFloat(process.env.ADOPT_TIMECUT_GREEN_PCT || '0.3');
  if (isNaN(adoptTimecutMin) || adoptTimecutMin <= 0) {
    throw new Error(`ADOPT_TIMECUT_MIN must be > 0. Got: "${process.env.ADOPT_TIMECUT_MIN}"`);
  }
  if (isNaN(adoptTimecutGreenPct) || adoptTimecutGreenPct <= 0) {
    throw new Error(`ADOPT_TIMECUT_GREEN_PCT must be > 0. Got: "${process.env.ADOPT_TIMECUT_GREEN_PCT}"`);
  }
  // Теневой трейл (гипотеза adopt-trail-025r): отступ = R_MULT × исходный риск
  // вместо доли пика, которая на малом пике схлопывается в шум. Только лог.
  const adoptTrailShadowEnabled = (process.env.ADOPT_TRAIL_SHADOW_ENABLED || 'true').toLowerCase() === 'true';

  // Target-trail: на подходе к цели снять reduce-only лимитку и вести стоп за
  // ценой. ⛔ ВЫКЛЮЧЕН — типичная сделка выходила хуже простой фиксации.
  // TP-сетка: цель лесенкой вместо одной лимитки (см. шапку tpGrid.js).
  // Пусто = выключено. Формат «доля@R, доля@R» — сумма долей строго < 1, остаток
  // уходит под обычную цель/трейл. Спецификацию проверяем ЗДЕСЬ и падаем на
  // старте: кривая сетка — это неправильные ордера на живом счету, и узнать об
  // этом на первом же усыновлении хуже, чем не подняться.
  const adoptTpGridSpec = String(process.env.ADOPT_TP_GRID || '').trim();
  // Пол трейла БИРЖЕВЫМ ордером: бот не закрывает позу сам, а переставляет
  // стоп за пиком (см. decideFloorMove). Выключено по умолчанию — правило
  // меняет способ выхода, а не только его цену.
  const adoptTrailFloorOrder   = (process.env.ADOPT_TRAIL_FLOOR_ORDER || 'false').toLowerCase() === 'true';
  const adoptTrailFloorStepPct = parseFloat(process.env.ADOPT_TRAIL_FLOOR_STEP_PCT || '0.25');
  const adoptTargetTrailEnabled    = (process.env.ADOPT_TARGET_TRAIL_ENABLED || 'false').toLowerCase() === 'true';
  const adoptTargetTrailArmR       = parseFloat(process.env.ADOPT_TARGET_TRAIL_ARM_R       || '0.9');
  const adoptTargetTrailGiveBackR  = parseFloat(process.env.ADOPT_TARGET_TRAIL_GIVE_BACK_R || '0.25');
  if (isNaN(adoptTargetTrailArmR) || adoptTargetTrailArmR <= 0) {
    throw new Error(`ADOPT_TARGET_TRAIL_ARM_R must be > 0. Got: "${process.env.ADOPT_TARGET_TRAIL_ARM_R}"`);
  }
  if (isNaN(adoptTrailFloorStepPct) || adoptTrailFloorStepPct <= 0) {
    throw new Error(`ADOPT_TRAIL_FLOOR_STEP_PCT must be > 0. Got: "${process.env.ADOPT_TRAIL_FLOOR_STEP_PCT}"`);
  }
  const adoptTpGrid = parseTpGrid(adoptTpGridSpec);
  if (adoptTpGrid.error) {
    throw new Error(`ADOPT_TP_GRID: ${adoptTpGrid.error}. Got: "${adoptTpGridSpec}"`);
  }
  if (isNaN(adoptTargetTrailGiveBackR) || adoptTargetTrailGiveBackR <= 0) {
    throw new Error(`ADOPT_TARGET_TRAIL_GIVE_BACK_R must be > 0. Got: "${process.env.ADOPT_TARGET_TRAIL_GIVE_BACK_R}"`);
  }
  const adoptShadowTrailR       = parseFloat(process.env.ADOPT_SHADOW_TRAIL_R || '0.25');
  if (isNaN(adoptShadowTrailR) || adoptShadowTrailR <= 0) {
    throw new Error(`ADOPT_SHADOW_TRAIL_R must be > 0. Got: "${process.env.ADOPT_SHADOW_TRAIL_R}"`);
  }
  // Пик-алерт: систематизация дискрец-выхода. Юзер закрывает 63%
  // adopt-поз рукой (capture 68% MFE) — даём звонок в момент решения: пик ≥ MFE_PCT
  // (p75 его шортов ≈2.5%) и откат ≥ GIVEBACK_PCT от пика. GIVEBACK строго МЕНЬШЕ
  // ADOPT_TRAIL_GIVE_BACK_PCT (30) — иначе трейл закроет раньше звонка.
  const adoptPeakAlertEnabled     = (process.env.ADOPT_PEAK_ALERT_ENABLED || 'true').toLowerCase() === 'true';
  const adoptPeakAlertMfePct      = parseFloat(process.env.ADOPT_PEAK_ALERT_MFE_PCT      || '2.5');
  const adoptPeakAlertGiveBackPct = parseFloat(process.env.ADOPT_PEAK_ALERT_GIVEBACK_PCT || '15');
  if (isNaN(adoptPeakAlertMfePct) || adoptPeakAlertMfePct <= 0) {
    throw new Error(`ADOPT_PEAK_ALERT_MFE_PCT must be > 0. Got: "${process.env.ADOPT_PEAK_ALERT_MFE_PCT}"`);
  }
  if (isNaN(adoptPeakAlertGiveBackPct) || adoptPeakAlertGiveBackPct <= 0 || adoptPeakAlertGiveBackPct >= adoptTrailGiveBackPct) {
    throw new Error(`ADOPT_PEAK_ALERT_GIVEBACK_PCT must be in (0, ADOPT_TRAIL_GIVE_BACK_PCT). Got: "${process.env.ADOPT_PEAK_ALERT_GIVEBACK_PCT}"`);
  }

  // ── Daily loss limit — дневной стоп-лосс по fills ──
  // День достиг −LIMIT$ net → urgent-алерт, гейт новых авто-входов и тильт-алерт
  // на усыновления до полуночи. 🚨 Няньку и выходы не трогает: вход без стопа
  // хуже, чем превышенный лимит.
  const dailyLossLimitEnabled = (process.env.DAILY_LOSS_LIMIT_ENABLED || 'true').toLowerCase() === 'true';
  const dailyLossLimitUsd     = parseFloat(process.env.DAILY_LOSS_LIMIT_USD || '5');
  if (isNaN(dailyLossLimitUsd) || dailyLossLimitUsd <= 0) {
    throw new Error(`DAILY_LOSS_LIMIT_USD must be > 0. Got: "${process.env.DAILY_LOSS_LIMIT_USD}"`);
  }

  // ── Screen (экран торгуемых монет) ──
  // Порог трения: монета попадает на экран по цене входа, а не по движению.
  // 25бп ≈ половина вселенной с живой книгой.
  const screenMaxFrictionBp = parseFloat(process.env.SCREEN_MAX_FRICTION_BP || '25');
  if (isNaN(screenMaxFrictionBp) || screenMaxFrictionBp <= 0) {
    throw new Error(`SCREEN_MAX_FRICTION_BP must be > 0. Got: "${process.env.SCREEN_MAX_FRICTION_BP}"`);
  }
  // Бюджет сделок за день. Это ГЕЙТ, а не счётчик: Trade Ticket отбивает вход
  // по достижении лимита (src/modules/tradeGuards.js).
  const screenTradesPerDay = parseInt(process.env.SCREEN_TRADES_PER_DAY || '5', 10);
  if (isNaN(screenTradesPerDay) || screenTradesPerDay <= 0) {
    throw new Error(`SCREEN_TRADES_PER_DAY must be > 0. Got: "${process.env.SCREEN_TRADES_PER_DAY}"`);
  }
  // Пауза после закрытия сделки по монете, минуты. 0 = выключено.
  const reentryCooldownMin = parseInt(process.env.REENTRY_COOLDOWN_MIN || '15', 10);
  if (isNaN(reentryCooldownMin) || reentryCooldownMin < 0) {
    throw new Error(`REENTRY_COOLDOWN_MIN must be >= 0. Got: "${process.env.REENTRY_COOLDOWN_MIN}"`);
  }
  // Нотионал, от которого считается стоимость трения в карточке. Биржевой
  // минимум ордера — на нём и показываем, иначе цифра не про эту жизнь.
  const screenNotionalUsd = parseFloat(process.env.SCREEN_NOTIONAL_USD || '10');
  if (isNaN(screenNotionalUsd) || screenNotionalUsd <= 0) {
    throw new Error(`SCREEN_NOTIONAL_USD must be > 0. Got: "${process.env.SCREEN_NOTIONAL_USD}"`);
  }

  // ── Risk-based position sizing (cross-strategy: Hunter / Hunter Long / ChillBoy) ──
  const riskBasedSizing  = (process.env.RISK_BASED_SIZING  || 'false').toLowerCase() === 'true';
  const riskSizingShadow = (process.env.RISK_SIZING_SHADOW || 'true').toLowerCase() === 'true';
  const riskPctPerTrade  = parseFloat(process.env.RISK_PCT_PER_TRADE || '0.01');

  // ── Candy Girl — SIGNAL-ONLY радар (1h EMA-тренд + 5m pullback-reclaim) ──
  // 🚨 НЕ стратегия: только алерты в ntfy, позицию не открывает никогда.
  const trendEmaFast1h             = parseInt(process.env.TREND_EMA_FAST_1H || process.env.CANDY_GIRL_FAST_1H  || '20', 10);
  const trendEmaSlow1h             = parseInt(process.env.TREND_EMA_SLOW_1H || process.env.CANDY_GIRL_SLOW_1H  || '200', 10);
  const trendSlopeLookback      = parseInt(process.env.TREND_SLOPE_LOOKBACK || process.env.CANDY_GIRL_SLOPE_LOOKBACK || '10', 10);
  if (!Number.isInteger(trendEmaFast1h) || trendEmaFast1h < 2 || trendEmaFast1h >= trendEmaSlow1h) {
    throw new Error(`TREND_EMA_FAST_1H must be integer in [2, TREND_EMA_SLOW_1H). Got: "${process.env.TREND_EMA_FAST_1H || process.env.CANDY_GIRL_FAST_1H}"`);
  }
  if (!Number.isInteger(trendEmaSlow1h) || trendEmaSlow1h < 10 || trendEmaSlow1h > 400) {
    throw new Error(`TREND_EMA_SLOW_1H must be integer in [10, 400]. Got: "${process.env.TREND_EMA_SLOW_1H || process.env.CANDY_GIRL_SLOW_1H}"`);
  }
  if (!Number.isInteger(trendSlopeLookback) || trendSlopeLookback < 1) {
    throw new Error(`TREND_SLOPE_LOOKBACK must be positive integer. Got: "${process.env.TREND_SLOPE_LOOKBACK || process.env.CANDY_GIRL_SLOPE_LOOKBACK}"`);
  }

  if (isNaN(riskPctPerTrade) || riskPctPerTrade <= 0 || riskPctPerTrade > 0.1) {
    throw new Error(`RISK_PCT_PER_TRADE must be in (0, 0.1]. Got: "${process.env.RISK_PCT_PER_TRADE}"`);
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

  // WS-фид allMids: выходы считаются на тиках, а не раз в 15с.
  const wsFeedEnabled     = (process.env.HL_WS_FEED_ENABLED    || 'false').toLowerCase() === 'true';
  const wsExitIntervalMs  = parseInt(process.env.HL_WS_EXIT_INTERVAL_MS  || '2000', 10);

  return {
    mode,
    isProduction,

    wallet: {
      address:         walletAddress,
      privateKey,                                        // основной ключ (fallback)
      agentPrivateKey: process.env.HL_AGENT_PRIVATE_KEY || null,  // ключ агента для торговли
    },

    trading: {
      minApy,
      entryApy,
      leverage,
      fakeBalance:       process.env.FAKE_BALANCE ? parseFloat(process.env.FAKE_BALANCE) : null,
      // Монеты, которые нельзя торговать (HLP-индексы, деривативы и т.п.)
      coinBlacklist:     new Set(
        (process.env.COIN_BLACKLIST || 'STBL')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
      // Витрина Hot Movers: сузить ленту до своих монет. Пусто = вся вселенная.
      // Не гейт входа — фильтр внимания: остальная движуха просто не рисуется.
      // Монеты с открытой позой всё равно доезжают до ленты (см. movers.js).
      hotMoversCoins:    new Set(
        (process.env.HOT_MOVERS_COINS || '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
      roundTrip,
      liquidTopN,
      liquidMinVolume,
      liquidCacheMs: liquidCacheHours * 3_600_000,
      setupSnapshotIntervalMin,
      minVolumeUsd,
      trendLookbackMin,
      adoptEnabled,
      manualPaperAdoptEnabled,
      tgSignalEnabled,
      tgSignalChannels,
      tgSignalSizeUsd,
      tgSignalLeverage,
      tgSignalPollMin,
      tgSignalMaxAgeMin,
      tgSignalDedupHours,
      tgSignalMaxSlots,
      adoptMaxAgeMin,
      adoptStopMode,
      adoptStopPct,
      adoptAtrMult,
      adoptStopMinPct,
      adoptStopMaxPct,
      adoptBeArmPct,
      adoptBeFloorPct,
      adoptRiskPct,
      adoptTpEnabled,
      adoptTpRr,
      adoptTpMaxPct,
      closeLimitEnabled,
      closeLimitWaitMs,
      closeLimitPollMs,
      adoptTrailEnabled,
      adoptTargetTrailEnabled,
      adoptTargetTrailArmR,
      adoptTargetTrailGiveBackR,
      adoptTpGridLegs: adoptTpGrid.legs || [],
      adoptTrailFloorOrder,
      adoptTrailFloorStepPct,
      adoptTrailArmPct,
      adoptTrailGiveBackPct,
      adoptTimecutShadowEnabled,
      adoptTimecutMin,
      adoptTimecutGreenPct,
      adoptTrailShadowEnabled,
      adoptShadowTrailR,
      adoptPeakAlertEnabled,
      adoptPeakAlertMfePct,
      adoptPeakAlertGiveBackPct,
      dailyLossLimitEnabled,
      dailyLossLimitUsd,
      screenMaxFrictionBp,
      screenTradesPerDay,
      reentryCooldownMin,
      screenNotionalUsd,
      // ── Candy Girl радар (signal-only) ──
      trendEmaFast1h,
      trendEmaSlow1h,
      trendSlopeLookback,
      riskBasedSizing,
      riskSizingShadow,
      riskPctPerTrade,
      // ── WS price feed ──
      wsFeedEnabled,
      wsExitIntervalMs,
    },

    risk: {
      maxDrawdownPct,                  // -X% от sessionStartEquity → стоп открытий
      cbMaxLosses,                     // макс убытков подряд в окне
      cbWindowMs:  60 * 60_000,        // окно скользящего счётчика (1ч, hardcoded)
      cbPauseMs:   cbPauseHours * 3_600_000,
    },

    // Рубильники уведомлений. Риск-события от них не зависят — идут всегда.
    alerts: {
      noisy: process.env.ALERTS_NOISY === 'true',  // FOMO, аномалии APY, баны
      trade: process.env.ALERTS_TRADE === 'true',  // open/close/SL/TP
    },

    ntfy: {
      url:   process.env.NTFY_URL   || 'http://ntfy:80',
      topic: process.env.NTFY_TOPIC || 'hl-signals',
      token: process.env.NTFY_TOKEN || '',
      // Приоритет пуша (шкала ntfy 1..5, НЕ Gotify 0..8): 1=min, 2=low,
      // 3=default (звук + одно вибро), 4=high (вибро+peek), 5=urgent (долгое
      // вибро, обход DND). Дефолт 3 = звук без агрессивной тряски.
      priority: Math.min(5, Math.max(1, parseInt(process.env.NTFY_PRIORITY || '3', 10) || 3)),
    },

    // ── Почта (self-hosted Listmonk /api/tx) ──
    // Зеркалит горячие ntfy-пуши в письмо + ежедневный дайджест. Fail-soft:
    // без url/creds/template/to mail.js тихо no-op.
    mail: {
      listmonkUrl: process.env.LISTMONK_URL || '',
      user:        process.env.LISTMONK_USER || '',
      pass:        process.env.LISTMONK_PASS || '',
      // ID транзакционного шаблона Listmonk (содержит {{ .Tx.Data.body_html | Safe }}).
      templateId:  parseInt(process.env.LISTMONK_TX_TEMPLATE_ID || '0', 10) || null,
      from:        process.env.LISTMONK_FROM_EMAIL || '',
      to:          process.env.MAIL_TO || '',
      // Мгновенное письмо на каждый горячий пуш (priority ≥ 3). Дайджест — отдельно (cron).
      instant:     (process.env.MAIL_INSTANT || 'true').toLowerCase() === 'true',
    },

    // ── Binance (read-only, для Tax Collector) ──
    // Модуль taxCollector сам проверяет наличие ключей через isConfigured()
    // и тихо отключается, если их нет. Не блокируем старт бота.
    binance: {
      apiKey:    process.env.BINANCE_API_KEY    || null,
      apiSecret: process.env.BINANCE_API_SECRET || null,
    },

    // Kraken, read-only. Право нужно одно: Query ledger entries.
    kraken: {
      apiKey:    process.env.KRAKEN_API_KEY    || null,
      apiSecret: process.env.KRAKEN_API_SECRET || null,
    },
  };
}

// Единственный экземпляр — загружается один раз при старте
export const config = loadConfig();
