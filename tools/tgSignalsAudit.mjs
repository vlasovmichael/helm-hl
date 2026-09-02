// ─────────────────────────────────────────────────────────────────────────────
//  tgSignalsAudit — прогон чужих TG-сигналов по спотовым минуткам.
//
//  ЗАЧЕМ: канал публикует только победные апдейты, а проигрыши переоформляет в
//  «cancel this setup» / «force closed». Базрейт узнаётся единственным способом:
//  взять КАЖДЫЙ опубликованный сигнал (entry / SL / TP из самого поста) и
//  посчитать, что с ним сделала цена. Апдейты канала игнорируются намеренно —
//  считаем то, что получил подписчик, вошедший по сигналу как написано.
//
//  ДОПУЩЕНИЯ (сознательно НЕ в пользу канала — чтобы не завысить результат):
//    · вход только если цена коснулась entry в окне --entry-window (деф. 4ч);
//    · бар задел и SL, и TP → считаем SL (внутриминутного порядка не знаем);
//    · ни туда ни сюда за --horizon (деф. 24ч) → закрытие по рынку (mark-to-market);
//    · издержки: медианный спред инструмента, пересчитанный в доли риска.
//  Данные — спот Dukascopy (те же инструменты, что у канала), поэтому никакого
//  базиса фьючерса вычитать не нужно.
//
//  Запуск: node tools/tgSignalsAudit.mjs [--days 60] [--horizon 24]
//          [--entry-window 4] [--csv out.csv] [--no-fetch]
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHours } from "./dukascopyCandles.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const num = (k, d) => { const v = arg(k, null); return v === null ? d : parseFloat(v); };
const has = (k) => process.argv.includes(`--${k}`);

const CHANNEL = arg("channel", "Channel A");
const DAYS = num("days", 60);
const HORIZON_H = num("horizon", 24);
const ENTRY_H = num("entry-window", 4);
const CSV = arg("csv", null);
const BASELINE = num("baseline", 20);   // суррогатов на сигнал; 0 — не считать

const FEED = { XAUUSD: "XAUUSD", NAS100: "USATECHIDXUSD", BTCUSD: "BTCUSD" };

// ── разбор постов ───────────────────────────────────────────────────────────
const SYMS = [
  [/XAU\s*\/?\s*USD|\bGOLD\b/i, "XAUUSD"],
  [/NAS\s*100|NASDAQ|US\s*100/i, "NAS100"],
  [/BTC\s*\/?\s*USD|\bBITCOIN\b/i, "BTCUSD"],
];
const price = (s) => (s == null ? null : parseFloat(String(s).replace(/[,\s]/g, "")));

function parseSignal(text) {
  if (!/PREMIUM SIGNALS/i.test(text)) return null;
  const head = text.slice(0, 400);
  const sym = SYMS.find(([re]) => re.test(head))?.[1];
  if (!sym) return null;
  const side = /\bSELL\b/i.test(head) ? "SELL" : /\bBUY\b/i.test(head) ? "BUY" : null;
  if (!side) return null;
  const entry = price(text.match(/(?:BUY|SELL)[^@\n]{0,40}@\s*([\d,]+(?:\.\d+)?)/i)?.[1]);
  const tp1 = price(text.match(/TP\s*1[^\d\n]{0,12}([\d,]+(?:\.\d+)?)/i)?.[1]);
  const sl = price(text.match(/Stop\s*Loss[^\d\n]{0,12}([\d,]+(?:\.\d+)?)/i)?.[1]);
  if (!(entry > 0 && tp1 > 0 && sl > 0)) return null;
  // стоп и цель обязаны стоять по разные стороны от входа, иначе это не сигнал
  const ok = side === "BUY" ? sl < entry && tp1 > entry : sl > entry && tp1 < entry;
  if (!ok) return null;
  return { sym, side, entry, tp1, sl };
}

