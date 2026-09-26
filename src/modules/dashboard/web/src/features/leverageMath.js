// ─────────────────────────────────────────────────
//  Потолок плеча по стопу: ликвидация изолированной позиции должна стоять
//  дальше стопа бота. Без DOM и импортов — её же зовёт сервер при открытии.
// ─────────────────────────────────────────────────

// Ликвидация не ближе стопа × LIQ_BUFFER: стоп-маркет исполняется с проскальзыванием.
export const LIQ_BUFFER = 1.2;
// Стоп ещё не посчитан — прежний осторожный потолок.
export const UNKNOWN_STOP_CAP = 10;

/**
 * Дистанция до ликвидации изолированной позиции, доля цены (худшая из сторон).
 * Поддерживающая маржа HL — половина начальной на биржевом максимуме.
 */
export function liquidationDist(leverage, exchangeMax) {
  const l = 1 / (2 * exchangeMax);
  return (1 / leverage - l) / (1 + l);
}

/**
 * Максимальное плечо для монеты при стопе stopDistPct (в процентах).
 * { cap, basis }: basis = "stop" | "exchange" | "unknown-stop".
 */
export function stopSafeLeverage({ exchangeMax, stopDistPct }) {
  const ex = Math.floor(Number(exchangeMax));
  if (!(ex >= 1)) return null;
  const stop = Number(stopDistPct) / 100;
  if (!(stop > 0)) return { cap: Math.min(ex, UNKNOWN_STOP_CAP), basis: "unknown-stop" };
  const l = 1 / (2 * ex);
  const bound = Math.floor(1 / (LIQ_BUFFER * stop * (1 + l) + l));
  if (bound >= ex) return { cap: ex, basis: "exchange" };
  return { cap: Math.max(1, bound), basis: "stop" };
}
