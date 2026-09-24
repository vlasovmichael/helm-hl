// ─────────────────────────────────────────────────
//  journal-mtf-bias-2026-09 — предсказывает ли вердикт журнала направление цены.
//
//  Правило bias — точная копия analyzeMultiTF из src/modules/chartCoach.js:
//  тренд EMA20/50 (разнос 0.15% и цена по нужную сторону медленной) на 4h и 1h.
//  5m в корпусе нет — «триггер» младшего ТФ проверяется на 15m той же формулой.
//  Метрика: доходность вперёд в сторону bias минус среднее всех монет в тот же час.
//  Команда power — мощность на синтетике до данных; audit — единственный прогон.
// ─────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { rng } from "./baseline.mjs";
import { loadSymbol } from "./srFlipAudit.mjs";

const BAR_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const RULE = Object.freeze({
  fast: 20,
  slow: 50,
  sepPct: 0.15,
  warmBars: 100,
  horizons: Object.freeze({ h1: 4, h4: 16, h24: 96 }),
  costBp: 8.64,
  from: Date.UTC(2021, 0, 1),
  toExclusive: Date.UTC(2026, 0, 1),
});

export const CONFIG = Object.freeze({
  bootstrapIterations: 10_000,
  bootstrapSeed: 2_026_092_404,
  minDays: 100,
});

/** Инкрементальная EMA с тем же стартом, что ema() в chartCoach: первое значение = первый close. */
function emaStep(prev, value, period) {
  return prev == null ? value : value * (2 / (period + 1)) + prev * (1 - 2 / (period + 1));
}

function trend(state, price) {
  if (state.n < Math.max(RULE.slow + 1, RULE.warmBars)) return null;
  const sep = ((state.f - state.s) / state.s) * 100;
  if (sep > RULE.sepPct && price >= state.s) return "up";
  if (sep < -RULE.sepPct && price <= state.s) return "down";
  return "flat";
}

/** Bias журнала: +1 LONG, −1 SHORT, 0 в стороне. */
export function biasOf(trend4h, trend1h) {
  if (trend4h === "up" && trend1h !== "down") return 1;
  if (trend4h === "down" && trend1h !== "up") return -1;
  if (trend4h === "flat" && trend1h === "up") return 1;
  if (trend4h === "flat" && trend1h === "down") return -1;
  return 0;
}

/**
 * Якоря одного непрерывного сегмента 15m: каждый час, состояние EMA — только по
 * закрытым барам до t0, цена = open бара t0. Доходности вперёд — log от open t0.
 */
export function segmentAnchors(bars) {
  const s4 = { f: null, s: null, n: 0 };
  const s1 = { f: null, s: null, n: 0 };
  const s15 = { f: null, s: null, n: 0 };
  const push = (st, close) => {
    st.f = emaStep(st.f, close, RULE.fast);
    st.s = emaStep(st.s, close, RULE.slow);
    st.n++;
  };
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const t = bars[i].t;
    if (t % HOUR_MS === 0 && t >= RULE.from && t < RULE.toExclusive) {
      const price = bars[i].o;
      const t4 = trend(s4, price);
      const t1 = trend(s1, price);
      const t15 = trend(s15, price);
      if (t4 && t1 && t15) {
        const fwd = {};
        for (const [key, h] of Object.entries(RULE.horizons)) {
          fwd[key] = i + h - 1 < bars.length ? Math.log(bars[i + h - 1].c / price) : null;
        }
        const bias = biasOf(t4, t1);
        const want = bias > 0 ? "up" : "down";
        out.push({ t, bias, agree15: bias !== 0 && t15 === want ? 1 : 0, ...fwd });
      }
    }
    push(s15, bars[i].c);
    // Бар 1h (4h) закрыт, когда закрылся последний 15m внутри него и все его 15m на месте.
    if ((t + BAR_MS) % HOUR_MS === 0 && i >= 3 && bars[i - 3].t === t - 3 * BAR_MS) push(s1, bars[i].c);
    if ((t + BAR_MS) % (4 * HOUR_MS) === 0 && i >= 15 && bars[i - 15].t === t - 15 * BAR_MS) push(s4, bars[i].c);
  }
  return out;
}