const raw = JSON.parse(readFileSync(join("data", "tg-signals", `${CHANNEL}.raw.json`), "utf8"));
const since = Date.now() - DAYS * 864e5;
const byKey = new Map();                     // сигнал цитируется в каждом апдейте — дедуп
for (const m of raw) {
  const s = parseSignal(m.text || "");
  if (!s || !m.ts) continue;
  const t = Date.parse(m.ts);
  const key = `${s.sym}|${s.side}|${s.entry}|${s.sl}|${s.tp1}`;
  const prev = byKey.get(key);
  if (!prev || t < prev.t) byKey.set(key, { ...s, t, id: m.id });
}
const signals = [...byKey.values()].filter((s) => s.t >= since).sort((a, b) => a.t - b.t);
if (!signals.length) { console.error("сигналов в окне нет"); process.exit(1); }

// ── свечи: качаем только часы вокруг сигналов ───────────────────────────────
const HZ = HORIZON_H * 3600_000, EW = ENTRY_H * 3600_000;
const data = {};
for (const sym of Object.keys(FEED)) {
  const mine = signals.filter((s) => s.sym === sym);
  if (!mine.length) continue;
  const hours = new Set();
  for (const s of mine) {
    const a = s.t - 3600_000 - ((s.t - 3600_000) % 3600_000), b = s.t + EW + HZ;
    for (let h = a; h <= b; h += 3600_000) hours.add(h);
  }
  const rows = has("no-fetch")
    ? (await ensureHours(sym === "NAS100" ? FEED[sym] : sym, []))
    : await ensureHours(FEED[sym], [...hours], (d, n, bars) =>
        process.stderr.write(`\r${sym}: ${d}/${n} часов · ${bars} минут      `));
  data[sym] = rows;
}
process.stderr.write("\r".padEnd(60) + "\r");

const barAt = (rows, t) => {
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
};

// ── симуляция ───────────────────────────────────────────────────────────────

/** Прогон одной сделки по минуткам. Возвращает {outcome, r, mgmt} или null. */
function simulate(rows, t, side, entry, sl, tp1) {
  const risk = Math.abs(entry - sl);
  const rr = Math.abs(tp1 - entry) / risk;
  const long = side === "BUY";
  const start = barAt(rows, t);
  if (start < 0 || start >= rows.length - 2) return null;
  if (Math.abs(rows[start][0] - t) > 30 * 60_000) return { outcome: "нет данных", r: null, mgmt: null, rr };

  let fill = -1;
  for (let i = start; i < rows.length && rows[i][0] - t <= EW; i++) {
    if (rows[i][3] <= entry && entry <= rows[i][2]) { fill = i; break; }
  }
  if (fill < 0) return { outcome: "no-fill", r: null, mgmt: null, rr };

  const spread = rows[fill][5] ?? 0;
  // Сценарий «как учит канал»: половина фиксируется на полпути к TP1, стоп
  // переносится в безубыток («partials secured», «SL to BE» — их же слова).
  const half = long ? entry + (tp1 - entry) / 2 : entry - (entry - tp1) / 2;
  let mgmt = null, outcome = "timeout", r = 0, both = false, took = false;

  for (let i = fill; i < rows.length && rows[i][0] - rows[fill][0] <= HZ; i++) {
    const hitSL = long ? rows[i][3] <= sl : rows[i][2] >= sl;
    const hitTP = long ? rows[i][2] >= tp1 : rows[i][3] <= tp1;
    const hitHalf = long ? rows[i][2] >= half : rows[i][3] <= half;
    const backToBE = long ? rows[i][3] <= entry : rows[i][2] >= entry;
    if (mgmt === null) {
      if (!took && hitSL) mgmt = -1;
      else if (hitHalf) took = true;
      if (took && hitTP) mgmt = 0.75 * rr;
      else if (took && backToBE && !hitTP) mgmt = 0.25 * rr;
    }
    if (hitSL && hitTP) { both = true; outcome = "SL(ambig)"; r = -1; break; }
    if (hitSL) { outcome = "SL"; r = -1; break; }
    if (hitTP) { outcome = "TP1"; r = rr; break; }
    if (i === rows.length - 1 || rows[i + 1][0] - rows[fill][0] > HZ) {
      outcome = "timeout";
      r = (long ? rows[i][4] - entry : entry - rows[i][4]) / risk;
    }
  }
  if (mgmt === null) {
    const last = rows[Math.min(rows.length - 1, barAt(rows, rows[fill][0] + HZ))];
    const mtm = (long ? last[4] - entry : entry - last[4]) / risk;
    mgmt = took ? 0.25 * rr + 0.5 * mtm : mtm;
  }
  return { outcome, r: r - spread / risk, mgmt: mgmt - spread / risk, both, spread, risk, rr };
}

