// ─────────────────────────────────────────────────────────────────────────────
//  FVG (Fair Value Gap) по 4 правилам из треда:
//   1) зоны ищем на старшем ТФ (1h/4h)  2) только по тренду ТФ
//   3) вход на ретесте зоны (опц. с подтверждающей свечой)
//   4) стоп за противоположную границу зоны
//
//  Зона: bull — high[i-2] < low[i] (разрыв), торгуем лонг при up-тренде.
//  Детекция и тренд — на HTF; ретест и исход — по 15m барам (точнее и честнее).
//
//  Меряем в R против бейзлайнов: та же геометрия стопа, но вход случайный.
//
//  Запуск: node scripts/backtestFvg.js [--tf 4h] [--rr 2] [--wait 20]
//          [--maxh 96] [--rt 0.10] [--imp 0] [--confirm] [--boot]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const TF      = arg('tf', '4h');
const RR      = parseFloat(arg('rr', '2'));
const WAIT    = parseInt(arg('wait', '20'), 10);    // сколько HTF-баров ждём ретест
const MAXH    = parseInt(arg('maxh', '96'), 10);    // таймаут после входа, 15m баров
const RT      = parseFloat(arg('rt', '0.10'));      // издержки round-trip, %
const MINW    = parseFloat(arg('minw', '0.3'));     // мин. ширина зоны, % (уже — стоп внутри спреда)
const PEN     = parseFloat(arg('pen', '0'));       // требовать заход в зону на PEN×ширину (реализм лимитки)
const IMP     = parseFloat(arg('imp', '0'));        // импульсная свеча ≥ IMP×ATR (0 = не требовать)
const CONFIRM = process.argv.includes('--confirm'); // ждать подтверждающую свечу
const DB      = arg('db', 'candles.db');
const H1 = 3600_000, SPAN = TF === '1h' ? H1 : 4 * H1;

function emaSeries(v, p) { if (!v.length) return []; const k = 2 / (p + 1); const o = [v[0]];
  for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o; }
function trendAt(f, s, i, px) { const a = f[i], b = s[i]; if (a == null || b == null) return 'flat';
  const sep = ((a - b) / b) * 100;
  if (sep > 0.15 && px >= b) return 'up'; if (sep < -0.15 && px <= b) return 'down'; return 'flat'; }
function atrSeries(bars, p) {
  const out = new Array(bars.length).fill(null); let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const pc = i ? bars[i - 1].c : bars[i].o;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc));
    if (i === p - 1) { let s = 0; for (let j = 0; j <= i; j++) { const q = j ? bars[j - 1].c : bars[j].o;
        s += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - q), Math.abs(bars[j].l - q)); } prev = s / p; }
    else if (i >= p) prev = (prev * (p - 1) + tr) / p;
    out[i] = prev;
  } return out;
}
/** 15m → HTF. htfEnd[k] = индекс 15m-бара, на закрытии которого HTF-бар k стал известен. */
function aggregate(bars, span) {
  const htf = [], htfEnd = []; let cur = null, curKey = null, startIdx = 0;
  for (let i = 0; i < bars.length; i++) {
    const key = Math.floor(bars[i].t / span);
    if (key !== curKey) {
      if (cur) { htf.push(cur); htfEnd.push(i - 1); }
      curKey = key; startIdx = i;
      cur = { t: key * span, o: bars[i].o, h: bars[i].h, l: bars[i].l, c: bars[i].c };
    } else { cur.h = Math.max(cur.h, bars[i].h); cur.l = Math.min(cur.l, bars[i].l); cur.c = bars[i].c; }
  }
  if (cur) { htf.push(cur); htfEnd.push(bars.length - 1); }
  return { bars: htf, htfEnd };
}

const db = new Database(DB, { readonly: true });
const rows = db.prepare('SELECT coin,t,o,h,l,c FROM candles ORDER BY coin,t').all();
db.close();
const byCoin = new Map();
for (const r of rows) { let a = byCoin.get(r.coin); if (!a) byCoin.set(r.coin, (a = [])); a.push(r); }
const btc = byCoin.get('BTC') || [];
const btcAt = new Map(btc.map((b) => [b.t, b.c]));
const btcRegime = (t) => { const n = btcAt.get(t), p = btcAt.get(t - 24 * H1);
  return n == null || p == null ? null : n > p ? 'btc_up' : 'btc_down'; };

