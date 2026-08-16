// ─────────────────────────────────────────────────
//  Trade Ticket — математика тикета и гейты формы
// ─────────────────────────────────────────────────
// Тестируем чистое ядро модалки: размер, прогноз стопа няньки и — главное —
// БЛОКЕРЫ. Последние тут не косметика: это то, что стоит между опечаткой и
// живыми деньгами. Каждый блокер продублирован на сервере (routes/tradeTicket.js),
// эти тесты стерегут клиентскую половину.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  notionalUsd,
  sizeInCoins,
  effectiveEntry,
  projectedBotStop,
  stopRiskUsd,
  validateOpen,
  validateClose,
} from "../src/modules/dashboard/web/src/features/tradeTicket.js";

// Числа из реальной сделки CHIP 16.08.2026 и скриншота Rabby.
const CHIP = 0.027763;
const ctx = {
  price: CHIP,
  available: 6.88,
  maxLeverage: 10,
  stopDistPct: 7.2,
  adoptEnabled: true,
  day: { netUsd: -1.77, limitUsd: 5, halted: false },
};

const openState = (over = {}) => ({
  coin: "CHIP",
  side: "short",
  marginUsd: 3.44,
  leverage: 3,
  orderType: "market",
  limitPx: "",
  ...over,
});

// ── Размер ──────────────────────────────────────────────────────────────────

test("notionalUsd: маржа × плечо", () => {
  assert.equal(notionalUsd(3.44, 3), 10.32);
  assert.equal(notionalUsd(0, 3), 0);
  assert.equal(notionalUsd(3.44, 0), 0);
  assert.equal(notionalUsd("abc", 3), 0);
});

test("sizeInCoins: нотионал / цена, null без цены", () => {
  assert.equal(Math.round(sizeInCoins(10.32, CHIP)), 372);
  assert.equal(sizeInCoins(10.32, 0), null);
  assert.equal(sizeInCoins(0, CHIP), null);
});

test("effectiveEntry: лимитка своя цена, маркет — рыночная", () => {
  assert.equal(effectiveEntry({ orderType: "market", price: CHIP }), CHIP);
  assert.equal(effectiveEntry({ orderType: "limit", limitPx: "0.0281", price: CHIP }), 0.0281);
  // Лимитка без цены не подменяется рынком молча — иначе риск считался бы не от той цены.
  assert.equal(effectiveEntry({ orderType: "limit", limitPx: "", price: CHIP }), null);
});

// ── Прогноз стопа няньки ────────────────────────────────────────────────────

test("projectedBotStop: шорту выше входа, лонгу ниже", () => {
  const short = projectedBotStop({ side: "short", entry: 0.0298, stopDistPct: 7.2 });
  const long = projectedBotStop({ side: "long", entry: 0.0298, stopDistPct: 7.2 });
  assert.ok(short > 0.0298, "стоп шорта обязан быть выше входа");
  assert.ok(long < 0.0298, "стоп лонга обязан быть ниже входа");
  assert.equal(projectedBotStop({ side: "short", entry: 0, stopDistPct: 7.2 }), null);
  assert.equal(projectedBotStop({ side: "short", entry: 0.03, stopDistPct: null }), null);
});

test("stopRiskUsd: считается от НОТИОНАЛА, не от маржи", () => {
  // $10.32 нотионала при стопе −7.2% = $0.74. Если бы считали от маржи $3.44,
  // вышло бы $0.25 — втрое меньше правды, и это опасное занижение.
  assert.equal(stopRiskUsd({ notional: 10.32, stopDistPct: 7.2 }).toFixed(2), "0.74");
  assert.equal(stopRiskUsd({ notional: 0, stopDistPct: 7.2 }), null);
});

// ── Блокеры открытия ────────────────────────────────────────────────────────

test("validateOpen: нормальный тикет проходит", () => {
  const v = validateOpen(openState(), ctx);
  assert.equal(v.ok, true, `неожиданные блокеры: ${v.blockers.join(", ")}`);
  assert.equal(v.notional.toFixed(2), "10.32");
});

test("validateOpen: нотионал ниже биржевого минимума $10 — блокер", () => {
  const v = validateOpen(openState({ marginUsd: 3 }), ctx); // 3 × 3 = $9
  assert.equal(v.ok, false);
  assert.ok(v.blockers.some((b) => /minimum order size is \$10/.test(b)));
});