const results = [];
for (const s of signals) {
  const rows = data[s.sym];
  if (!rows?.length) continue;
  const res = simulate(rows, s.t, s.side, s.entry, s.sl, s.tp1);
  if (res) results.push({ ...s, ...res });
}

// ── бейзлайн: та же геометрия, случайный момент ─────────────────────────────
// Если сигналы не лучше случайного входа с теми же стопом/целью, значит работает
// геометрия сделки, а выбора момента («order block», «FVG») в цифрах нет.
const baseline = [];
if (BASELINE > 0) {
  for (const s of signals) {
    const rows = data[s.sym];
    if (!rows?.length) continue;
    const i0 = barAt(rows, s.t);
    if (i0 < 0) continue;
    const mkt = rows[i0][4];
    const off = s.entry - mkt;                       // насколько вход отложен от рынка
    const dSL = s.sl - s.entry, dTP = s.tp1 - s.entry;
    for (let k = 0; k < BASELINE; k++) {
      const j = (Math.random() * (rows.length - 2)) | 0;
      const px = rows[j][4] + off;
      const res = simulate(rows, rows[j][0], s.side, px, px + dSL, px + dTP);
      if (res?.r != null) baseline.push(res);
    }
  }
}

// ── отчёт ───────────────────────────────────────────────────────────────────
const fm = (v, n = 2) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(n));
const scored = results.filter((x) => x.r != null);
const boot = (arr, iters = 5000) => {
  const means = [];
  for (let k = 0; k < iters; k++) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[(Math.random() * arr.length) | 0]; means.push(s / arr.length); }
  means.sort((a, b) => a - b);
  return [means[(iters * 0.025) | 0], means[(iters * 0.975) | 0]];
};

console.log(`\n═══ ${CHANNEL} · аудит опубликованных сигналов ═══`);
console.log(`окно: последние ${DAYS} дней (${new Date(signals[0].t).toISOString().slice(0, 10)} … ${new Date(signals.at(-1).t).toISOString().slice(0, 10)})`);
console.log(`распознано сигналов: ${signals.length} · дошло до счёта: ${scored.length}`);
console.log(`правила: вход по цене поста в окне ${ENTRY_H}ч · горизонт ${HORIZON_H}ч · спред как издержка · SL при неоднозначном баре`);
console.log(`данные: спот Dukascopy (${Object.entries(FEED).map(([k, v]) => `${k}→${v}`).join(", ")})\n`);

const groups = [["ВСЕ", scored], ...Object.keys(FEED).map((s) => [s, scored.filter((x) => x.sym === s)])];
console.log("  группа    n    TP1   SL  timeout    WR      сумма R   средний R    95% CI");
for (const [name, arr] of groups) {
  if (!arr.length) continue;
  const tp = arr.filter((x) => x.outcome === "TP1").length;
  const sl = arr.filter((x) => x.outcome.startsWith("SL")).length;
  const to = arr.filter((x) => x.outcome === "timeout").length;
  const rs = arr.map((x) => x.r);
  const sum = rs.reduce((a, b) => a + b, 0);
  const [lo, hi] = boot(rs);
  console.log(`  ${name.padEnd(8)} ${String(arr.length).padStart(3)}  ${String(tp).padStart(4)} ${String(sl).padStart(4)} ${String(to).padStart(6)}   ${((tp / arr.length) * 100).toFixed(0).padStart(3)}%  ${fm(sum, 1).padStart(9)}  ${fm(sum / arr.length, 3).padStart(10)}   ${fm(lo, 3)}..${fm(hi, 3)}`);
}