/** Исход сделки по 15m барам, first-touch, при неоднозначности бара — стоп. */
function simulate(bars, from, side, entry, stop, tgt) {
  for (let j = from; j <= Math.min(from + MAXH, bars.length - 1); j++) {
    const hitStop = side === 'LONG' ? bars[j].l <= stop : bars[j].h >= stop;
    const hitTgt  = side === 'LONG' ? bars[j].h >= tgt  : bars[j].l <= tgt;
    if (hitStop) return { r: -1, why: 'stop', held: j - from };
    if (hitTgt)  return { r: RR, why: 'target', held: j - from };
  }
  const k = Math.min(from + MAXH, bars.length - 1);
  const d = side === 'LONG' ? bars[k].c - entry : entry - bars[k].c;
  return { r: d / Math.abs(entry - stop), why: 'timeout', held: k - from };
}

/**
 * mode: 'rule'   — FVG + тренд + ретест (правило из треда)
 *       'notrend'— FVG + ретест, БЕЗ фильтра тренда
 *       'rand'   — случайный вход по тренду HTF, стоп той же ширины (что даёт САМА зона?)
 */
function run(mode, stopPool = null) {
  let rng = 7; const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const trades = [], widths = [];
  for (const [coin, bars] of byCoin) {
    if (bars.length < 400) continue;
    const { bars: H, htfEnd } = aggregate(bars, SPAN);
    if (H.length < 80) continue;
    const hc = H.map((b) => b.c);
    const fE = emaSeries(hc, 20), sE = emaSeries(hc, 50), hAtr = atrSeries(H, 14);

    let cooldownUntil = -1;
    for (let i = 52; i < H.length - 1; i++) {
      const bull = H[i - 2].h < H[i].l, bear = H[i - 2].l > H[i].h;
      if (!bull && !bear) continue;
      if (IMP > 0 && hAtr[i - 1] != null &&
          Math.abs(H[i - 1].c - H[i - 1].o) < IMP * hAtr[i - 1]) continue;   // «импульсная свеча»
      const side = bull ? 'LONG' : 'SHORT';
      if (mode !== 'notrend') {
        const t = trendAt(fE, sE, i, H[i].c);
        if (t !== (bull ? 'up' : 'down')) continue;                          // ← ПРАВИЛО 2
      }
      // bull: гэп [high[i-2], low[i]] — цена возвращается СВЕРХУ вниз к low[i]
      // bear: гэп [high[i], low[i-2]] — цена возвращается СНИЗУ вверх к high[i]
      const zTop = bull ? H[i].l : H[i].h;          // ближняя к цене граница (вход)
      const zBot = bull ? H[i - 2].h : H[i - 2].l;  // дальняя граница (стоп)
      const width = Math.abs(zTop - zBot);
      if (!(width > 0) || width / zTop < MINW / 100) continue;   // зона тоньше спреда неторгуема

      // ── ретест на 15m: ждём касания ближней границы ──
      const start = htfEnd[i] + 1, until = Math.min(htfEnd[Math.min(i + WAIT, H.length - 1)], bars.length - 1);
      if (start >= until) continue;
      const fillPx = bull ? zTop - PEN * width : zTop + PEN * width;
      let hit = -1;
      for (let j = start; j <= until; j++) {
        const touched = bull ? bars[j].l <= fillPx : bars[j].h >= fillPx;
        if (touched) { hit = j; break; }
      }
      if (hit < 0 || hit <= cooldownUntil) continue;

      let entry = fillPx, from = hit;
      if (CONFIRM) {                                                        // ← ПРАВИЛО 3
        let ok = -1;
        for (let j = hit; j <= Math.min(hit + 8, bars.length - 1); j++) {
          const dir = bull ? bars[j].c > bars[j].o : bars[j].c < bars[j].o;
          if (dir) { ok = j; break; }
        }
        if (ok < 0) continue;
        entry = bars[ok].c; from = ok + 1;
        if (from >= bars.length) continue;
      }
      const stop = zBot;                                                    // ← ПРАВИЛО 4
      if (bull ? entry <= stop : entry >= stop) continue;
      const risk = Math.abs(entry - stop);
      const tgt = bull ? entry + RR * risk : entry - RR * risk;

      let out;
      if (mode === 'rand') {                                                // тот же тренд, случайный бар
        if (rnd() > 0.5) continue;
        const rj = start + Math.floor(rnd() * Math.max(1, until - start));
        const re = bars[rj].c;
        const w = stopPool[(rnd() * stopPool.length) | 0];                  // ширина стопа из того же распределения
        const rs = bull ? re * (1 - w) : re * (1 + w);
        const rt = bull ? re * (1 + RR * w) : re * (1 - RR * w);
        out = simulate(bars, rj + 1, side, re, rs, rt);
        trades.push({ coin, t: bars[rj].t, side, ...out, rNet: out.r - (RT / 100) / w,
          regime: btcRegime(bars[rj].t) });
      } else {
        widths.push(risk / entry);
        out = simulate(bars, from, side, entry, stop, tgt);
        trades.push({ coin, t: bars[hit].t, side, w: risk / entry, ...out,
          rNet: out.r - (RT / 100) * entry / risk, regime: btcRegime(bars[hit].t) });
      }
      cooldownUntil = hit + 8;
    }
  }
  return { trades, widths };
}

