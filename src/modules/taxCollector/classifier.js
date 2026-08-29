// ─────────────────────────────────────────────────
//  Classifier — Binance event → PIT-38 запись
// ─────────────────────────────────────────────────
// Все возможные форматы Binance событий нормализуем в единую структуру:
//   { tx_id, date, type, asset, fiat_val, fiat_currency, source, comment }
// либо null если событие не релевантно (крипта-крипта, internal, failed).

// Экспортируется: krakenClient решает по этому же списку, какая нога сделки
// фиатная, и списки обязаны совпадать — иначе клиент отдаст пару, которую
// классификатор потом молча выбросит.
export const FIAT_CURRENCIES = new Set(['USD', 'EUR', 'PLN']);

/**
 * Главная функция: принимает raw event, возвращает нормализованный объект или null.
 *
 * @param {Object} raw — событие из binanceClient
 * @returns {{ tx_id, date, type, asset, fiat_val, fiat_currency, source, comment } | null}
 */
export function classifyEvent(raw) {
  if (!raw || !raw._source) return null;

  switch (raw._source) {
    case 'fiat_orders':   return classifyFiatOrder(raw);
    case 'fiat_payments': return classifyFiatPayment(raw);
    case 'c2c':           return classifyC2c(raw);
    case 'convert':       return classifyConvert(raw);
    case 'kraken_trade':  return classifyKrakenTrade(raw);
    default:              return null;
  }
}

// ─────────────────────────────────────────────────
//  /sapi/v1/fiat/orders — банковские переводы
// ─────────────────────────────────────────────────
// Депозит/withdraw фиата на биржу — это НЕ налоговое событие для PIT-38.
// Это просто перемещение твоих денег между банком и Binance, без обмена крипта↔фиат.
// Налог возникает только в момент сделки (Card Buy/Sell, P2P, Convert) — её ловят
// другие источники. Классификация fiat_orders как COST/REVENUE приводила к двойному
// счёту (депозит 100 PLN + Convert этих 100 PLN в USDT = 200 PLN расхода вместо 100).
//
// Поэтому всегда возвращаем null. Тип параметра остаётся, чтобы классификатор был
// устойчив к добавлению этого источника в будущем.

function classifyFiatOrder(_raw) {
  return null;
}

// ─────────────────────────────────────────────────
//  /sapi/v1/fiat/payments — Card Buy/Sell
// ─────────────────────────────────────────────────
// Поля: orderNo, sourceAmount, fiatCurrency, obtainAmount, cryptoCurrency, totalFee, status, createTime
// status === 'Completed' — только успешные

function classifyFiatPayment(raw) {
  if (raw.status !== 'Completed') return null;

  const fiatCurrency = (raw.fiatCurrency || '').toUpperCase();
  if (!FIAT_CURRENCIES.has(fiatCurrency)) return null;

  // _txType: 0 = buy crypto with fiat (COST), 1 = sell crypto for fiat (REVENUE)
  const isBuy = raw._txType === 0;

  // Для buy: sourceAmount = фиат потрачено
  // Для sell: obtainAmount = фиат получено
  const fiatVal = parseFloat(isBuy ? raw.sourceAmount : raw.obtainAmount);
  if (!isFinite(fiatVal) || fiatVal <= 0) return null;

  const asset = (raw.cryptoCurrency || '').toUpperCase() || 'UNKNOWN';

  return {
    tx_id:        `fiat_payments_${raw.orderNo}`,
    date:         new Date(raw.createTime).toISOString(),
    type:         isBuy ? 'COST' : 'REVENUE',
    asset,
    fiat_val:     fiatVal,
    fiat_currency: fiatCurrency,
    source:       'fiat_payments',
    comment:      isBuy ? `Binance Card Buy ${asset}` : `Binance Card Sell ${asset}`,
  };
}

// ─────────────────────────────────────────────────
//  /sapi/v1/c2c/orderMatch/listUserOrderHistory — P2P
// ─────────────────────────────────────────────────
// Поля: orderNumber, advNo, tradeType, asset, fiat, fiatSymbol,
//   amount (crypto), totalPrice (fiat), unitPrice, orderStatus, createTime
// orderStatus === 'COMPLETED' — только успешные

function classifyC2c(raw) {
  if (raw.orderStatus !== 'COMPLETED') return null;

  const fiatCurrency = (raw.fiat || '').toUpperCase();
  if (!FIAT_CURRENCIES.has(fiatCurrency)) return null;

  const fiatVal = parseFloat(raw.totalPrice);
  if (!isFinite(fiatVal) || fiatVal <= 0) return null;

  const asset = (raw.asset || '').toUpperCase();
  const isBuy = raw._tradeType === 'BUY';

  return {
    tx_id:        `c2c_${raw.orderNumber}`,
    date:         new Date(raw.createTime).toISOString(),
    type:         isBuy ? 'COST' : 'REVENUE',
    asset,
    fiat_val:     fiatVal,
    fiat_currency: fiatCurrency,
    source:       'c2c',
    comment:      isBuy ? `Binance P2P Buy ${asset}` : `Binance P2P Sell ${asset}`,
  };
}

