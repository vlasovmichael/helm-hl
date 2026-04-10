# Adaptive Logic — Design Spec

**Дата:** 2026-04-10
**Статус:** Approved (final inputs locked in by user)
**Контекст:** После внедрения брони (Circuit Breaker, Drawdown Guard, Funding-Aware Exit Gate) бот защищён от катастроф, но всё ещё страдает от трёх классов "тупых" ошибок:

1. Заходит в монеты, у которых funding вот-вот рухнет (текущий APY высокий, но через час будет 30%).
2. Заходит в монеты, которые "пампятся" прямо сейчас (кейс MAVIA — funding высокий из-за кратковременного спайка цены, который тут же откатится).
3. Пытается ротироваться в монету с переполненным OI cap, не получает позицию, теряет старую (прибыльную) и сидит в кэше.

Этот спек закрывает все три проблемы тремя независимыми фичами.

---

## Feature 1: Predictive Funding Filter

### Цель
Отсекать кандидатов, у которых ожидается значительное падение funding в ближайший час.

### Источник данных
Hyperliquid endpoint `predictedFundings`:
```
POST https://api.hyperliquid.xyz/info
{ "type": "predictedFundings" }
```
Возвращает массив: `[[coin, [[venue, { fundingRate, nextFundingTime }], ...]], ...]`. Берём только Hyperliquid venue (`HlPerp`).

### Логика
В `scout.js` после расчёта `rawApy` для каждой монеты:

```
predictedApy = predictedFundingRate * 24 * 365 * 100

ЕСЛИ rawApy >= ENTRY_APY_THRESHOLD (40%):
    drop = (rawApy - predictedApy) / rawApy
    ЕСЛИ drop > 0.30:
        пропустить монету (skippedPredictedDrop++)
        debug-лог: "<coin> APY 50% → predicted 30% (-40%) — пропуск"
ИНАЧЕ:
    пропустить проверку (монета и так не кандидат на вход)
```

### Почему "пол" обязателен
Без фильтра по `>= ENTRY_APY_THRESHOLD` мы бы выбрасывали монеты, где funding падает с 5% APY до 3% APY — нам всё равно, мы туда никогда не пойдём. Фильтр работает только там, где предсказание реально влияет на решение.

### Конфигурация
- Порог дропа `0.30` — константа в scout.js (`PREDICTED_DROP_THRESHOLD`).
- Порог входа `40%` — берётся из `config.trading.entryApy`.

### Обработка ошибок
Если запрос `predictedFundings` падает или возвращает мусор:
- Логируем `warn`, продолжаем работать **без** этого фильтра в данном тике.
- Никогда не блокируем все монеты на основании отказа предсказания.

### Кеширование
`predictedFundings` обновляется на бирже раз в час. Кешируем результат на 5 минут в scout.js, чтобы не делать второй POST на каждом тике (15с интервал → 20× экономия).

---

## Feature 2: Volatility Filter (Variant C — Gatekeeper)

### Цель
Не открывать позицию в монете, которая прямо сейчас "пампит", даже если у неё высокий APY.

### Архитектура
**Variant C: candleSnapshot для финального кандидата перед открытием.**

Расчёт волатильности живёт в новом модуле `src/modules/volatility.js`. Вызывается из `executor/index.js` внутри `preflightChecks()` рядом с Circuit Breaker и Drawdown Guard. Один API-вызов на тик максимум — только когда стратегист уже выбрал победителя.

### Источник данных
Hyperliquid endpoint `candleSnapshot`:
```
POST https://api.hyperliquid.xyz/info
{
  "type": "candleSnapshot",
  "req": {
    "coin": "<COIN>",
    "interval": "1m",
    "startTime": <now - 15min>,
    "endTime":   <now>
  }
}
```
Возвращает 15 свечей по 1 минуте. Для расчёта берём `closes = candles.map(c => parseFloat(c.c))`.

### Математика
```
mean   = sum(closes) / n
stddev = sqrt(sum((c - mean)^2) / n)
VolIdx = stddev / mean    (коэффициент вариации, безразмерный)
```

### Пороги и формула
```
ЕСЛИ VolIdx < 0.003 (0.3% за 15 мин):
    норма, вход разрешён без штрафа

ИНАЧЕ:
    multiplier = 1 + min(VolIdx * 200, 3)
    Threshold_dynamic = config.trading.entryApy * multiplier

    ЕСЛИ candidate.smoothedApy >= Threshold_dynamic:
        вход разрешён (compensation за риск достаточная)
    ИНАЧЕ:
        вето: VolIdx={X} → требовался APY>={Threshold_dynamic}, фактический={smoothedApy}
```

**Калибровка (стартовые значения, можно крутить позже):**
| VolIdx | Multiplier | Threshold (база 40%) |
|---|---|---|
| 0.003 | ×1.6 | 64% |
| 0.005 | ×2.0 | 80% |
| 0.010 | ×3.0 | 120% |
| 0.015 | ×4.0 | 160% (cap) |