test("validateOpen: маржа больше свободной — блокер", () => {
  const v = validateOpen(openState({ marginUsd: 50 }), ctx);
  assert.equal(v.ok, false);
  assert.ok(v.blockers.some((b) => /margin exceeds available/.test(b)));
});

test("validateOpen: post-only, пересекающая рынок, ловится ДО отправки", () => {
  // Шорт: лимитка ниже рынка исполнилась бы сразу → биржа отклонит post-only.
  const bad = validateOpen(openState({ orderType: "limit", limitPx: "0.027" }), ctx);
  assert.equal(bad.ok, false);
  assert.ok(bad.blockers.some((b) => /cross the book/.test(b)));

  // Выше рынка — нормальная maker-заявка.
  const good = validateOpen(openState({ orderType: "limit", limitPx: "0.0281" }), ctx);
  assert.equal(good.ok, true, `неожиданные блокеры: ${good.blockers.join(", ")}`);
});

test("validateOpen: у лонга проверка пересечения зеркальная", () => {
  const bad = validateOpen(openState({ side: "long", orderType: "limit", limitPx: "0.030" }), ctx);
  assert.ok(bad.blockers.some((b) => /cross the book/.test(b)));
  const good = validateOpen(openState({ side: "long", orderType: "limit", limitPx: "0.0271" }), ctx);
  assert.equal(good.ok, true, `неожиданные блокеры: ${good.blockers.join(", ")}`);
});

test("validateOpen: дневной стоп запирает вход", () => {
  const v = validateOpen(openState(), { ...ctx, day: { netUsd: -5.2, limitUsd: 5, halted: true } });
  assert.equal(v.ok, false);
  assert.ok(v.blockers.some((b) => /daily stop hit/.test(b)));
});

test("validateOpen: выключенная нянька — ПРЕДУПРЕЖДЕНИЕ, а не запрет", () => {
  // Осознанно: иногда вход без стопа нужен, но молчать об этом нельзя.
  const v = validateOpen(openState(), { ...ctx, adoptEnabled: false });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /nobody will place a stop/.test(w)));
});

test("validateOpen: без монеты не пускает", () => {
  const v = validateOpen(openState({ coin: "" }), ctx);
  assert.equal(v.ok, false);
  assert.ok(v.blockers.some((b) => /pick a coin/.test(b)));
});

// ── Блокеры закрытия ────────────────────────────────────────────────────────

const pos = { coin: "CHIP", side: "short", sizeUsd: 15.78, markPrice: CHIP };

test("validateClose: рыночный выход проходит всегда", () => {
  const v = validateClose({ pct: 100, orderType: "market" }, pos, { price: CHIP });
  assert.equal(v.ok, true, `неожиданные блокеры: ${v.blockers.join(", ")}`);
});

test("validateClose: дневной стоп НЕ запирает выход", () => {
  // Ключевое поведение: запирать себе выход опасно. validateClose вообще не
  // смотрит на day — этот тест стережёт, чтобы гейт туда не «дополнили».
  const v = validateClose({ pct: 100, orderType: "market" }, pos, {
    price: CHIP,
    day: { halted: true },
  });
  assert.equal(v.ok, true);
});

test("validateClose: post-only откуп шорта выше рынка — блокер", () => {
  // Закрытие шорта = BUY, значит maker-заявка обязана стоять НИЖЕ рынка.
  const bad = validateClose({ pct: 100, orderType: "limit", limitPx: "0.029" }, pos, { price: CHIP });
  assert.equal(bad.ok, false);
  assert.ok(bad.blockers.some((b) => /cross the book/.test(b)));

  const good = validateClose({ pct: 100, orderType: "limit", limitPx: "0.027" }, pos, { price: CHIP });
  assert.equal(good.ok, true, `неожиданные блокеры: ${good.blockers.join(", ")}`);
});

test("validateClose: доля вне 1–100% отсекается", () => {
  assert.equal(validateClose({ pct: 0, orderType: "market" }, pos, {}).ok, false);
  assert.equal(validateClose({ pct: 150, orderType: "market" }, pos, {}).ok, false);
});

test("validateClose: без позиции нечего закрывать", () => {
  const v = validateClose({ pct: 100, orderType: "market" }, null, {});
  assert.equal(v.ok, false);
  assert.ok(v.blockers.some((b) => /no open position/.test(b)));
});