// ─────────────────────────────────────────────────
//  /sapi/v1/convert/tradeFlow — Convert
// ─────────────────────────────────────────────────
// Поля: quoteId, orderId, orderStatus, fromAsset, fromAmount, toAsset, toAmount, createTime
// orderStatus === 'SUCCESS' — только успешные
// Учитываем ТОЛЬКО когда одна из сторон — фиат (PLN/USD/EUR).
// Крипта↔крипта пропускаем.

function classifyConvert(raw) {
  if (raw.orderStatus !== 'SUCCESS') return null;

  const fromAsset = (raw.fromAsset || '').toUpperCase();
  const toAsset   = (raw.toAsset   || '').toUpperCase();

  const fromIsFiat = FIAT_CURRENCIES.has(fromAsset);
  const toIsFiat   = FIAT_CURRENCIES.has(toAsset);

  // Крипта↔крипта или фиат↔фиат — игнорируем
  if (fromIsFiat === toIsFiat) return null;

  if (fromIsFiat) {
    // Фиат → крипта = COST
    const fiatVal = parseFloat(raw.fromAmount);
    if (!isFinite(fiatVal) || fiatVal <= 0) return null;
    return {
      tx_id:         `convert_${raw.orderId}`,
      date:          new Date(raw.createTime).toISOString(),
      type:          'COST',
      asset:         toAsset,
      fiat_val:      fiatVal,
      fiat_currency: fromAsset,
      source:        'convert',
      comment:       `Binance Convert ${fromAsset}→${toAsset}`,
    };
  } else {
    // Крипта → фиат = REVENUE
    const fiatVal = parseFloat(raw.toAmount);
    if (!isFinite(fiatVal) || fiatVal <= 0) return null;
    return {
      tx_id:         `convert_${raw.orderId}`,
      date:          new Date(raw.createTime).toISOString(),
      type:          'REVENUE',
      asset:         fromAsset,
      fiat_val:      fiatVal,
      fiat_currency: toAsset,
      source:        'convert',
      comment:       `Binance Convert ${fromAsset}→${toAsset}`,
    };
  }
}

// ─────────────────────────────────────────────────
//  Kraken — /0/private/Ledgers, пара фиат↔крипта
// ─────────────────────────────────────────────────
// Поля приходят уже сведёнными в krakenClient.pairLedgerEntries:
//   refid, time (unix seconds), fiatAsset, fiatAmount, fiatFee,
//   cryptoAsset, cryptoAmount, isBuy
//
// 🚨 КОМИССИЯ. В ledger'е Kraken поле amount НЕ включает fee — баланс меняется
// на (amount − fee). Значит на покупке из кармана уходит fiatAmount + fee, а на
// продаже приходит fiatAmount − fee. Для PIT-38 это существенно: prowizja
// входит в koszt uzyskania przychodu, и брать «чистый» amount значило бы
// занизить расход и переплатить налог.

function classifyKrakenTrade(raw) {
  const fiatCurrency = (raw.fiatAsset || '').toUpperCase();
  if (!FIAT_CURRENCIES.has(fiatCurrency)) return null;

  const amount = parseFloat(raw.fiatAmount);
  if (!isFinite(amount) || amount <= 0) return null;

  const fee = isFinite(parseFloat(raw.fiatFee)) ? parseFloat(raw.fiatFee) : 0;
  const fiatVal = raw.isBuy ? amount + fee : amount - fee;
  if (!isFinite(fiatVal) || fiatVal <= 0) return null;

  const timeMs = Number(raw.time) * 1000;
  if (!isFinite(timeMs) || timeMs <= 0) return null;

  const asset = (raw.cryptoAsset || '').toUpperCase() || 'UNKNOWN';

  return {
    tx_id:         `kraken_${raw.refid}`,
    date:          new Date(timeMs).toISOString(),
    type:          raw.isBuy ? 'COST' : 'REVENUE',
    asset,
    fiat_val:      round8(fiatVal),
    fiat_currency: fiatCurrency,
    source:        'kraken_trade',
    comment:       raw.isBuy
      ? `Kraken Buy ${asset} for ${fiatCurrency}`
      : `Kraken Sell ${asset} for ${fiatCurrency}`,
  };
}

// Складывать float'ы приходится (частичные исполнения), а 100.00000000000001
// в гроссбухе выглядит как баг. Округляем до 8 знаков — точнее любого фиата.
function round8(n) {
  return Math.round(n * 1e8) / 1e8;
}