/** Суммы по дням для групп; бутстрап ресэмплит дни одним набором для всех групп. */
class DayGroups {
  constructor(names) {
    this.names = names;
    this.data = Object.fromEntries(names.map((n) => [n, new Map()]));
  }
  add(name, day, value) {
    const map = this.data[name];
    const cell = map.get(day);
    if (cell) {
      cell[0] += value;
      cell[1]++;
    } else map.set(day, [value, 1]);
  }
  mean(name) {
    let s = 0;
    let c = 0;
    for (const [v, n] of this.data[name].values()) {
      s += v;
      c += n;
    }
    return c ? s / c : null;
  }
  count(name) {
    let c = 0;
    for (const [, n] of this.data[name].values()) c += n;
    return c;
  }
  bootstrap(pairs, iterations, seed) {
    const days = [...new Set(this.names.flatMap((n) => [...this.data[n].keys()]))].sort((a, b) => a - b);
    const random = rng(seed);
    const est = Object.fromEntries(this.names.map((n) => [n, []]));
    const diff = Object.fromEntries(pairs.map(([a, b]) => [`${a}-${b}`, []]));
    for (let it = 0; it < iterations; it++) {
      const acc = Object.fromEntries(this.names.map((n) => [n, [0, 0]]));
      for (let k = 0; k < days.length; k++) {
        const day = days[Math.floor(random() * days.length)];
        for (const n of this.names) {
          const cell = this.data[n].get(day);
          if (cell) {
            acc[n][0] += cell[0];
            acc[n][1] += cell[1];
          }
        }
      }
      const m = Object.fromEntries(this.names.map((n) => [n, acc[n][1] ? acc[n][0] / acc[n][1] : NaN]));
      for (const n of this.names) est[n].push(m[n]);
      for (const [a, b] of pairs) diff[`${a}-${b}`].push(m[a] - m[b]);
    }
    const ci = (v) => {
      const s = v.filter(Number.isFinite).sort((x, y) => x - y);
      return { lo: s[Math.floor(s.length * 0.025)], hi: s[Math.floor(s.length * 0.975)] };
    };
    return {
      days: days.length,
      groups: Object.fromEntries(this.names.map((n) => [n, ci(est[n])])),
      diffs: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, ci(v)])),
    };
  }
}

export const GROUPS = Object.freeze([
  "excess4h", "raw4h", "excess1h", "excess24h",
  "long", "short", "btcUp", "btcDown", "agree15", "disagree15",
]);

/** Сводит якоря всех символов: excess = сторона × (доходность − среднее всех монет в этот час). */
export function evaluate(bySymbol, btcRegime, { iterations = CONFIG.bootstrapIterations, seed = CONFIG.bootstrapSeed } = {}) {
  const cross = new Map();
  for (const anchors of bySymbol.values()) {
    for (const a of anchors) {
      let c = cross.get(a.t);
      if (!c) cross.set(a.t, (c = { h1: [0, 0], h4: [0, 0], h24: [0, 0] }));
      for (const key of ["h1", "h4", "h24"]) {
        if (a[key] != null) {
          c[key][0] += a[key];
          c[key][1]++;
        }
      }
    }
  }
  const g = new DayGroups([...GROUPS]);
  const byYear = new Map();
  let aside = 0;
  let total = 0;
  for (const anchors of bySymbol.values()) {
    for (const a of anchors) {
      total++;
      if (a.bias === 0) {
        aside++;
        continue;
      }
      const c = cross.get(a.t);
      if (a.h4 == null || c.h4[1] < 2) continue;
      const day = Math.floor(a.t / DAY_MS);
      const ex4 = a.bias * (a.h4 - c.h4[0] / c.h4[1]) * 1e4;
      g.add("excess4h", day, ex4);
      g.add("raw4h", day, a.bias * a.h4 * 1e4);
      if (a.h1 != null && c.h1[1] >= 2) g.add("excess1h", day, a.bias * (a.h1 - c.h1[0] / c.h1[1]) * 1e4);
      if (a.h24 != null && c.h24[1] >= 2) g.add("excess24h", day, a.bias * (a.h24 - c.h24[0] / c.h24[1]) * 1e4);
      g.add(a.bias > 0 ? "long" : "short", day, ex4);
      const regime = btcRegime.get(a.t);
      if (regime) g.add(regime === "btc_up" ? "btcUp" : "btcDown", day, ex4);
      g.add(a.agree15 ? "agree15" : "disagree15", day, ex4);
      const year = new Date(a.t).getUTCFullYear();
      const y = byYear.get(year) ?? [0, 0];
      y[0] += ex4;
      y[1]++;
      byYear.set(year, y);
    }
  }
  const boot = g.bootstrap([["agree15", "disagree15"]], iterations, seed);
  const row = (n) => ({ n: g.count(n), meanBp: g.mean(n), ci95: boot.groups[n] });
  const stats = Object.fromEntries(GROUPS.map((n) => [n, row(n)]));
  const gates = {
    excessCiPositive: stats.excess4h.meanBp > 0 && stats.excess4h.ci95.lo > 0,
    bothBtcRegimesPositive: stats.btcUp.meanBp > 0 && stats.btcDown.meanBp > 0,
    bothSidesPositive: stats.long.meanBp > 0 && stats.short.meanBp > 0,
  };
  const economics = stats.raw4h.ci95.lo > RULE.costBp;
  const passed = Object.values(gates).every(Boolean);
  const verdict = boot.days < CONFIG.minDays ? "INCONCLUSIVE"
    : !passed ? "REJECTED" : economics ? "PASSED_ECONOMICS" : "PASSED_STAT";
  return {
    days: boot.days,
    anchors: total,
    standAsideShare: total ? aside / total : null,
    stats,
    trigger15: { meanBp: g.mean("agree15") - g.mean("disagree15"), ci95: boot.diffs["agree15-disagree15"] },
    byYear: Object.fromEntries([...byYear].map(([y, [s, n]]) => [y, { n, meanBp: s / n }])),
    gates,
    economics,
    verdict,
  };
}