function stats(tr, key = 'rNet') {
  const n = tr.length; if (!n) return { n: 0 };
  const rs = tr.map((x) => x[key]);
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const wr = rs.filter((x) => x > 0).length / n;
  return { n, mean, ciLo: mean - 1.96 * se, ciHi: mean + 1.96 * se, wr, sum: mean * n };
}
const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
function line(label, s) {
  if (!s.n) return console.log(`${label.padEnd(28)} n=0`);
  console.log(`${label.padEnd(28)} n=${String(s.n).padStart(6)}  E[R]=${f(s.mean).padStart(7)}  ` +
    `CI95[${f(s.ciLo)}, ${f(s.ciHi)}]  WR=${(s.wr * 100).toFixed(1)}%  сумма=${f(s.sum, 1)}R`);
}

const tMin = rows.reduce((m, r) => Math.min(m, r.t), Infinity);
const tMax = rows.reduce((m, r) => Math.max(m, r.t), -Infinity);
console.log(`[данные] ${rows.length} свечей 15m · ${byCoin.size} монет · ` +
  `${new Date(tMin).toISOString().slice(0, 10)} → ${new Date(tMax).toISOString().slice(0, 10)}`);
console.log(`[параметры] зоны на ${TF} · цель=${RR}R · ждём ретест ${WAIT} баров ${TF} · ` +
  `мин.ширина зоны=${MINW}% · таймаут=${MAXH}×15m · подтверждение=${CONFIRM ? 'да' : 'нет'} · импульс=${IMP || 'не требуем'} · ` +
  `издержки=${RT}% RT\n`);

const { trades: rule, widths } = run('rule');
const wSorted = [...widths].sort((a, b) => a - b);
const { trades: notrend } = run('notrend');
const { trades: rand } = run('rand', wSorted.length ? wSorted : [0.01]);

console.log('═══ 1. ПРАВИЛО ПРОТИВ БЕЙЗЛАЙНОВ (после издержек) ═══');
line('правило (FVG+тренд+ретест)', stats(rule));
line('FVG без фильтра тренда', stats(notrend));
line('случайный вход, тот же стоп', stats(rand));
console.log(`\nразница с «без тренда»:  ${f(stats(rule).mean - stats(notrend).mean)} R`);
console.log(`разница со случайным:    ${f(stats(rule).mean - stats(rand).mean)} R`);
if (wSorted.length) console.log(`медианная ширина зоны:   ${(wSorted[Math.floor(wSorted.length / 2)] * 100).toFixed(2)}% ` +
  `⇒ издержки = ${f((RT / 100) / wSorted[Math.floor(wSorted.length / 2)], 2)}R на сделку\n`);

console.log('═══ 2. БЕЗ ИЗДЕРЖЕК ═══');
line('правило, gross', stats(rule, 'r'));
line('случайный, gross', stats(rand, 'r'));

