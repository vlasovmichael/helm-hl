import "./ticket.scss";
import { mountPageHeader } from "./src/core/pageHeader.js";
// ─────────────────────────────────────────────────
//  ticket.html — локальный стенд модалки Trade Ticket
// ─────────────────────────────────────────────────
// Гоняет НАСТОЯЩИЙ модуль features/tradeTicket.js на мок-адаптере: биржи,
// кошелька и бэкенда тут нет вообще. Нужен, чтобы смотреть и править дизайн
// (`npm run dev:dash` → /ticket.html) до того, как что-то поедет в прод.
//
// Числа взяты из реальных сделок CHIP 16.08.2026 и из скриншота Rabby
// (свободно 6.88, минимум ордера $10), чтобы масштаб был честный.

import { createTradeTicketModal } from "./src/features/tradeTicket.js";

const CHIP = 0.027763;
const ACE = 0.1635;

// Настоящие лимиты плеча HL (сверено с meta 16.08.2026). Мок обязан их
// повторять — иначе стенд не поймает баг «10x на монете с потолком 3x».
const MAX_LEV = { CASHCAT: 3, CHIP: 3, ACE: 3, LIT: 5, DOGE: 10, ETH: 25, BTC: 40 };

/** Мок-биржа: контекст статичен, ответы приходят через 500мс. */
function mockIo(ctx, overrides = {}) {
  return {
    getContext: async (coin) => {
      const ex = MAX_LEV[String(coin || "").toUpperCase()] ?? null;
      return {
        ...ctx,
        exchangeMaxLeverage: ex,
        maxLeverage: ex == null ? 10 : Math.min(10, ex),
      };
    },
    open: async (p) => {
      await new Promise((r) => setTimeout(r, 500));
      return (
        overrides.open ?? {
          ok: true,
          message:
            `${p.side === "short" ? "Short" : "Long"} ${p.coin} · margin $${p.marginUsd.toFixed(2)} × ${p.leverage}x = $${p.sizeUsd.toFixed(2)} · ` +
            `${p.orderType === "limit" ? `limit @ ${p.limitPx} placed` : "market filled"} · ` +
            `the nanny will attach a stop within ~15s`,
        }
      );
    },
  };
}

// Позиции остались только как контекст для предупреждения «уже есть позиция»:
// закрытие переехало на карточку в Active Position.
const positions = [
  {
    coin: "CHIP",
    side: "short",
    sizeUsd: 15.78,
    entryPrice: 0.030577,
    markPrice: CHIP,
    unrealized: 1.44,
    stopPrice: 0.0325773,
  },
  {
    coin: "ACE",
    side: "long",
    sizeUsd: 12.6,
    entryPrice: 0.1662,
    markPrice: ACE,
    unrealized: -0.2,
    stopPrice: null,
  },
];

// Кусок реального universe HL — чтобы щупать автодополнение тикера.
const COINS = [
  "ACE", "ACX", "AAVE", "ADA", "AI", "ALGO", "APE", "APT", "ARB", "ATOM",
  "AVAX", "BCH", "BNB", "BTC", "CASHCAT", "CHIP", "CRV", "DOGE", "DOT", "DYDX",
  "ENA", "ETH", "FARTCOIN", "FIL", "GRASS", "HYPE", "HYPER", "INJ", "JUP",
  "KAITO", "LDO", "LINK", "LIT", "LTC", "NEAR", "OP", "PENDLE", "POPCAT",
  "PUMP", "SEI", "SOL", "SUI", "TAO", "TIA", "TON", "TRUMP", "UNI", "WIF",
  "WLD", "XRP", "ZRO",
];

const base = {
  coins: COINS,
  price: CHIP,
  available: 6.88,
  maxLeverage: 10,
  stopDistPct: 7.2,
  adoptEnabled: true,
  day: { netUsd: -1.77, limitUsd: 5, halted: false },
  positions,
};

const scenarios = {
  normal: { ctx: base, opts: { coin: "CHIP", side: "short" } },
  rich: {
    ctx: { ...base, available: 120, day: { netUsd: 0.4, limitUsd: 5, halted: false } },
    opts: { coin: "CHIP", side: "long" },
  },
  halted: {
    ctx: { ...base, day: { netUsd: -5.2, limitUsd: 5, halted: true } },
    opts: { coin: "CHIP", side: "short" },
  },
  nonanny: { ctx: { ...base, adoptEnabled: false }, opts: { coin: "CHIP", side: "short" } },
  nocoin: { ctx: { ...base, price: null }, opts: {} },
  reject: {
    ctx: base,
    io: { open: { ok: false, error: "Order has invalid price: post-only would cross the book" } },
    opts: { coin: "CHIP", side: "short" },
  },
};

document.querySelectorAll("[data-scenario]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const s = scenarios[btn.dataset.scenario];
    if (!s) return;
    const modal = createTradeTicketModal(mockIo(s.ctx, s.io || {}));
    await modal.open(s.opts);
  });
});

// Переключатель темы — стенд смотрят и в светлой.
document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("hl-scanner-theme", next);
});

mountPageHeader({
  // Стенд открывается без навбара, поэтому свитчер темы — здесь.
  extra: '<button id="theme-toggle" class="btn btn--sm">Theme</button>',
  eyebrow: "Trade Ticket",
  title: "Modal bench · mocks only, the exchange is not touched",
});
