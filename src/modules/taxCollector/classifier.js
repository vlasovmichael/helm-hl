// ─────────────────────────────────────────────────
//  Classifier — Binance event → PIT-38 запись
// ─────────────────────────────────────────────────
// Все возможные форматы Binance событий нормализуем в единую структуру:
//   { tx_id, date, type, asset, fiat_val, fiat_currency, source, comment }
// либо null если событие не релевантно (крипта-крипта, internal, failed).

const FIAT_CURRENCIES = new Set(['USD', 'EUR', 'PLN']);

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
    default:              return null;
  }
}

// ─────────────────────────────────────────────────
//  /sapi/v1/fiat/orders — банковские переводы
// ─────────────────────────────────────────────────
// Поля: orderNo, fiatCurrency, indicatedAmount, amount, totalFee, method, status, createTime
// status === 'Successful' — только успешные

function classifyFiatOrder(raw) {
  if (raw.status !== 'Successful') return null;

  const fiatCurrency = (raw.fiatCurrency || '').toUpperCase();
  if (!FIAT_CURRENCIES.has(fiatCurrency)) return null;

  // amount = чистая сумма в фиате после комиссий
  const fiatVal = parseFloat(raw.amount);
  if (!isFinite(fiatVal) || fiatVal <= 0) return null;

  // _txType: 0 = deposit (фиат пришёл на Binance — это COST потенциальный, но без покупки крипты — просто пополнение)
  // 1 = withdraw (фиат ушёл с Binance — REVENUE если перед этим продали крипту)
  //
  // Простая интерпретация: deposit фиата = намерение купить крипту → COST.
  // withdraw фиата = крипта была продана → REVENUE.
  const type = raw._txType === 0 ? 'COST' : 'REVENUE';

  return {
    tx_id:        `fiat_orders_${raw.orderNo}`,
    date:         new Date(raw.createTime).toISOString(),
    type,
    asset:        fiatCurrency, // для bank transfers asset = сама фиат-валюта
    fiat_val:     fiatVal,
    fiat_currency: fiatCurrency,
    source:       'fiat_orders',
    comment:      raw._txType === 0 ? 'Binance Fiat Deposit' : 'Binance Fiat Withdraw',
  };
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