console.log('\n═══ 3. OOS-СПЛИТ ═══');
const mid = (tMin + tMax) / 2;
line('правило · 1-я половина', stats(rule.filter((t) => t.t < mid)));
line('правило · 2-я половина', stats(rule.filter((t) => t.t >= mid)));

console.log('\n═══ 4. ЭДЖ ИЛИ БЕТА? ═══');
for (const rg of ['btc_up', 'btc_down']) for (const sd of ['LONG', 'SHORT'])
  line(`  ${sd} · ${rg}`, stats(rule.filter((t) => t.regime === rg && t.side === sd)));

console.log('\n═══ 4b. ПО МЕСЯЦАМ ═══');
{
  const mon = (t) => new Date(t).toISOString().slice(0, 7);
  for (const m of [...new Set(rule.map((t) => mon(t.t)))].sort())
    line(`  правило · ${m}`, stats(rule.filter((t) => mon(t.t) === m)));
}

console.log('\n═══ 4c. ПО ШИРИНЕ ЗОНЫ (издержки в R = 0.1%/ширина) ═══');
{
  const ws = rule.filter((t) => t.w != null).map((t) => t.w).sort((a, b) => a - b);
  const q = [0, 0.25, 0.5, 0.75, 1].map((x) => ws[Math.min(ws.length - 1, Math.floor(x * ws.length))]);
  for (let k = 0; k < 4; k++) {
    const sel = rule.filter((t) => t.w >= q[k] && (k === 3 ? true : t.w < q[k + 1]));
    line(`  ширина ${(q[k]*100).toFixed(2)}–${(q[k+1]*100).toFixed(2)}%`, stats(sel));
  }
}

console.log('\n═══ 5. КАК ЗАКРЫВАЛИСЬ ═══');
for (const w of ['target', 'stop', 'timeout']) {
  const s = stats(rule.filter((t) => t.why === w));
  if (s.n) console.log(`  ${w.padEnd(8)} ${(s.n / rule.length * 100).toFixed(1)}% · E[R]=${f(s.mean)}`);
}

if (process.argv.includes('--boot')) {
  const byDay = new Map();
  for (const t of rule) { const d = Math.floor(t.t / 86400_000); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(t); }
  const days = [...byDay.keys()], B = 2000, means = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0;
    for (let i = 0; i < days.length; i++) { const d = days[(Math.random() * days.length) | 0];
      for (const tr of byDay.get(d)) { s += tr.rNet; n++; } }
    means.push(s / n); }
  means.sort((a, b) => a - b);
  console.log(`\n═══ 6. КЛАСТЕРНЫЙ БУТСТРАП ПО ДНЯМ (${days.length} дней, B=${B}) ═══`);
  console.log(`E[R] = ${f(stats(rule).mean)}   CI95 = [${f(means[50])}, ${f(means[1949])}]`);
  console.log(`доля выборок с E>0: ${(means.filter((m) => m > 0).length / B * 100).toFixed(1)}%`);

  // главный вопрос не «E>0», а «правило лучше случайного входа?» — ресемплим ДНИ
  // целиком и в каждой выборке считаем разницу правило−случайный на одних днях
  const randByDay = new Map();
  for (const t of rand) { const d = Math.floor(t.t / 86400_000);
    if (!randByDay.has(d)) randByDay.set(d, []); randByDay.get(d).push(t); }
  const both = days.filter((d) => randByDay.has(d));
  const diffs = [];
  for (let b = 0; b < B; b++) {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let i = 0; i < both.length; i++) {
      const d = both[(Math.random() * both.length) | 0];
      for (const t of byDay.get(d)) { sa += t.rNet; na++; }
      for (const t of randByDay.get(d)) { sb += t.rNet; nb++; }
    }
    if (na && nb) diffs.push(sa / na - sb / nb);
  }
  diffs.sort((a, b) => a - b);
  const D = diffs.length;
  console.log(`\nразница правило−случайный: ${f(stats(rule).mean - stats(rand).mean)}R  ` +
    `CI95 = [${f(diffs[Math.floor(D * 0.025)])}, ${f(diffs[Math.floor(D * 0.975)])}]  ` +
    `доля выборок с разницей>0: ${(diffs.filter((x) => x > 0).length / D * 100).toFixed(1)}%`);
}