console.log("\nтот же набор сигналов по правилам самого канала (50% на полпути, стоп в безубыток):");
console.log("  группа    n   полный TP   БУ-выход    стоп     сумма R   средний R    95% CI");
for (const [name, arr] of groups) {
  if (!arr.length) continue;
  const full = arr.filter((x) => x.mgmt > 0.5 * x.rr).length;
  const be = arr.filter((x) => x.mgmt > 0 && x.mgmt <= 0.5 * x.rr).length;
  const stopped = arr.filter((x) => x.mgmt <= 0).length;
  const ms = arr.map((x) => x.mgmt);
  const sum = ms.reduce((a, b) => a + b, 0);
  const [lo, hi] = boot(ms);
  console.log(`  ${name.padEnd(8)} ${String(arr.length).padStart(3)}   ${String(full).padStart(6)}   ${String(be).padStart(7)}  ${String(stopped).padStart(6)}  ${fm(sum, 1).padStart(9)}  ${fm(sum / arr.length, 3).padStart(10)}   ${fm(lo, 3)}..${fm(hi, 3)}`);
}

if (baseline.length) {
  const rs = baseline.map((x) => x.r), ms = baseline.map((x) => x.mgmt);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const [lo, hi] = boot(rs);
  const real = mean(scored.map((x) => x.r));
  console.log(`\nбейзлайн (та же геометрия, случайный момент, ${baseline.length} прогонов):`);
  console.log(`  средний R ${fm(mean(rs), 3)} (95% CI ${fm(lo, 3)}..${fm(hi, 3)}) · по правилам канала ${fm(mean(ms), 3)}`);
  console.log(`  сигнал − бейзлайн: ${fm(real - mean(rs), 3)} R на сделку`);
}

const nf = results.filter((x) => x.outcome === "no-fill").length;
const nd = results.filter((x) => x.outcome === "нет данных").length;
const amb = scored.filter((x) => x.both).length;
console.log(`\nвход не сработал: ${nf} · без данных: ${nd} · неоднозначных баров (SL и TP в одной минуте): ${amb}`);
const rrs = signals.map((s) => Math.abs(s.tp1 - s.entry) / Math.abs(s.entry - s.sl)).sort((a, b) => a - b);
const rrMed = rrs[rrs.length >> 1];
console.log(`заявленный R:R по TP1: медиана ${rrMed.toFixed(2)} → для нуля нужен WR ${(100 / (1 + rrMed)).toFixed(0)}%, фактический ${((scored.filter((x) => x.outcome === "TP1").length / scored.length) * 100).toFixed(0)}%`);
const spreads = scored.map((x) => x.spread / x.risk).sort((a, b) => a - b);
if (spreads.length) console.log(`спред съедает медианно ${(spreads[spreads.length >> 1] * 100).toFixed(1)}% риска сделки`);

if (CSV) {
  writeFileSync(CSV, "ts,sym,side,entry,sl,tp1,rr,outcome,r,r_mgmt\n" +
    results.map((x) => [new Date(x.t).toISOString(), x.sym, x.side, x.entry, x.sl, x.tp1, x.rr.toFixed(2), x.outcome, x.r == null ? "" : x.r.toFixed(3), x.mgmt == null ? "" : x.mgmt.toFixed(3)].join(",")).join("\n"));
  console.log(`\nпосделочно → ${CSV}`);
}
console.log();
