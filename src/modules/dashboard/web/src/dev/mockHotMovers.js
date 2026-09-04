// ─────────────────────────────────────────────────
//  DEV-ONLY мок Hot Movers: ?mock=hm (динамический импорт из index.js) →
//  в проде его нет. Тики синтетические, порядок монет меняется каждые 2с —
//  на этом смотрят движение таблицы, живые тики иначе только с бэка.
//  Удалить = убрать файл + ветку "hm" в index.js.
// ─────────────────────────────────────────────────

import { renderHotMovers } from "../hotMovers/render.js";
import { updateActiveCoinSet } from "../state/activeCoins.js";

const COINS = ["SOL", "HYPE", "BTC", "WIF", "kBONK", "ETH", "SUI", "FART"];

// Своя частота и фаза у каждой монеты — иначе перестановки как метроном.
const PHASE = COINS.map((_, i) => ({ w: 0.35 + i * 0.11, p: i * 1.7 }));

const price = (i) => 10 + i * 3.7;

function payload(t) {
  return {
    ts: Date.now(),
    thresholds: {},
    marketFlush: null,
    signals: COINS.map((coin, i) => {
      const { w, p } = PHASE[i];
      const base = Math.sin(t * w + p) * 5;
      const win = (mins, k) => ({ mins, spikePct: base * k, volUsd: 1e6 });
      return {
        coin,
        price: price(i) * (1 + base / 400),
        windows: [win(2, 0.4), win(5, 0.8), win(15, 1.2), win(60, 1.6)],
        volMult: 1 + Math.abs(Math.sin(t * w)) * 2,
        oiChangePct: base,
        htfTrend: base > 1 ? "up" : base < -1 ? "down" : "flat",
        vol24hUsd: 5e8,
        oiUsd: 9e8,
        spark: Array.from(
          { length: 24 },
          (_, k) => price(i) * (1 + Math.sin(t * w + p + k / 4) / 200),
        ),
      };
    }),
  };
}

/**
 * Синтетические тики Hot Movers; возвращает функцию остановки.
 * `positions` (?mock=hm&pos=SOL,BTC) — открытые монеты: пиннятся наверх и
 * тянут под-строку позиции, на ней проверяется высота карточки.
 */
export function startHotMoversMock({ everyMs = 2000, positions = [] } = {}) {
  if (positions.length) {
    updateActiveCoinSet(
      {
        coin: positions[0],
        side: "SHORT",
        entryPrice: price(COINS.indexOf(positions[0])),
        currentPrice: price(COINS.indexOf(positions[0])) * 1.01,
        currentPnl: { netMarket: -0.42 },
        heldHours: 1.4,
        sizeUsd: 41.2,
        // Чипы под-строки рисуются от bot.*: без них её вообще не будет.
        bot: {
          floorPct: 0,
          floorPrice: price(COINS.indexOf(positions[0])),
          floorKind: "be",
          stopPrice: price(COINS.indexOf(positions[0])) * 1.05,
        },
      },
      positions.slice(1).map((coin) => ({
        coin,
        side: "LONG",
        entryPrice: price(COINS.indexOf(coin)),
        markPrice: price(COINS.indexOf(coin)) * 1.02,
        sizeUsd: 30,
        leverage: 3,
      })),
    );
  }
  let t = 0;
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString();
  const tick = () => {
    t += 1;
    renderHotMovers(payload(t), fmtTime);
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return () => clearInterval(timer);
}
