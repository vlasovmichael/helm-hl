// ─────────────────────────────────────────────────
//  Калибратор — сколько точности требует монета, прежде чем окупятся издержки.
//
//  Витрина отвечает не «куда пойдёт», а «сколько стоит вход». Направление в
//  ценовом ряду не предсказуемо (автокорреляция −0.01 на 180 монетах),
//  амплитуда предсказуема у всех (0.25) — поэтому цели и стопы задаются в
//  долях собственного часового размаха монеты, а не в фиксированных бп.
//
//  🚨 Круг считается по КАЖДОЙ монете (комиссия + её спред), а не общей
//  константой: на широком неликвиде общий круг занижает издержки вдвое.
//
//  Расчёт тяжёлый (40 монет × 5000 баров × сетка 36), поэтому идёт по
//  расписанию в фон и кладётся в кэш; витрина читает готовое.
// ─────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../core/logger.js";
import { hlInfo, HL_PRIORITY } from "../core/hlClient.js";
import { resolveApiCoin } from "../core/universe.js";

const CACHE_DIR = join("data", "calibrator");
const CACHE = join(CACHE_DIR, "grid.json");
const FEE_TAKER_BP = 5.428;
const FEE_MAKER_BP = 1.439;
const HORIZON_BARS = 16;          // 4 часа на 15м баре
const MULT = [0.5, 0.75, 1, 1.5, 2, 3];
const MIN_BARS = 2000;            // короче — доверительный интервал шире любого вывода

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Одна ставка: цель tgt, стоп stp (бп), направление dir. Исход в бп.
// 🚨 Если бар задел обе цены, засчитывается стоп: порядок внутри бара неизвестен,
// и допущение в свою пользу превратило бы витрину в рекламу.
function play(bars, i, dir, tgt, stp) {
  const p0 = bars[i][4];
  for (let k = 1; k <= HORIZON_BARS && i + k < bars.length; k++) {
    const [, , h, l] = bars[i + k];
    const up = ((h - p0) / p0) * 1e4, dn = ((l - p0) / p0) * 1e4;
    const fav = dir > 0 ? up : -dn, adv = dir > 0 ? -dn : up;
    if (adv >= stp) return -stp;
    if (fav >= tgt) return tgt;
  }
  const last = bars[Math.min(i + HORIZON_BARS, bars.length - 1)][4];
  return (dir * (last - p0)) / p0 * 1e4;
}

async function halfSpreadBp(coin) {
  try {
    const b = await hlInfo({ type: "l2Book", coin: resolveApiCoin(coin) }, { label: "calib/l2", timeoutMs: 6000, priority: HL_PRIORITY.LOW });
    const bid = parseFloat(b.levels[0][0].px), ask = parseFloat(b.levels[1][0].px);
    return ((ask - bid) / 2 / ((bid + ask) / 2)) * 1e4;
  } catch {
    return null;
  }
}

function buildGrid(bars, atr, costTaker, costMaker) {
  const grid = [];
  for (const mt of MULT) {
    for (const ms of MULT) {
      const tgt = atr * mt, stp = atr * ms;
      const res = [];
      for (let i = 8; i < bars.length - HORIZON_BARS; i += 2) {
        res.push(play(bars, i, +1, tgt, stp));
        res.push(play(bars, i, -1, tgt, stp));
      }
      const n = res.length;
      const hit = (res.filter((x) => x >= tgt - 1e-9).length / n) * 100;
      const mean = res.reduce((s, x) => s + x, 0) / n;
      const sd = Math.sqrt(res.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
      // «Нужно» — доля попаданий, при которой пара цель/стоп выходит в ноль.
      // Разрыв с тем, что даёт сам рынок, и есть цена входа в монету.
      const need = (c) => ((stp + c) / (tgt + stp)) * 100;
      grid.push({
        mt, ms,
        tgt: +tgt.toFixed(1), stp: +stp.toFixed(1),
        hit: +hit.toFixed(1), n,
        ci: +((1.96 * sd) / Math.sqrt(n)).toFixed(2),
        needT: +need(costTaker).toFixed(1), gapT: +(need(costTaker) - hit).toFixed(1), eT: +(mean - costTaker).toFixed(2),
        needM: +need(costMaker).toFixed(1), gapM: +(need(costMaker) - hit).toFixed(1), eM: +(mean - costMaker).toFixed(2),
      });
    }
  }
  return grid;
}

export async function rebuild({ topN = 40, minVolUsd = 3e6 } = {}) {
  const [meta, ctxs] = await hlInfo({ type: "metaAndAssetCtxs" }, { label: "calib/meta", timeoutMs: 10_000, priority: HL_PRIORITY.LOW });
  const coins = meta.universe
    .map((u, i) => ({ name: u.name, vlm: parseFloat(ctxs[i]?.dayNtlVlm || 0), px: parseFloat(ctxs[i]?.markPx || 0) }))
    .filter((c) => c.vlm > minVolUsd)
    .sort((a, b) => b.vlm - a.vlm)
    .slice(0, topN);

  const out = {};
  for (const c of coins) {
    const end = Date.now();
    let bars;
    try {
      const d = await hlInfo(
        // 🚨 Через resolveApiCoin: у k-монет имя в universe и тикер расходятся,
        // и candleSnapshot по «сырому» имени молча отдаёт пусто.
        { type: "candleSnapshot", req: { coin: resolveApiCoin(c.name), interval: "15m", startTime: end - 5000 * 15 * 60_000, endTime: end } },
        { label: "calib/candles", timeoutMs: 15_000, priority: HL_PRIORITY.LOW },
      );
      if (!Array.isArray(d) || d.length < MIN_BARS) continue;
      bars = d.map((x) => [x.t, +x.o, +x.h, +x.l, +x.c]);
    } catch { continue; }

    const half = await halfSpreadBp(c.name);
    if (half == null) continue;
    const costTaker = 2 * (FEE_TAKER_BP + half);
    const costMaker = FEE_MAKER_BP + FEE_TAKER_BP + half;   // вход лимиткой, выход по рынку

    const ranges = [];
    for (let i = 4; i < bars.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let k = 0; k < 4; k++) { hi = Math.max(hi, bars[i - k][2]); lo = Math.min(lo, bars[i - k][3]); }
      ranges.push(((hi - lo) / bars[i][4]) * 1e4);
    }
    const atr = median(ranges);
    const grid = buildGrid(bars, atr, costTaker, costMaker);
    out[c.name] = {
      vlm: c.vlm, px: c.px, atr: +atr.toFixed(1), half: +half.toFixed(2),
      costTaker: +costTaker.toFixed(1), costMaker: +costMaker.toFixed(1),
      shareTaker: +((costTaker / atr) * 100).toFixed(1),
      shareMaker: +((costMaker / atr) * 100).toFixed(1),
      spark: bars.slice(-96).map((b) => b[4]),
      grid,
    };
  }

  const payload = { feeT: FEE_TAKER_BP, feeM: FEE_MAKER_BP, horizonH: HORIZON_BARS / 4, mult: MULT, built: Date.now(), coins: out };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE, JSON.stringify(payload));
  logger.info(`[Calibrator] пересчитан: ${Object.keys(out).length} монет`);
  return payload;
}

export function readCache() {
  if (!existsSync(CACHE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return null;
  }
}
