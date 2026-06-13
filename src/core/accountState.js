// ─────────────────────────────────────────────────
//  Account State — coalescing-слой над чтениями аккаунта
// ─────────────────────────────────────────────────
//
// Why: balance (getAccountSummary/getBalance) и positions (getPositions)
// зовутся 6–12 раз за тик независимыми потребителями (integrity, orphan,
// hunter-reconcile, adopt, executor, dashboard), и каждый раз летит свой
// clearinghouseState (+spot). Один и тот же срез аккаунта тащился по сети
// десяток раз в секунду. Здесь — single-flight + короткий TTL: в окне TTL
// все читатели получают ОДИН результат, вне окна — свежий фетч.
//
// Что это НЕ:
//   • НЕ glitch-guard от $0-ответов индексатора — им остаётся balanceCache,
//     он оборачивает фетчер СВЕРХУ (coalesce отдаёт сырой ответ, balanceCache
//     решает, доверять ему или жить на кэше).
//   • НЕ для hot-путей реконсайла. Polling-цикл после ордера (executor/
//     reconciler.js) обязан видеть свежие позиции каждую итерацию, поэтому
//     зовёт getPositions() НАПРЯМУЮ, а не через cached-обёртку.

const cache = new Map();    // key → { value, ts }
const inflight = new Map(); // key → Promise (single-flight)

/**
 * Коалесцирующий доступ к дорогому сетевому чтению.
 *
 * @param {string} key            — логический ключ среза ('balance' | 'positions')
 * @param {() => Promise<any>} fetcher — сам фетч (например getPositions)
 * @param {number} maxAgeMs       — отдать кэш, если он свежее этого окна
 * @returns {Promise<any>}
 */
export async function coalesce(key, fetcher, maxAgeMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < maxAgeMs) return hit.value;

  // Уже летит запрос за тем же ключом → ждём его, нового не плодим.
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const value = await fetcher();
      cache.set(key, { value, ts: Date.now() });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Сбросить кэш ключа — звать после собственных сделок бота (open/close),
 * чтобы cold-читатели (дашборд/integrity) тут же увидели новый срез, а не
 * висели на дотрейдовом снапшоте до истечения TTL.
 *
 * @param {...string} keys
 */
export function invalidateAccountState(...keys) {
  if (keys.length === 0) {
    cache.clear();
    return;
  }
  for (const k of keys) cache.delete(k);
}

/** Диагностика для лог-снапшота: возраст кэшей и сколько запросов в полёте. */
export function accountStateStats() {
  const now = Date.now();
  const ages = {};
  for (const [k, v] of cache) ages[k] = now - v.ts;
  return { cachedKeys: [...cache.keys()], ageMs: ages, inflight: [...inflight.keys()] };
}

/** Только для тестов. */
export function _resetAccountState() {
  cache.clear();
  inflight.clear();
}
