// ─────────────────────────────────────────────────
//  Ссылки на внешние графики (TradingView) + линкификация тикеров
// ─────────────────────────────────────────────────
// Общий tvUrl для Hot Movers (клик по тикеру) и колокольчика (клик по #COIN в
// уведомлении). HL k-монеты (kPEPE, kBONK…) на Binance = 1000-префикс; .P =
// бессрочный перп (тот же инструмент, что торгует бот, покрытие шире спота).

import { escapeHtml } from "./format.js";

export function tvUrl(coin) {
  let raw = String(coin || "").trim();
  if (/^k[A-Z0-9]/.test(raw)) raw = `1000${raw.slice(1)}`;
  const sym = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${sym}USDT.P`;
}

// Экранирует text и превращает токены #COIN в кликабельные ссылки на TradingView.
// Порядок важен: сперва escapeHtml (безопасность), потом regex по #COIN — escape
// не трогает '#'/буквы/цифры, поэтому токены остаются целыми. Тикер начинается с
// буквы (kPEPE — с 'k'), 1–15 символов; "#1"/"#" не матчатся.
export function linkifyCoins(text) {
  const safe = escapeHtml(text || "");
  return safe.replace(/#([A-Za-z][A-Za-z0-9]{0,14})\b/g, (m, coin) => {
    return `<a class="notif-coin" href="${tvUrl(coin)}" target="_blank" rel="noopener" title="Open ${escapeHtml(coin)} in TradingView">${m}</a>`;
  });
}
