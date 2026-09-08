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
      // Вердикт Costly side / Move считает сервер (routes/entryFilter.js);
      // здесь его пороги повторены, иначе колонки в моке всегда пустые.
      const t1h = base * 1.6, t15m = base * 1.2;
      const level =
        Math.abs(t1h) >= 5 ? "extreme"
        : Math.abs(t1h) >= 3 ? "strong"
        : Math.abs(t15m) >= 1.5 ? "fast"
        : "quiet";
      return {
        coin,
        price: price(i) * (1 + base / 400),
        windows: [win(2, 0.4), win(5, 0.8), win(15, 1.2), win(60, 1.6)],
        chasing: {
          level,
          blockedSide: level === "quiet" ? null : (t1h > 0 ? "LONG" : "SHORT"),
          text: `${t1h.toFixed(1)}% in an hour — mock`,
        },
        volMult: 1 + Math.abs(Math.sin(t * w)) * 2,
        oiChangePct: base,
        // OI решает тег режима; фаза своя у монеты — в таблице есть все три.
        oiDelta15m: Math.sin(t * w * 0.7 + i) * 3,
        oiDelta5m: Math.sin(t * w * 0.9 + i) * 2,
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

// Стенд состояний колонки Costly side: по строке на каждое, ничего не движется.
// ?mock=hm&states=1
const STATES = [
  { coin: "AAA", note: "LONG TREND",   px: 1.2, mom: 4, oi: 3,    costly: null },
  { coin: "BBB", note: "SHORT TREND",  px: -1.2, mom: -4, oi: 3,  costly: null },
  { coin: "CCC", note: "LONG FADE?",   px: 1.2, mom: 4, oi: -3,   costly: null },
  { coin: "DDD", note: "SHORT FADE?",  px: -1.2, mom: -4, oi: -3, costly: null },
  { coin: "EEE", note: "WAIT",         px: 0.05, mom: 0.2, oi: 0, costly: null },
  { coin: "FFF", note: "no data",      px: 1, mom: null, oi: 0,   costly: null },
  { coin: "GGG", note: "LONG + costly", px: 1.2, mom: 4, oi: 3,   costly: "LONG" },
  { coin: "HHH", note: "SHORT + costly", px: -1.2, mom: -4, oi: 3, costly: "SHORT" },
  { coin: "III", note: "tail alarm", px: 4, mom: 4, oi: 3, costly: null, fadeHot: { fired: true, side: "SHORT", move: 4.2, er: 0.61 } },
];

function statesPayload(flushDir) {
  return {
    ts: Date.now(),
    thresholds: {},
    // dir=up → чип SQUEEZE с пламенем, down → FLUSH с волнами.
    marketFlush: flushDir ? { active: true, dir: flushDir, share: 0.72, n: 30 } : null,
    signals: STATES.map((st, i) => ({
      coin: st.coin,
      price: 10 + i,
      windows: st.mom == null
        ? [{ mins: 2, spikePct: null }, { mins: 5, spikePct: null }, { mins: 15, spikePct: null }, { mins: 60, spikePct: null }]
        : [2, 5, 15, 60].map((mins) => ({ mins, spikePct: st.mom, volUsd: 1e6 })),
      volMult: 1.5,
      oiDelta15m: st.oi,
      oiDelta5m: st.oi,
      htfTrend: "flat",
      fadeHot: st.fadeHot || null,
      vol24hUsd: 1e8,
      oiUsd: 9e8,
      chasing: st.costly
        ? { level: "extreme", blockedSide: st.costly, text: `${st.px}% in an hour — mock` }
        : { level: "quiet", blockedSide: null, text: "" },
      spark: Array.from({ length: 24 }, () => 10 + i),
    })),
  };
}

/** Статичный стенд: рисуем один раз, ничего не дёргается. */
export function startHotMoversStates({ flushDir = "up" } = {}) {
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString();
  renderHotMovers(statesPayload(flushDir), fmtTime);
  return () => {};
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
