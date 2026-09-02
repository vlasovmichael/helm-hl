import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { fetchPositions, KNOWN_BUILDER_DEXES } from './winnersPositions.js';

// ─────────────────────────────────────────────────
//  builderPositions — свои позиции на builder-DEX'ах (HIP-3)
// ─────────────────────────────────────────────────
// У HL кроме основного перп-DEX'а есть площадки HIP-3 (xyz с акциями и
// товарами, flx, vntl, hyna, km, abcd, cash, para, mkts). Без параметра `dex`
// их позиции в clearinghouseState НЕ приходят — из-за этого дашборд показывал
// пустой экран, когда весь счёт стоял на xyz.
//
// 🚨 Только ЧТЕНИЕ и только отдельным блоком. Подмешивать это в
// getPositionsCached нельзя: оттуда читает нянька, а executor не умеет
// адресовать активы builder-DEX'ов — усыновлённая позиция получила бы стоп в
// никуда. Пока такие позиции ведутся руками, и панель обязана говорить это
// прямым текстом, а не молчать.
//
// Маржа на каждой площадке своя и изолированная, поэтому эквити считается
// отдельно и в дневной стоп-лосс бота не входит.

const TTL_MS = 60_000;
// После отказа не долбим биржу каждые 30с: у чтения LOW-приоритет, и если
// бюджет занят торговыми запросами, следующая попытка через 30с упрётся в то же
// самое. Держим последний ответ дольше и повторяем реже.
const ERROR_TTL_MS = 120_000;
// Пока НИ ОДНОГО успешного чтения не было (сразу после рестарта бюджет занят
// прогревом: юниверс, whitelist, снапшоты), длинная пауза означала бы, что
// карточка пустует две минуты на ровном месте. До первого успеха пробуем чаще.
const COLD_RETRY_MS = 15_000;
const WARN_EVERY_MS = 300_000;
let cache = { payload: null, at: 0, inflight: null, failedAt: 0 };
let lastWarnAt = 0;

/** Последний успешный ответ, а если его ещё не было — пустой с пометкой. */
const lastOrEmpty = () =>
  cache.payload ?? { positions: [], venues: [], equity: 0, unrealizedPnl: 0, notional: 0, error: 'read failed' };

async function build() {
  // Фолбэк обязателен: список площадок читается из userFills (вес 20), и у
  // живого бота этот запрос на LOW-приоритете часто не пролезает в бюджет.
  // Без фолбэка отказ молча выглядел бы как «на builder-DEX'ах ничего нет».
  const snap = await fetchPositions(config.wallet.address, {
    fallbackDexes: KNOWN_BUILDER_DEXES,
  });
  // Основной DEX уже показан обычной панелью — здесь только площадки HIP-3.
  const positions = (snap.positions || []).filter((p) => p.dex && p.dex !== 'main');
  const venues = (snap.venues || []).filter((v) => v.dex && v.dex !== 'main');
  return {
    positions,
    venues,
    equity: venues.reduce((s, v) => s + (Number.isFinite(v.equity) ? v.equity : 0), 0),
    unrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    notional: positions.reduce((s, p) => s + p.sizeUsd, 0),
    // true = список площадок прочитать не успели, смотрели не везде.
    partial: Boolean(snap.partial),
  };
}

/**
 * Позиции на HIP-3 площадках. НЕ бросает и НЕ отдаёт пустоту вместо данных:
 * при отказе возвращает последний успешный ответ. Пустой список означает
 * «площадки прочитаны, позиций нет» — и ничего больше.
 */
export async function getBuilderPositions() {
  const now = Date.now();
  if (cache.payload && now - cache.at < TTL_MS) return cache.payload;
  // Недавний отказ — отдаём что есть и не идём в сеть.
  const backoff = cache.payload ? ERROR_TTL_MS : COLD_RETRY_MS;
  if (cache.failedAt && now - cache.failedAt < backoff) return lastOrEmpty();
  // 🚨 Наружу отдаём промис, который НИКОГДА не реджектится. Раньше здесь
  // возвращался сырой `build()`, и все параллельные вызывающие (кадр статуса
  // идёт каждые 2с) получали одно и то же отклонение — позиция мигала и
  // пропадала на каждой неудаче бюджета.
  if (!cache.inflight) {
    cache.inflight = build()
      .then((payload) => {
        cache = { payload, at: Date.now(), inflight: null, failedAt: 0 };
        return payload;
      })
      .catch((err) => {
        cache.inflight = null;
        cache.failedAt = Date.now();
        // Раз в 5 минут, а не на каждый кадр статуса.
        if (Date.now() - lastWarnAt > WARN_EVERY_MS) {
          lastWarnAt = Date.now();
          logger.warn(`[BuilderDex] чтение площадок HIP-3 не удалось: ${err.message}`);
        }
        return lastOrEmpty();
      });
  }
  return cache.inflight;
}
