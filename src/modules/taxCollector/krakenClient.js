// ─────────────────────────────────────────────────
//  Kraken Client — подписанные REST-запросы
// ─────────────────────────────────────────────────
// Read-only. Контракт как у binanceClient: isConfigured() + fetchAllFiatEvents().
//
// Ledgers, а не TradesHistory: последний не видит Instant Buy (он приходит
// парой spend/receive). В Ledgers покупка за фиат всегда выглядит одинаково —
// две строки с общим refid.
//
// 🚨 Подпись: base64(HMAC-SHA512(path + SHA256(nonce + postdata), secret)),
// secret декодировать из base64 ДО HMAC. Ошибка даёт 'EAPI:Invalid signature'
// без подробностей.
//
// 🚨 Nonce строго возрастающий НА КЛЮЧ, иначе ключ придётся сбрасывать в
// кабинете — поэтому монотонный счётчик и страницы ПОСЛЕДОВАТЕЛЬНО.

import axios from 'axios';
import crypto from 'crypto';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';

const KRAKEN_API = 'https://api.kraken.com';
const LEDGERS_PATH = '/0/private/Ledgers';

// Ledgers отдаёт по 50 записей на страницу (размер не настраивается) и стоит
// 2 очка из лимита (у
// verified-аккаунта потолок 20, восстановление ~0.5/сек). Пауза 2с держит нас
// заведомо внутри бюджета: суточный крон никуда не спешит.
const PAGE_PAUSE_MS = 2_000;
const MAX_PAGES = 200; // 10 000 записей — потолок от бесконечного цикла

let _nonceCounter = 0;

/**
 * Строго возрастающий nonce, устойчивый к двум вызовам в одну миллисекунду.
 */
function nextNonce() {
  const now = Date.now();
  _nonceCounter = now > _nonceCounter ? now : _nonceCounter + 1;
  return String(_nonceCounter);
}

/**
 * Включён ли модуль (есть ли ключи).
 */
export function isConfigured() {
  return !!(config.kraken?.apiKey && config.kraken?.apiSecret);
}

/**
 * Подпись запроса по схеме Kraken.
 *
 * Экспортируется ради теста: единственный способ убедиться, что подпись верна,
 * не имея живого ключа — прогнать официальный вектор из документации Kraken
 * (см. tests/krakenTax.test.js). Ошибка здесь неотличима от опечатки в ключе.
 *
 * @param {string} path — URI path, участвует в подписи как есть
 * @param {string} postdata — уже сериализованное тело
 * @param {string} nonce — тот же, что внутри postdata
 * @param {string} [apiSecret] — base64-секрет; по умолчанию из конфига
 */
export function sign(path, postdata, nonce, apiSecret = config.kraken?.apiSecret) {
  const secret = Buffer.from(apiSecret, 'base64');
  const hashed = crypto.createHash('sha256').update(nonce + postdata).digest();
  const payload = Buffer.concat([Buffer.from(path, 'utf8'), hashed]);
  return crypto.createHmac('sha512', secret).update(payload).digest('base64');
}

/**
 * Подписанный POST к приватному endpoint'у.
 * Kraken отвечает 200 даже на ошибку — она лежит в теле, в массиве .error.
 * @returns {Promise<any>} — содержимое .result
 */