### Логирование
**Обязательно** выводить "цифры страха" в лог при срабатывании вето:
```
[Volatility] ⛔ #MAVIA VolIdx=0.0142 (stddev=0.0089, mean=0.6234)
              → required APY≥160.0%, actual=85.3% — VETO
```

При VolIdx < 0.003 — debug-лог:
```
[Volatility] ✓ #PURR VolIdx=0.0021 — calm, allow
```

### Обработка ошибок
- Если `candleSnapshot` падает или вернул < 5 свечей: логируем `warn`, **разрешаем** вход (fail-open). Лучше открыть позицию, чем зависнуть в кэше из-за временного API-сбоя.
- Если все цены одинаковые (mean=0 или близко к 0): VolIdx=0, разрешаем вход.

### Контракт модуля
```js
// src/modules/volatility.js
export async function checkVolatility(coin, smoothedApy) {
  // returns { allowed: boolean, volIdx: number, requiredApy?: number, reason?: string }
}
```

### Интеграция в preflightChecks
В `executor/index.js`, после Circuit Breaker и Drawdown Guard, перед `return { allowed: true }`:

```js
// 3. Volatility Filter
const vol = await checkVolatility(coin, smoothedApy);
if (!vol.allowed) {
  return {
    allowed: false,
    reason: 'Volatility',
    details: `VolIdx=${vol.volIdx.toFixed(4)}, требовался APY≥${vol.requiredApy.toFixed(0)}%`,
  };
}
```

⚠️ Это требует, чтобы `preflightChecks` принимал `smoothedApy` — сейчас принимает только `coin`. Сигнатура расширяется до `preflightChecks(coin, smoothedApy)`. Вызовы из `handleOpen` и `handleRotate` обновляются для передачи `signal.apy`/`signal.openApy`.

---

## Feature 3: Smart Rotation — OI Cap Ban

### Цель
Если попытка открыть новую позицию падает с ошибкой "open interest at cap" — не закрывать старую (прибыльную) позицию, забанить тикер на 30 минут, продолжить держать старую.

### Где ловим
В `src/modules/executor/production.js`:
- `productionOpen()` — catch блока выставления ордера.
- `productionRotate()` — после `productionClose()`, если `productionOpen()` нового тикера падает с этой ошибкой → **уже поздно**, старая позиция уже закрыта. Поэтому ловим **до закрытия**.

### Решение для productionRotate
Перед `productionClose()` делаем "dry-run" проверку OI cap для нового тикера. Hyperliquid API возвращает `openInterest` и `maxLeverage` в `metaAndAssetCtxs`. Считаем доступный headroom:

```
headroomUsd = (maxOpenInterest - currentOpenInterest) * markPrice
ЕСЛИ headroomUsd < plannedSizeUsd * 1.1:
    OI cap risk → ban + abort rotate
```

Если такой dry-run слишком хрупок (формула может не совпасть с реальной логикой биржи), используем **fallback**: ловим точную ошибку в catch productionOpen. Тогда логика:

```
productionRotate:
    closeResult = productionClose(...)
    openResult = productionOpen(...)
    ЕСЛИ openResult.error == 'OI_CAP':
        banOiCap(newCoin, 30 минут)
        notifyOiCapAfterRotate(...) — уведомить, что мы остались в кэше
        // позиция уже закрыта, восстановить нельзя
        return { ok: false, closePnl: closeResult.pnl }
```

**В обоих сценариях** (open и rotate) ban работает одинаково: следующий тик scout пропустит этот тикер через `oiCapBanMap` фильтр.

### Точная строка ошибки
**Открытый вопрос:** Hyperliquid SDK может возвращать ошибку как `"order would exceed max open interest"`, `"open interest at cap"` или другой формат. Перед имплементацией нужно:
1. Грепнуть существующие логи/коммиты на упоминания "open interest" / "OI" — мы могли уже этим обжигаться.
2. Если нет прецедента — реализуем матчинг по подстроке `/open\s*interest/i` ИЛИ `/oi\s*cap/i` (case-insensitive). Если матчится — банн.

### State модуль
В `src/modules/executor/state.js` добавляем:

```js
export const OI_CAP_BAN_TTL_MS = 30 * 60_000;

const oiCapBanMap = new Map(); // coin -> expiresAt

export function banOiCap(coin) {
  oiCapBanMap.set(coin, Date.now() + OI_CAP_BAN_TTL_MS);
}

export function isOiCapBanned(coin) {
  const exp = oiCapBanMap.get(coin);
  if (!exp) return false;
  if (Date.now() > exp) {
    oiCapBanMap.delete(coin);
    return false;
  }
  return true;
}

export function getOiCapBans() {
  // cleanup expired + return Map snapshot
}
```

### Фильтрация в scout
В `scout.js`, рядом с `getRuntimeBlacklist()`:
```js
import { getOiCapBans } from './executor/index.js'; // re-export

const oiCapBanned = getOiCapBans();
// добавить в фильтр на каждом тике
```

