// ─────────────────────────────────────────────────
//  DEV-ONLY мок Hot Movers. Грузится ТОЛЬКО при ?mock=hm (динамический импорт
//  из index.js) → в проде его нет.
//
//  Зачем: решения про ДВИЖЕНИЕ этой таблицы («едет строка на новое место или
//  нет») нельзя принять по коду и нельзя посмотреть локально — для них нужны
//  живые тики, а они приходят только с бэка. Из-за этого вариант анимации
//  трижды выкатывался вслепую и трижды не нравился. Здесь тики синтетические:
//  порядок монет меняется каждые 2с, как на живом рынке.
//
//  Удалить = убрать файл + ветку "hm" в index.js.
// ─────────────────────────────────────────────────

import { renderHotMovers } from "../hotMovers/render.js";

const COINS = ["SOL", "HYPE", "BTC", "WIF", "kBONK", "ETH", "SUI", "FART"];

// Каждой монете — своя частота и фаза, чтобы перестановки выглядели как рынок
// (кто-то обгоняет соседа, кто-то проваливается через полтаблицы), а не как
// метроном.
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

/** Запускает синтетические тики Hot Movers. Возвращает функцию остановки. */
export function startHotMoversMock({ everyMs = 2000 } = {}) {
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
