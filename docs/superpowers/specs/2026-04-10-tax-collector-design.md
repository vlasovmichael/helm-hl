# Tax Collector — PIT-38 Auto Ledger

**Дата:** 2026-04-10
**Статус:** Approved (все ключевые вопросы согласованы)
**Цель:** Автоматический сбор фиатных операций для польского PIT-38.

## Контекст

Бот торгует на Hyperliquid, но единственный фиат-канал — Binance (Card Buy / P2P / Fiat Deposit/Withdraw / Convert-to-fiat). Все эти операции — налоговые события для PIT-38 в Польше.

## Scope (что ловим)

| Binance операция | PIT-38 |
|---|---|
| Card Buy / Buy with Fiat / P2P Buy | **COST** |
| Sell to Fiat / P2P Sell / Fiat Withdraw | **REVENUE** |
| Convert→fiat (PLN/USD/EUR) | **REVENUE** |
| Convert fiat→крипта | **COST** |
| Crypto-to-crypto, internal transfers | **IGNORE** |

## Архитектура

```
src/modules/taxCollector/
├── index.js          ← facade: dailyJob(), getTaxSummary(year)
├── binanceClient.js  ← HMAC-signed REST: fiat orders/payments/c2c/convert
├── nbpClient.js      ← NBP rates (T-1, weekend rollback ≤7 дней, JSON cache)
├── classifier.js     ← Binance event → { type: 'COST'|'REVENUE'|'IGNORE', ... }
└── ledger.js         ← read/write data/tax/<year>_ledger.json + dedup по tx_id
```

**Изменения в существующих файлах:**
- `src/index.js` — `cron.schedule('0 3 * * *', dailyJob)` после `startDashboard()`
- `src/modules/reporter.js` — обработчик `/tax` команды
- `src/modules/dashboard/server.js` — `/api/tax-summary?year=2026`
- `.env.example` — `BINANCE_API_KEY`, `BINANCE_API_SECRET` (опциональные)
- `src/core/config.js` — поля `binance.apiKey/apiSecret`, no validation (модуль само-выключается без ключей)
- `package.json` — добавлен `node-cron`

## Ключевые решения

1. **Файлы по годам:** `data/tax/2026_ledger.json`, `data/tax/2027_ledger.json` — на стыке годов чисто.
2. **Идемпотентность:** каждая запись имеет `tx_id` от Binance; при повторном запуске крона дубликаты пропускаются.
3. **NBP T-1 с откатом:** курс на день, предшествующий транзакции; если NBP вернул 404 (выходной/праздник) — откатываемся ещё на день, до 7 итераций.
4. **NBP cache:** `data/tax/nbp_cache.json`, ключ `"USD_2026-04-09"`.
5. **Fail-soft:** если Binance API лежит — лог `[Tax] Binance fetch failed, will retry tomorrow`. Если NBP лежит — конкретная транзакция откладывается, остальные обрабатываются. Никаких exception'ов в основной поток бота.
6. **Без ключей — модуль спит:** если `BINANCE_API_KEY` пустой, `dailyJob()` логирует "skipped: no keys" и выходит. Бот работает как раньше.
7. **Cron:** `0 3 * * *` = 03:00 каждый день. Окно сбора: за **последние 35 дней** (с запасом, на случай если бот лежал неделю).
8. **Lookback на первом запуске:** при первом старте подтягиваем за **90 дней назад** — чтобы захватить недавнюю историю.
9. **Telegram /tax:** отдаёт две цифры за текущий год: `Доход: X PLN`, `Расход: Y PLN`, `Прибыль: Z PLN`.
10. **/api/tax-summary?year=YYYY:** возвращает `{ year, totalCostsPLN, totalRevenuePLN, netProfitPLN, count }`.

## Структура записи в ledger

```json
{
  "tx_id": "binance_orderId_or_uuid",
  "date": "2026-04-09T14:32:11.000Z",
  "type": "COST" | "REVENUE",
  "asset": "USDT",
  "fiat_val": 100.00,
  "fiat_currency": "USD",
  "nbp_rate": 3.9845,
  "nbp_date": "2026-04-08",
  "pln_total": 398.45,
  "source": "fiat_payments" | "fiat_orders" | "c2c" | "convert",
  "comment": "Binance Card Buy"
}
```

## Корректность тайм-зон

Польская налоговая считает по **польскому календарному дню** (Europe/Warsaw). Binance отдаёт UTC. Конвертация: дата транзакции = дата в Warsaw TZ, T-1 NBP считается от неё. Используем `Intl.DateTimeFormat` с `timeZone: 'Europe/Warsaw'` без новых зависимостей.

## Что НЕ делаем в этой итерации

- Учёт HL-нативных депозитов/выводов (нет фиат-канала там).
- FIFO/LIFO cost basis для частичных продаж — PIT-38 в простой версии: суммарный расход против суммарного дохода за год.
- Web UI для редактирования ledger вручную — править руками в JSON.
- Поддержка валют, кроме USD/EUR/PLN.
- Тесты — smoke run + проверка JSON формата вручную.