/** Синтетика: momentum — дрейф бара в сторону 4h-тренда, в долях log-доходности за 15m. */
export function syntheticSymbols({ symbols = 12, days = 700, momentum = 0, seed = 5 } = {}) {
  const random = rng(seed);
  const t0 = RULE.from;
  const out = new Map();
  for (let s = 0; s < symbols; s++) {
    const bars = [];
    let p = 100;
    const s4 = { f: null, s: null, n: 0 };
    for (let i = 0; i < days * 96; i++) {
      const t = t0 + i * BAR_MS;
      const tr = trend(s4, p);
      const drift = tr === "up" ? momentum : tr === "down" ? -momentum : 0;
      const o = p;
      p *= Math.exp((random() - 0.5) * 0.008 + drift);
      bars.push({ t, o, h: Math.max(o, p), l: Math.min(o, p), c: p });
      if ((t + BAR_MS) % (4 * HOUR_MS) === 0) {
        s4.f = emaStep(s4.f, p, RULE.fast);
        s4.s = emaStep(s4.s, p, RULE.slow);
        s4.n++;
      }
    }
    out.set(`S${s}`, segmentAnchors(bars));
  }
  return out;
}

function power() {
  for (const momentum of [0, 0.00002, 0.00005, 0.0001]) {
    const r = evaluate(syntheticSymbols({ momentum }), new Map(), { iterations: 1_000, seed: 3 });
    const e = r.stats.excess4h;
    const bp4h = (momentum * 16 * 1e4).toFixed(1);
    process.stdout.write(
      `встроенный дрейф ${bp4h} бп/4ч: excess ${e.meanBp.toFixed(2)} бп CI [${e.ci95.lo.toFixed(2)}; ${e.ci95.hi.toFixed(2)}]`
      + ` → ${e.ci95.lo > 0 ? "ловит" : "не ловит"}; 15m-триггер ${r.trigger15.meanBp.toFixed(2)} [${r.trigger15.ci95.lo.toFixed(2)}; ${r.trigger15.ci95.hi.toFixed(2)}]\n`,
    );
  }
}

async function audit({ dataDir, outputPath }) {
  const manifest = JSON.parse(readFileSync(`${dataDir}/manifest.json`, "utf8"));
  const supplement = manifest.supplement ? JSON.parse(readFileSync(manifest.supplement.path, "utf8")) : { files: [] };
  const bySymbolFiles = new Map();
  for (const file of [...manifest.files, ...(supplement.files ?? [])]) {
    if (!bySymbolFiles.has(file.symbol)) bySymbolFiles.set(file.symbol, []);
    bySymbolFiles.get(file.symbol).push(file);
  }
  const verification = { files: 0 };
  const bySymbol = new Map();
  const btcRegime = new Map();
  const symbols = [...bySymbolFiles.keys()].sort();
  for (let k = 0; k < symbols.length; k++) {
    const symbol = symbols[k];
    const loaded = await loadSymbol(bySymbolFiles.get(symbol), verification);
    const anchors = [];
    for (const segment of loaded.segments) anchors.push(...segmentAnchors(segment));
    bySymbol.set(symbol, anchors);
    if (symbol === "BTCUSDT") {
      const closes = new Map(loaded.segments.flat().map((b) => [b.t, b.c]));
      for (const a of anchors) {
        const recent = closes.get(a.t - BAR_MS);
        const old = closes.get(a.t - BAR_MS - 96 * BAR_MS);
        if (recent != null && old != null) btcRegime.set(a.t, recent > old ? "btc_up" : "btc_down");
      }
    }
    if (k % 50 === 0) process.stderr.write(`${k + 1}/${symbols.length} ${symbol}\n`);
  }
  const result = evaluate(bySymbol, btcRegime);
  const report = { id: "journal-mtf-bias-2026-09", ranAt: new Date().toISOString(), rule: RULE, config: CONFIG, filesVerified: verification.files, symbols: symbols.length, ...result };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ verdict: result.verdict, gates: result.gates, economics: result.economics, stats: result.stats, trigger15: result.trigger15, byYear: result.byYear, standAsideShare: result.standAsideShare }, null, 2)}\n`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === "power") power();
  else if (process.argv[2] === "audit") {
    await audit({ dataDir: arg("data", "data/binance-f2"), outputPath: arg("out", "docs/edge-search/journal-bias-audit.json") });
  } else throw new Error("команды: power | audit");
}