### Telegram уведомление
Новая функция в `notifications.js`:
```js
export async function notifyOiCapBan({ coin, mode }) {
  await sendMessage(
    `⚠️ <b>OI Cap Ban</b>\n` +
    `Монета <code>#${coin}</code> временно недоступна (open interest at cap).\n` +
    `🚫 Бан на 30 минут. Бот остаётся в текущей позиции.`
  );
}
```

---

## Архитектурное взаимодействие

```
┌─────────────────────────────────────────────────┐
│  scan() в scout.js                              │
│  ─────────────────                              │
│  1. fetchMarkets()        ← metaAndAssetCtxs    │
│  2. fetchPredictedFundings() (с 5min cache)     │
│  3. для каждой монеты:                          │
│     - blacklist check                           │
│     - runtime blacklist check                   │
│     - OI cap ban check          ← НОВОЕ         │
│     - predicted funding drop    ← НОВОЕ         │
│     - EMA + apy расчёт                          │
│  4. sorted results → strategist                 │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│  strategist.js                                  │
│  выбирает action: OPEN / ROTATE / CLOSE / HOLD  │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│  executor/index.js → handleOpen / handleRotate  │
│  ─────────────────                              │
│  preflightChecks(coin, smoothedApy):            │
│    1. Circuit Breaker                           │
│    2. Drawdown Guard                            │
│    3. Volatility Filter      ← НОВОЕ            │
│  если ok → productionOpen / productionRotate    │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│  production.js                                  │
│  catch (err):                                   │
│    if (matches OI cap pattern) {                │
│      banOiCap(coin)             ← НОВОЕ          │
│      notifyOiCapBan(...)                        │
│      return abort               ← НОВОЕ          │
│    }                                            │
└─────────────────────────────────────────────────┘
```

---

## Конфигурация (новые параметры)

Все три фичи ставим как hardcoded constants в первой итерации (in respective модули). После 1-2 недель прода вынесем в `config.adaptive` если потребуется тюнинг через .env.

```js
// scout.js
const PREDICTED_DROP_THRESHOLD = 0.30;  // 30% drop
const PREDICTED_FUNDING_CACHE_MS = 5 * 60_000;

// volatility.js
const VOL_IDX_NORMAL_THRESHOLD = 0.003;  // 0.3% за 15 мин
const VOL_IDX_MULTIPLIER       = 200;
const VOL_IDX_MAX_MULTIPLIER   = 3;      // cap на ×4 итого
const CANDLE_LOOKBACK_MIN      = 15;

// state.js
const OI_CAP_BAN_TTL_MS = 30 * 60_000;
```

---

## Что меняется в коде (превью файлов)

| Файл | Изменение |
|---|---|
| `src/modules/scout.js` | + fetchPredictedFundings + cache; + предикат фильтра по drop; + OI cap filter |
| `src/modules/volatility.js` | **NEW** — `checkVolatility(coin, apy)`, candleSnapshot fetch, формула |
| `src/modules/executor/state.js` | + `banOiCap`, `isOiCapBanned`, `getOiCapBans`, OI_CAP_BAN_TTL_MS |
| `src/modules/executor/index.js` | preflightChecks(coin, smoothedApy) расширяется + Volatility check; + re-export `getOiCapBans` |
| `src/modules/executor/production.js` | catch блок: матчинг OI cap pattern → banOiCap + notify + abort |
| `src/modules/executor/notifications.js` | + `notifyOiCapBan`, обновить `notifyOpenBlocked` для случая Volatility |

**Не меняется:**
- `strategist.js` — он не знает про эти фильтры, всё абстрагировано в scout/executor.
- `database.js`, `lifecycle.js`, dashboard — эти фичи не персистятся (in-memory bans + cache).

---

## Тестирование

### Smoke (paper mode)
1. Запустить бот в paper, понаблюдать 30 минут.
2. В логах должны появиться:
   - `[Scout] Filters: ... | predicted-drop=N` — счётчик отсева
   - `[Scout] fetchPredictedFundings: cached/refreshed` — кеш работает
   - `[Volatility] ✓ #COIN VolIdx=...` — debug при каждой попытке OPEN
3. Выбрать любую недавнюю памп-монету, проверить срабатывание вето вручную.

### Production canary
1. Деплой → 24 часа наблюдения.
2. Метрики:
   - Сколько монет отсечено predicted-drop фильтром (debug counter)
   - Сколько вето за день по volatility (warn count)
   - Любые срабатывания OI cap ban (warn)
3. Если ноль срабатываний за 24 часа на любой из фич — возможно пороги слишком мягкие, корректируем.

---

## Открытые вопросы (для имплементации)

1. **Точная строка ошибки OI cap** — выясняется до или во время кодинга. План: грепнуть проект, потом смотреть SDK source. Fallback — regex `/open\s*interest/i`.
2. **Сигнатура `preflightChecks`** — ломается обратная совместимость. Нужно обновить ВСЕ вызовы (handleOpen, handleRotate). Просто и механически.
3. **`notifyOpenBlocked`** уже существует — нужно убедиться, что он корректно обработает новый `reason: 'Volatility'`. Скорее всего просто работает (он принимает строку).
