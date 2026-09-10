// ─────────────────────────────────────────────────
//  Расстановка с Binance: кто в лонге и куда идёт OI
// ─────────────────────────────────────────────────
// HL знает свой OI, но не знает СТОРОНУ: openInterest считает обе половины
// сразу, и по нему нельзя сказать, лонг там сидит или шорт. Binance отдаёт
// разбивку бесплатно, по той же монете — этим и добираем.
//
// Три числа на монету:
//   topLongPct    — доля лонга у крупных счетов, по ОБЪЁМУ позиций
//   retailLongPct — доля лонга у всех счетов, по ЧИСЛУ счетов
//   oiChg1h/24h   — куда двигался OI (у HL истории OI под рукой нет)
//
// 🚨 Это данные Binance о той же монете, а не позиции на HL. Совпадение
// тикера не делает их одним рынком: на CHIP OI у HL крупнее биржевого.
//
// Обновление ленивое, пачками, с паузой между запросами: 89 монет разом —
// это 267 запросов, и лупить ими на каждый рендер незачем.

import { logger } from '../core/logger.js';

const BASE = 'https://fapi.binance.com';

// Расстановка меняется медленнее цены: доли лонга ходят на единицы процента
// за час. 10 минут — компромисс между свежестью и нагрузкой на чужой API.
const TTL_MS = 10 * 60_000;

// Пауза между запросами. Лимит Binance щедрый (2400 весов/мин, futures/data
// весят 1), но мы гость на чужом API и торопиться некуда.
const GAP_MS = 90;

// Сколько монет обновляем за один проход. Экран показывает ~90, но интересны
// прежде всего верхние — остальные догоняются следующими проходами.
const BATCH = 40;

// Профиль часов меняется неделями, а не минутами — держим сутки.
// 🚨 Свечи для него берём у Binance, а НЕ через candleCache: 90 монет по
// 168 баров это 1800 весов HL, а на весовом бюджете висит торговля.
const HOURS_TTL_MS = 24 * 60 * 60_000;

/** @type {Map<string, {topLongPct:number|null, retailLongPct:number|null, oiChg1hPct:number|null, oiChg24hPct:number|null, at:number}>} */
const cache = new Map();

/** @type {Map<string, {hours:number[], at:number}>} */
const hoursCache = new Map();

let sweeping = false;

/** HL-тикер → символ Binance. kSHIB на HL — это 1000SHIB на Binance. */
export function toBinanceSymbol(coin) {
  const c = String(coin || '').trim();
  if (!c) return null;
  return c.replace(/^k/, '1000').toUpperCase() + 'USDT';
}

async function getJson(url, timeoutMs = 6000) {
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { signal: ctl });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * Тянет расстановку по одной монете. Любая часть может не ответить —
 * отсутствующее поле остаётся null, монета всё равно кладётся в кэш, чтобы
 * не долбить Binance на каждом проходе из-за делистнутой пары.
 */
async function fetchOne(coin) {
  const sym = toBinanceSymbol(coin);
  if (!sym) return null;

  const [oiHist, top, retail] = await Promise.allSettled([
    getJson(`${BASE}/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=25`),
    getJson(`${BASE}/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=1`),
    getJson(`${BASE}/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
  ]);

  const out = {
    topLongPct: null,
    retailLongPct: null,
    oiChg1hPct: null,
    oiChg24hPct: null,
    at: Date.now(),
  };

  const rows = oiHist.status === 'fulfilled' && Array.isArray(oiHist.value) ? oiHist.value : [];
  if (rows.length > 1) {
    const now = Number(rows[rows.length - 1]?.sumOpenInterest);
    const h1 = Number(rows[rows.length - 2]?.sumOpenInterest);
    const d1 = Number(rows[0]?.sumOpenInterest);
    if (now > 0 && h1 > 0) out.oiChg1hPct = ((now - h1) / h1) * 100;
    if (now > 0 && d1 > 0) out.oiChg24hPct = ((now - d1) / d1) * 100;
  }

  const pct = (settled) => {
    if (settled.status !== 'fulfilled') return null;
    const v = Number(settled.value?.[0]?.longAccount);
    return Number.isFinite(v) ? v * 100 : null;
  };
  out.topLongPct = pct(top);
  out.retailLongPct = pct(retail);

  return out;
}

/**
 * Профиль суток: средний размах бара по каждому часу UTC за неделю.
 *
 * Отвечает на «когда эта монета вообще ходит»: у альтов размах между часами
 * различается в разы, и вход в мёртвый час — это тот же спред при вдвое
 * меньшем ходе. Размах, а не объём: торгуем движение цены, не оборот.
 *
 * @returns {number[]|null} 24 числа в процентах, индекс = час UTC
 */
async function fetchHours(coin) {
  const sym = toBinanceSymbol(coin);
  if (!sym) return null;
  const kl = await getJson(`${BASE}/fapi/v1/klines?symbol=${sym}&interval=1h&limit=168`, 8000);
  if (!Array.isArray(kl) || kl.length < 24) return null;
  const acc = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  for (const k of kl) {
    const high = Number(k[2]);
    const low = Number(k[3]);
    const close = Number(k[4]);
    if (!(high > 0) || !(low > 0) || !(close > 0)) continue;
    const slot = acc[new Date(Number(k[0])).getUTCHours()];
    slot.sum += ((high - low) / close) * 100;
    slot.n += 1;
  }
  return acc.map((a) => (a.n ? a.sum / a.n : 0));
}

/** Профиль часов из кэша. null — ещё не собран. */
export function getHourProfile(coin) {
  const hit = hoursCache.get(String(coin || '').toUpperCase());
  return hit ? hit.hours : null;
}

/** Расстановка из кэша. null — ещё не собрана либо пары на Binance нет. */
export function getPositioning(coin) {
  const hit = cache.get(String(coin || '').toUpperCase());
  if (!hit) return null;
  const { at, ...rest } = hit;
  return { ...rest, ageMs: Date.now() - at };
}

/**
 * Обновляет протухшие монеты из списка. Идёт последовательно с паузой и
 * никогда не бросает: расстановка — украшение экрана, а не его условие.
 *
 * @param {string[]} coins — порядок задаёт приоритет: голова списка первой
 */
export async function sweepPositioning(coins) {
  if (sweeping) return;
  sweeping = true;
  const started = Date.now();
  let done = 0;
  try {
    const stale = [];
    for (const coin of coins) {
      const key = String(coin || '').toUpperCase();
      if (!key) continue;
      const hit = cache.get(key);
      if (!hit || Date.now() - hit.at > TTL_MS) stale.push(key);
      if (stale.length >= BATCH) break;
    }
    for (const coin of stale) {
      try {
        const row = await fetchOne(coin);
        if (row) {
          cache.set(coin, row);
          done += 1;
        }
        const hrs = hoursCache.get(coin);
        if (!hrs || Date.now() - hrs.at > HOURS_TTL_MS) {
          const hours = await fetchHours(coin);
          if (hours) hoursCache.set(coin, { hours, at: Date.now() });
          await new Promise((r) => setTimeout(r, GAP_MS));
        }
      } catch (err) {
        // Пары может не быть вовсе — метим временем, чтобы не ходить снова.
        cache.set(coin, {
          topLongPct: null, retailLongPct: null,
          oiChg1hPct: null, oiChg24hPct: null, at: Date.now(),
        });
        logger.debug(`[Positioning] ${coin}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    if (done) {
      logger.debug(
        `[Positioning] обновлено ${done} монет за ${((Date.now() - started) / 1000).toFixed(1)}с`,
      );
    }
  } finally {
    sweeping = false;
  }
}