async function signedPost(path, params = {}) {
  if (!isConfigured()) {
    throw new Error('Kraken API keys not configured');
  }

  const nonce = nextNonce();
  const postdata = new URLSearchParams({ ...params, nonce }).toString();
  const headers = {
    'API-Key': config.kraken.apiKey,
    'API-Sign': sign(path, postdata, nonce),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const { data } = await axios.post(`${KRAKEN_API}${path}`, postdata, {
    headers,
    timeout: 20_000,
  });

  if (Array.isArray(data?.error) && data.error.length > 0) {
    throw new Error(data.error.join('; '));
  }
  return data?.result ?? null;
}

// ─────────────────────────────────────────────────
//  Нормализация ассетов
// ─────────────────────────────────────────────────
// Kraken тащит из 2013 года legacy-коды: фиат с префиксом Z (ZEUR, ZUSD),
// старая крипта с X (XXBT, XETH). Новые ассеты приходят без префикса (USDC,
// ADA), а стейкинг-позиции — с суффиксом (.S, .M, .F, .B).
//
// 🚨 Префикс срезается ТОЛЬКО по списку известных legacy-кодов, а не по форме
// тикера. Правило «длина 4 и начинается с X/Z» выглядит соблазнительно, но режет
// живые тикеры: ZEUS превратился бы в EUS. Форма кода ничего не гарантирует —
// список закрыт и с 2013 года не растёт, поэтому перечисляем явно.

const LEGACY_ASSETS = new Map([
  // фиат
  ['ZUSD', 'USD'], ['ZEUR', 'EUR'], ['ZGBP', 'GBP'], ['ZCAD', 'CAD'],
  ['ZJPY', 'JPY'], ['ZAUD', 'AUD'], ['ZCHF', 'CHF'],
  // крипта
  ['XXBT', 'BTC'], ['XETH', 'ETH'], ['XLTC', 'LTC'], ['XXRP', 'XRP'],
  ['XXLM', 'XLM'], ['XXMR', 'XMR'], ['XZEC', 'ZEC'], ['XETC', 'ETC'],
  ['XREP', 'REP'], ['XMLN', 'MLN'], ['XXDG', 'XDG'], ['XNMC', 'NMC'],
  ['XICN', 'ICN'], ['XXVN', 'XVN'], ['XDAO', 'DAO'],
]);

const STAKING_SUFFIX = /\.(S|M|F|B|P|HOLD)\d*$/i;

/**
 * ZEUR → EUR, XXBT → BTC, USDC.S → USDC, ZEUS → ZEUS.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeAsset(raw) {
  const a = String(raw || '').toUpperCase().replace(STAKING_SUFFIX, '');
  const legacy = LEGACY_ASSETS.get(a);
  if (legacy) return legacy;
  return a === 'XBT' ? 'BTC' : a;
}

// ─────────────────────────────────────────────────
//  /0/private/Ledgers
// ─────────────────────────────────────────────────

/**
 * Все ledger-записи за период. Пагинация по ofs, страницы строго
 * последовательно (nonce и rate limit).
 *
 * Каждая запись Kraken: { refid, time (сек, float), type, subtype, aclass,
 * asset, amount, fee, balance }. Ключ объекта — ledger id, кладём его в _ledgerId.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function getLedgerEntries(startMs, endMs) {
  const out = [];
  let ofs = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    let result;
    try {
      result = await signedPost(LEDGERS_PATH, {
        start: Math.floor(startMs / 1000),
        end: Math.ceil(endMs / 1000),
        ofs,
      });
    } catch (err) {
      // Частичная выдача полезнее пустоты: то, что успели, уйдёт в ledger, а
      // остальное подберёт завтрашний прогон (окно lookback с запасом).
      logger.warn(`[Kraken] Ledgers page ofs=${ofs} failed: ${err.message}`);
      break;
    }

    const entries = Object.entries(result?.ledger || {});
    for (const [id, e] of entries) {
      out.push({ ...e, _ledgerId: id });
    }

    const total = Number(result?.count);
    ofs += entries.length;
    if (entries.length === 0 || !Number.isFinite(total) || ofs >= total) break;

    await sleep(PAGE_PAUSE_MS);
  }

  return out;
}

// ─────────────────────────────────────────────────
//  Сборка пар: одна сделка = две строки с общим refid
// ─────────────────────────────────────────────────
// Покупка USDC за евро в Ledgers выглядит так:
//   { refid: 'ABC', type: 'trade', asset: 'ZEUR', amount: '-100.00', fee: '0.25' }
//   { refid: 'ABC', type: 'trade', asset: 'USDC', amount: '+107.94', fee: '0'    }
// Instant Buy — то же самое, но type: 'spend' / 'receive'.
//
// Нас интересуют ТОЛЬКО пары, где ровно одна сторона фиатная: это и есть момент
// возникновения налогового события. Крипта↔крипта (USDC→BTC) для PIT-38 здесь
// не считается — тот же принцип, что у Binance Convert в classifier.js.
//
// 🚨 Депозиты и выводы фиата (type: 'deposit'/'withdrawal') сюда НЕ попадают
// по построению: у них нет второй ноги. Это правильно — перевод денег банк↔биржа
// не является налоговым событием (см. комментарий к classifyFiatOrder).

const TRADE_TYPES = new Set(['trade', 'spend', 'receive']);

/**
 * Группирует ledger-записи в пары по refid и возвращает только фиат↔крипта.
 * @param {Array<Object>} entries — сырые записи из getLedgerEntries
 * @param {Set<string>} fiatCurrencies — какие коды считать фиатом
 * @returns {Array<Object>} — raw-события для classifier (_source: 'kraken_trade')
 */
export function pairLedgerEntries(entries, fiatCurrencies) {
  const byRef = new Map();
  for (const e of entries) {
    if (!TRADE_TYPES.has(String(e.type || '').toLowerCase())) continue;
    if (!e.refid) continue;
    if (!byRef.has(e.refid)) byRef.set(e.refid, []);
    byRef.get(e.refid).push(e);
  }

  const out = [];
  for (const [refid, legs] of byRef) {
    // Частичное исполнение крупного ордера даёт несколько строк на ассет —
    // складываем их, иначе одна сделка распалась бы на пачку огрызков.
    const sums = new Map();
    for (const l of legs) {
      const asset = normalizeAsset(l.asset);
      const amount = parseFloat(l.amount);
      const fee = parseFloat(l.fee) || 0;
      if (!Number.isFinite(amount)) continue;
      const cur = sums.get(asset) || { asset, amount: 0, fee: 0, time: 0 };
      cur.amount += amount;
      cur.fee += fee;
      cur.time = Math.max(cur.time, parseFloat(l.time) || 0);
      sums.set(asset, cur);
    }

    const sides = [...sums.values()].filter((s) => Math.abs(s.amount) > 1e-12);
    if (sides.length !== 2) continue; // не обмен (или мультиногая экзотика)

    const fiatSide = sides.filter((s) => fiatCurrencies.has(s.asset));
    if (fiatSide.length !== 1) continue; // крипта↔крипта или фиат↔фиат

    const fiat = fiatSide[0];
    const crypto_ = sides.find((s) => s !== fiat);
    const time = Math.max(fiat.time, crypto_.time);

    out.push({
      _source: 'kraken_trade',
      refid,
      time,                                   // unix seconds (float)
      fiatAsset: fiat.asset,
      // Фиат ушёл со счёта ⇒ купил крипту ⇒ COST. Комиссию Kraken списывает
      // с фиатной ноги, и на покупке она увеличивает реальный расход, а на
      // продаже уменьшает выручку — поэтому знак учитываем, а не берём модуль.
      fiatAmount: Math.abs(fiat.amount),
      fiatFee: fiat.fee,
      cryptoAsset: crypto_.asset,
      cryptoAmount: Math.abs(crypto_.amount),
      isBuy: fiat.amount < 0,
    });
  }

  return out;
}

/**
 * Удобная обёртка: тащит ВСЁ за период одним вызовом.
 * Сигнатура и форма выдачи — как у binanceClient.fetchAllFiatEvents.
 *
 * @param {Set<string>} fiatCurrencies — коды фиата (из classifier)
 */
export async function fetchAllFiatEvents(startMs, endMs, fiatCurrencies) {
  logger.info(
    `[Kraken] Fetching ledger: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`,
  );

  const entries = await getLedgerEntries(startMs, endMs);
  const paired = pairLedgerEntries(entries, fiatCurrencies);

  logger.info(
    `[Kraken] Fetched ${entries.length} ledger rows → ${paired.length} fiat↔crypto trades`,
  );
  return paired;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
