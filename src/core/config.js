import 'dotenv/config';

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function loadConfig() {
  // Глобальный paper-режим (TRADING_MODE=PAPER|PRODUCTION) удалён 2026-06-20.
  // Прод всегда живой. «Paper» осталось только в двух местах: (а) тест-харнесс
  // под NODE_ENV=test (симуляция без реальных ордеров), (б) per-position
  // shadow-слоты A/B (mode='PAPER', напр. hunter_oi/fadehot). Поэтому isProduction
  // теперь = «не тестовый прогон». Реальные ордера дополнительно гейтятся
  // *_PROD_ENABLED-флагами, так что локальный запуск без них ордеров не шлёт.
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

  // AGGRESSIVE_MODE/AGG_* preset удалён 2026-06-20 (carry-эпоха, не потреблялся).
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
  // carry-эпоха (maxPayback/maxBreakeven/negativeFunding/delist*/minEntryApyFloor/
  // predictedDrop/fundingGate) удалена 2026-06-20 — поля не потреблялись живым кодом.

  // Fade strategy удалена 2026-06-15 (0 сделок за трек, deprecated с 12 мая).


  // ── Market Regime: per-coin velocity entry gate (Iter A) ──
  // Защита от «шорта в зелёный рынок»: перед OPEN смотрим, что монета сделала
  // за последние N минут. Если выросла > pump% (для short) или упала > pump%
  // (для long) — skip entry. Default off — включается флагом.
    (process.env.MARKET_REGIME_VELOCITY_ENABLED || 'false').toLowerCase() === 'true';
  // Bucket 1: быстрый спайк (default 30мин/3%)
  // Bucket 2: медленный pump→plateau (default 2ч/5%). XMR/TON-паттерн: pump за 2ч, потом
  // плато → 30-мин bucket пропускает, нужен второй уровень. Set MARKET_REGIME_LOOKBACK2_MIN=0
  // чтобы отключить второй bucket.


  // ── Market Regime: BTC regime entry gate (Iter B) ──
  // Глобальный гейт: если BTC pumpнул > pct за последние N мин — блокируем
  // новые short-входы (рынок зелёный). Симметрично: BTC dumpнул > pct → блокируем
  // long-входы. Дополняет per-coin velocity gate (Iter A): coin может стоять
  // ровно, но BTC тащит весь рынок — short в зелёный рынок плохая идея.
  // Default off — включается флагом.
    (process.env.MARKET_REGIME_BTC_ENABLED || 'false').toLowerCase() === 'true';


  // ── Sniper-Hunter strategy (Volatility Spike Mean-Reversion) ──
  // Default false: включить вручную через HUNTER_ENABLED=true, когда будем готовы тестировать в PAPER.
  // Iter C: отдельный двойной gate для PROD-пути Hunter'а. Даже если HUNTER_ENABLED=true,
  // в isProduction режиме реальные ордера НЕ отправляются пока HUNTER_PROD_ENABLED=true.
  // Позволяет собирать PAPER-сигналы на боевом боте без риска реального исполнения.

  // Hunter-only leverage: умножает РАЗМЕР позиции (а не только маржинальный буфер).
  // На балансе $100 при utilization=0.5: 1x → $50 поза, 3x → $150, 5x → $250.
  // SL=2% при 5x = −5% от баланса; ликвидационный буфер уменьшается пропорционально.
  // Default 1 = поведение Iter C без изменений. Изолировано от carry/fade — там всегда 1x.
  // Hunter хантит на более широкой вселенной, чем carry/fade (им нужна высокая ликвидность для
  // минимального slippage, Hunter'у — вариативность). Default $1M — захватывает 30–50 монет на HL
  // вместо ~12. PAPER-безопасно; для PROD (Iter C) потребуется size-cap и осторожность.
  // Имя сменилось вместе со снятием Hunter'а (2026-08-30). Старое читаем как
  // фолбэк, чтобы деплой не сбросил порог на дефолт, пока .env не обновлён.
  const minVolumeUsd = parseFloat(
    process.env.MIN_VOLUME_USD || process.env.HUNTER_MIN_VOLUME || '1000000',
  );

  // Доля баланса на позицию Hunter. SHORT и Long разделены: данные 2026-05-15
  // показали у SHORT положительное матожидание (+$0.56/сделку на 12 PROD-trades),
  // у Long — отрицательное. Поэтому SHORT поднимаем стадийно, Long держим
  // консервативно. Итоговый нотиональный множитель к балансу = util × hunterLeverage.
  // Сайзинг от ВСЕГО депо (equity), а не от свободного остатка. Когда у оператора
  // открыта ручная поза, она ест свободное → бот раньше ужимался дважды (брал
  // util от уменьшенного остатка). Теперь бот целит util от полного депо, но
  // НЕ больше свободной маржи (потолок) — стабильный размер «половина депо», и
  // свободные деньги не простаивают. Когда других поз нет, free=equity → размер
  // тот же, что раньше (см. executor/sizing.js equityCappedNotional). Kill-switch.
  // Минимальная доля от НОРМАЛЬНОГО размера бота, ниже которой он не открывает
  // (защита от «пыли», когда свободной маржи мало из-за открытых ручных поз).
  // 0.5 = «бери ≥50% обычной позы или жди». Не привязано к $ — масштаб под депо.

  // Anti-trend filter: не шортим если цена N мин назад была ниже current на ≥M%
  // (значит за N мин уже был устойчивый рост — это тренд, не reversion-кандидат).
  const trendLookbackMin = parseFloat(
    process.env.TREND_LOOKBACK_MIN || process.env.HUNTER_TREND_LOOKBACK_MIN || '15',
  );
  // HTF anti-trend filter (2026-07-22): не шортим спайк, если за 1ч цена уже
  // выросла на ≥M% — часовик ещё разгоняется, спайк = продолжение, не выдох.
  // Данные (61 live-сделка): весь минус Hunter кучкуется на входах с 1h>+5%
  // (n=20, −$8.14, WR 40%). Гейт на 1h переводит ожидание из −0.08 в плюс.
  // 0/Infinity → фильтр выключен. Окно фиксировано 60мин (HUNTER_TREND_1H_MIN).
  // Post-SL cooldown: после SL Hunter блокирует эту монету на N минут.
  // Защита от паттерна APE 17:27→17:56→18:23 — повторные входы по более высокой цене.
  // Time-stop: позиция Hunter не должна висеть вечно. Mean-reversion обычно отрабатывает
  // за минуты-десятки. Если за HUNTER_TIME_STOP_MIN ни SL ни TP — закрываем по market.

  if (isNaN(trendLookbackMin) || trendLookbackMin <= 0 || trendLookbackMin > 20) {
    throw new Error(`TREND_LOOKBACK_MIN must be in (0, 20]. Got: "${process.env.TREND_LOOKBACK_MIN}"`);
  }

  // ── Hunter trailing TP (Iter D) ──
  // Trail заменяет fixed TP-trigger когда unrealized пересекает ARM_PCT.
  // ARM_PCT < HUNTER_TP_PCT (3%) — arm раньше, чтобы успеть cancel exchange TP.
  // GIVE_BACK_PCT — доля peak'а, которую готовы отдать обратно перед close.
  // SHADOW_LOG: если true — логируем "would-have-trailed" события даже когда
  // основной флаг false. Используется для оценки эффекта до PROD-активации.
  // Uncap TP при взведённом трейле: если true, фикс-TP (+3%) НЕ закрывает позу,
  // когда трейл armed — поза едет на трейле сколько угодно (выход только по
  // откату giveback/SL/BE). false = текущее поведение (потолок +3% остаётся).
  // Дефолт false: наблюдаем shadow-лог [Hunter UNCAP-SHADOW] на ≥15 сделках.


  // Iter D3: breakeven храповик. Как только peak unrealized% ≥ ARM, взводим —
  // и больше не даём unrealized% уйти ≤ FLOOR (0 = безубыток). Ловит "ушёл в
  // плюс → развернулся в минус" (кейс ZEC: peak +3% → полный SL −2%). Порог
  // ARM ниже trail-arm, чтобы ловить и небольшие подарки. Проверяется ВЫШЕ SL.


  // SL safety-buffer (2026-06-19): софтверный hunter_sl при ЖИВОМ биржевом
  // триггере (hunter_sl_oid) — страховка, а не дублёр. Живые данные: софт-стоп
  // закрывает в среднем хуже биржевого (−1.61 vs −1.24, n=7+13), т.к. market-close
  // на тике медленнее resting-триггера. Буфер заставляет софт-стоп ждать, пока
  // цена уйдёт ЗА sl_price на N% (= признак, что биржевой триггер не исполнился).
  // В paper триггера нет → буфер игнорируется (см. strategistHunter checkHunterExit).

  // Shadow exits (2026-06-14): measurement-only. Мерим would-be P&L альтернативных
  // выходов (time-decay TP + chandelier ATR-trail) и пишем в shadow_exits на каждом
  // close, НЕ трогая реальные выходы. Агрегат в /strategies. Default on — это лог.

  // ── Hunter Long (Iter E.1) — Long-after-dump, зеркало Hunter SHORT ──
  // Default false: PAPER-only включается отдельно. Заняла слот после Fade soft-kill.
  // Все параметры зеркальны HUNTER_* но с собственными дефолтами под dump-сторону:
  // anti-trend агрессивнее (6% vs 8%) — дампы чаще = real news (delist/scam).
  // Iter E.3: PROD-gate, mirror HUNTER_PROD_ENABLED. Реальные ордера на бирже
  // только при HUNTER_LONG_PROD_ENABLED=true в isProduction режиме.

  // ── Hunter Long entry filters (2026-05-20: после анализа Hunter LONG −$1.93/12tr) ──
  // Min-OI / min-volume гард: отсекаем low-liquidity монеты, склонные к halt/delist.
  // TST −$1.80 (external_close) — кейс-мотивация. Null → пропуск (deg. graceful при
  // API-сбоях scout'а), число ниже порога → continue + лог.
  // Consecutive-SL ban: после N подряд SL'ов на одной монете (в окне WINDOW_HOURS)
  // ставим длинный бан BAN_HOURS. Защита от serial-loser паттерна (SAGA ×2 SL 2026-05-14).
  // Стандартный postSlCooldown остаётся базовой защитой (минуты), это — добавка поверх.

  // Cross-strategy cooldown: после ЛЮБОГО close (SHORT или LONG) монета на N минут
  // запрещена для второй Hunter-стратегии. Защита от подбора ножа после успешного
  // шорта (SAGA 2026-05-13: SHORT TP +$1.13 → LONG ×2 SL).


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
  // Замер 14.08.2026: 1440 из 1440 закрытий ушли тейкером, медиана спреда 15.98 бп,
  // и на комиссии+спред пришлось ~69% всего минуса. Поэтому бот сначала кладёт
  // reduce-only Alo на СВОЮ сторону книги и ждёт; не налилось за CLOSE_LIMIT_WAIT_MS —
  // отменяет и добивает маркетом. Фолбэк обязателен: выход, который «может не
  // исполниться», — это не выход, а надежда.
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
  // Юзер открывает позу руками → бот подхватывает её в свободный слот как
  // strategy_id='adopt' и СРАЗУ ставит реальный reduce-only стоп на бирже
  // (чинит главный леак: держал лузеров до нуля). Храповик/трейл — следующим шагом.
  const adoptEnabled          = (process.env.ADOPT_ENABLED || 'false').toLowerCase() === 'true';
  // «Бумажный adopt»: бот ведёт ВЫХОД личных бумажных поз (manual_paper) той же
  // механикой, что реальный adopt (ATR-стоп при открытии + BE-храповик + трейл,
  // analyzeAdopt). Без реальных денег — тренировка выходной логики на своих входах.
  const manualPaperAdoptEnabled = (process.env.MANUAL_PAPER_ADOPT_ENABLED || 'true').toLowerCase() === 'true';
  // Hunter SHORT +OI (A/B paper-двойник, 2026-06-19) — точная копия боевого
  // Hunter SHORT, отличие РОВНО одно: OI-divergence ворота на входе. Шортит памп,
  // только если рост OI за 15м ≤ HUNTER_OI_DIV_MAX_PCT (большой рост OI = свежие
  // лонги = пробой, не выдох → не шортим). PAPER-only, независимый слот
  // strategy_id='hunter_oi'. Своё cooldown-состояние живёт в hunterOiPaperTick —
  // НЕ пишет в боевые cooldown'ы Hunter (бумага не блокирует живые входы).
  // OI-ворота на БОЕВОМ Hunter SHORT (2026-07-06, по A/B: 35 сд hunter_oi
  // +0.73%/сд против 0.30% у hunter без ворот). true → оба live-входных пути
  // (coordinator 15-сек скан + WS-тик) фильтруют по ΔOI15м ≤ HUNTER_OI_DIV_MAX_PCT.
  // Paper-слот hunter (без ворот) остаётся A/B-контролем.
  // Fade-high-ER paper — PAPER-only shadow-слот, forward-валидация правила
  // fade выдохшегося хвоста (см. fadeHotSignal.js / memory fadehot_build_plan).
  // 6ч по умолчанию: ловит нормальные ручные входы (даже если бот заметил их не
  // сразу — был в другой монете или рестартился), но всё ещё отсекает древние
  // забытые orphan'ы/carry-ноги. Был 10мин — оказался миной (cooldown истекал
  // позже окна, поза не усыновлялась никогда). 2026-06-16.
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
  // Трейл выключен 23.08.2026 по решению оператора: за 127 закрытий adopt_trail_tp
  // медиана отдачи от пика = 40% при пороге 30% (p90 = 68%), а худший случай
  // закрылся с пика +2.86% в минус −0.72%. Правило «дать прибыли тянуться» на
  // практике превращалось в «отдать её обратно». Флаг оставлен, чтобы вернуть
  // поведение одной переменной, а не откатом кода.
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
  // Time-cut SHADOW (2026-07-02): measurement-only. Анализ 131 adopt-сделки: 23
  // стопа съели ~$70 при общем +$47, и НИ ОДИН стоп не видел MFE ≥1% — позы
  // умирали часами, не зеленея. Модель: не показала MFE ≥ GREEN_PCT за MIN минут
  // → would-be выход по текущей цене. Пишем в shadow_exits, торговлю НЕ трогаем;
  // решение о живом включении — по месяцу данных. Default on — это лог.
  const adoptTimecutShadowEnabled = (process.env.ADOPT_TIMECUT_SHADOW_ENABLED || 'true').toLowerCase() === 'true';
  const adoptTimecutMin           = parseFloat(process.env.ADOPT_TIMECUT_MIN       || '75');
  const adoptTimecutGreenPct      = parseFloat(process.env.ADOPT_TIMECUT_GREEN_PCT || '0.3');
  if (isNaN(adoptTimecutMin) || adoptTimecutMin <= 0) {
    throw new Error(`ADOPT_TIMECUT_MIN must be > 0. Got: "${process.env.ADOPT_TIMECUT_MIN}"`);
  }
  if (isNaN(adoptTimecutGreenPct) || adoptTimecutGreenPct <= 0) {
    throw new Error(`ADOPT_TIMECUT_GREEN_PCT must be > 0. Got: "${process.env.ADOPT_TIMECUT_GREEN_PCT}"`);
  }
  // Теневой трейл (2026-08-15, гипотеза adopt-trail-025r). Текущий трейл отдаёт
  // долю ПИКА, поэтому на малом пике буфер схлопывается в шум (разбор ACE 14.08).
  // Альтернатива: отступ = R_MULT × исходный риск. Только лог, торговлю не трогает;
  // решение — по стоп-правилу гипотезы (n ≥ 60 пар), не раньше. Default on = это лог.
  const adoptTrailShadowEnabled = (process.env.ADOPT_TRAIL_SHADOW_ENABLED || 'true').toLowerCase() === 'true';

  // Target-trail (03.09.2026): на подходе к цели снять reduce-only лимитку и
  // дальше вести стоп за ценой. ⚠️ ВЫКЛЮЧЕН по умолчанию: замер на 46 сделках
  // дал +0.154R против фиксации при CI95 [−0.033, +0.378] — ноль внутри, а
  // медиана +0.844R (типичная сделка ХУЖЕ фиксации, среднее держат 3 выброса).
  // Гипотеза adopt-target-trail, судить один раз на 60 доехавших до цели.
  const adoptTargetTrailEnabled    = (process.env.ADOPT_TARGET_TRAIL_ENABLED || 'false').toLowerCase() === 'true';
  const adoptTargetTrailArmR       = parseFloat(process.env.ADOPT_TARGET_TRAIL_ARM_R       || '0.9');
  const adoptTargetTrailGiveBackR  = parseFloat(process.env.ADOPT_TARGET_TRAIL_GIVE_BACK_R || '0.25');
  if (isNaN(adoptTargetTrailArmR) || adoptTargetTrailArmR <= 0) {
    throw new Error(`ADOPT_TARGET_TRAIL_ARM_R must be > 0. Got: "${process.env.ADOPT_TARGET_TRAIL_ARM_R}"`);
  }
  if (isNaN(adoptTargetTrailGiveBackR) || adoptTargetTrailGiveBackR <= 0) {
    throw new Error(`ADOPT_TARGET_TRAIL_GIVE_BACK_R must be > 0. Got: "${process.env.ADOPT_TARGET_TRAIL_GIVE_BACK_R}"`);
  }
  const adoptShadowTrailR       = parseFloat(process.env.ADOPT_SHADOW_TRAIL_R || '0.25');
  if (isNaN(adoptShadowTrailR) || adoptShadowTrailR <= 0) {
    throw new Error(`ADOPT_SHADOW_TRAIL_R must be > 0. Got: "${process.env.ADOPT_SHADOW_TRAIL_R}"`);
  }
  // Пик-алерт (2026-07-02): систематизация дискрец-выхода. Юзер закрывает 63%
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

  // ── Daily loss limit (2026-07-02) — дневной стоп-лосс по fills ──
  // Аудит 60д: 8 худших дней = −$130 при общем −$83. День достиг −LIMIT$ net →
  // urgent-алерт + гейт новых авто-входов + тильт-алерт на усыновления до
  // полуночи. Няньку/выходы НЕ трогает (вход без стопа хуже лимита).
  const dailyLossLimitEnabled = (process.env.DAILY_LOSS_LIMIT_ENABLED || 'true').toLowerCase() === 'true';
  const dailyLossLimitUsd     = parseFloat(process.env.DAILY_LOSS_LIMIT_USD || '5');
  if (isNaN(dailyLossLimitUsd) || dailyLossLimitUsd <= 0) {
    throw new Error(`DAILY_LOSS_LIMIT_USD must be > 0. Got: "${process.env.DAILY_LOSS_LIMIT_USD}"`);
  }

  // ── Screen (экран торгуемых монет, 2026-08-23) ──
  // Порог трения: монета попадает на экран по цене входа, а не по движению.
  // 25бп ≈ 89 монет из 177 с живой книгой — TRUMP/ZEC/PENGU внутри, PURR(29бп)
  // и HMSTR(52бп) снаружи. Разбор 703 сделок: комиссии = $27 из $35 убытка.
  const screenMaxFrictionBp = parseFloat(process.env.SCREEN_MAX_FRICTION_BP || '25');
  if (isNaN(screenMaxFrictionBp) || screenMaxFrictionBp <= 0) {
    throw new Error(`SCREEN_MAX_FRICTION_BP must be > 0. Got: "${process.env.SCREEN_MAX_FRICTION_BP}"`);
  }
  // Бюджет сделок за день. С 31.08.2026 это ГЕЙТ, а не счётчик: цифра перед
  // глазами не остановила 17 сделок за сутки, показывая «14 / 5». Trade Ticket
  // отбивает вход по достижении лимита (src/modules/tradeGuards.js).
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
  // ⚠️ НЕ стратегия: радар алертов для ручной торговли. План: memory/candy_girl_idea.md.
  // Никогда не открывает позицию. Master-флаг default OFF.
  // Канал алертов: ntfy шлётся всегда (когда alertEnabled), TG-дубль опционален.
  // default OFF — Candy Girl живёт в ntfy-ленте вместе со Swing-сканером.
  const trendEmaFast1h             = parseInt(process.env.TREND_EMA_FAST_1H || process.env.CANDY_GIRL_FAST_1H  || '20', 10);
  const trendEmaSlow1h             = parseInt(process.env.TREND_EMA_SLOW_1H || process.env.CANDY_GIRL_SLOW_1H  || '200', 10);
  const trendSlopeLookback      = parseInt(process.env.TREND_SLOPE_LOOKBACK || process.env.CANDY_GIRL_SLOPE_LOOKBACK || '10', 10);
  // 4h higher-timeframe confluence: сигнал валиден только если 4h-тренд совпадает
  // с 1h-трендом. EMA20/50 на 4h (≈8 дней истории), легче чем EMA200 на 1h.
  // Логирование сигналов в БД + авто-резолв TP-before-SL (замер точности).
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


  // Iter E.2: trailing TP для Hunter Long (PAPER). Зеркало HUNTER_TRAIL_*.
  // ARM_PCT < HUNTER_LONG_TP_PCT — иначе fixed TP сработает раньше trail.


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

  // ── WS price feed (Stage 1 shadow / Stage 2 exits) ─────────
  // wsFeedEnabled — поднимает allMids WS-фид (тень: кэш + сверка с поллингом).
  // wsExitsEnabled — выходы активной hunter/hunter_long позиции считаются на
  //   WS-тиках (не раз в 15с). Требует включённого фида. Default OFF — включать
  //   только после суток наблюдения тени (см. ws_price_feed_plan.md).
  const wsFeedEnabled     = (process.env.HL_WS_FEED_ENABLED    || 'false').toLowerCase() === 'true';
  const wsExitIntervalMs  = parseInt(process.env.HL_WS_EXIT_INTERVAL_MS  || '2000', 10);
  // Stage 3: входы на WS-тиках (быстрее 15с). Поведение-меняющая — default OFF,
  // требует wsFeedEnabled. См. ws_price_feed_plan.md.

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
      roundTrip,
      liquidTopN,
      liquidMinVolume,
      liquidCacheMs: liquidCacheHours * 3_600_000,
      setupSnapshotIntervalMin,
      minVolumeUsd,
      trendLookbackMin,
      adoptEnabled,
      manualPaperAdoptEnabled,
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
    // если url/creds/template/to не заданы — mail.js тихо no-op (как ntfy).
    // Тот же Listmonk, что у atlas / appointment_tg_bot (example.com).
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
