// ─────────────────────────────────────────────────────────────────────────────
//  «LuxAlgo Trendlines with Breaks + TRAMA + RSI» — правило из треда.
//
//  LONG:  подтверждённый пробой нисходящей трендлинии вверх, цена выше TRAMA(99).
//         Выход — когда RSI(14) заходит выше 70 (как в описании).
//  SHORT: зеркально, выход когда RSI < 30.
//
//  Трендлинии считаются БЕЗ repaint: пивот подтверждается через `length` баров,
//  линия от пивота идёт с наклоном ATR(length)/length*mult — ровно как рисует
//  индикатор, но сигнал берётся только там, где он был доступен в реальном
//  времени.
//
//  Меряем не «сколько заработало», а разницу с бейзлайнами на тех же барах.
//
//  Запуск: node scripts/backtestLuxTrendline.js [--rt 0.10] [--len 14]
//          [--mult 1] [--trama 99] [--maxh 96] [--stop 0] [--boot]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const RT    = parseFloat(arg('rt', '0.10'));      // round-trip издержки, %
const LEN   = parseInt(arg('len', '14'), 10);     // length трендлиний
const MULT  = parseFloat(arg('mult', '1'));       // наклон × mult
const TRAMA = parseInt(arg('trama', '99'), 10);
const MAXH  = parseInt(arg('maxh', '96'), 10);    // таймаут, 15m баров (24ч)
const STOPP = parseFloat(arg('stop', '0'));       // стоп, % (0 = как в правиле — без стопа)
const H1 = 3600_000;

// ── индикаторы ──
function atrSeries(bars, p) {
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const pc = i ? bars[i - 1].c : bars[i].o;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc));
    if (i === p - 1) { let s = 0; for (let j = 0; j <= i; j++) { const q = j ? bars[j - 1].c : bars[j].o;
        s += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - q), Math.abs(bars[j].l - q)); }
      prev = s / p; }
    else if (i >= p) prev = (prev * (p - 1) + tr) / p;
    out[i] = prev;
  }
  return out;
}
/** RSI Wilder. */
function rsiSeries(c, p) {
  const out = new Array(c.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= p) { ag += g / p; al += l / p; if (i === p) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return out;
}
/** TRAMA [LuxAlgo]: адаптивная MA, скорость = (доля баров с новым экстремумом)². */
function tramaSeries(bars, len) {
  const n = bars.length, out = new Array(n).fill(null);
  const flags = new Array(n).fill(0);
  let prevHH = null, prevLL = null;
  for (let i = 0; i < n; i++) {
    if (i < len - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - len + 1; j <= i; j++) { if (bars[j].h > hh) hh = bars[j].h; if (bars[j].l < ll) ll = bars[j].l; }
    if (prevHH != null) flags[i] = (hh > prevHH || ll < prevLL) ? 1 : 0;
    prevHH = hh; prevLL = ll;
  }
  let ama = null, run = 0;
  for (let i = 0; i < n; i++) {
    run += flags[i];
    if (i >= len) run -= flags[i - len];
    if (i < 2 * len) { ama = bars[i].c; out[i] = null; continue; }
    const tc = Math.pow(run / len, 2);
    ama = ama + tc * (bars[i].c - ama);
    out[i] = ama;
  }
  return out;
}
/**
 * Трендлинии с пробоями, без repaint.
 * Возвращает upper[i]/lower[i] — значение линии, ИЗВЕСТНОЕ на закрытии бара i.
 */
function trendlines(bars, len, mult) {
  const n = bars.length;
  const atr = atrSeries(bars, len);
  const upper = new Array(n).fill(null), lower = new Array(n).fill(null);
  let upAnchor = null, upSlope = 0, upFrom = 0;   // нисходящая линия от pivot high
  let dnAnchor = null, dnSlope = 0, dnFrom = 0;   // восходящая от pivot low
  for (let i = 0; i < n; i++) {
    // пивот на баре p = i-len подтверждается только сейчас (len баров справа)
    const p = i - len;
    if (p >= len) {
      let isPH = true, isPL = true;
      for (let j = p - len; j <= p + len; j++) {
        if (j === p) continue;
        if (bars[j].h >= bars[p].h) isPH = false;
        if (bars[j].l <= bars[p].l) isPL = false;
      }
      const s = (atr[p] ?? 0) / len * mult;
      if (isPH) { upAnchor = bars[p].h; upSlope = s; upFrom = p; }
      if (isPL) { dnAnchor = bars[p].l; dnSlope = s; dnFrom = p; }
    }
    if (upAnchor != null) upper[i] = upAnchor - upSlope * (i - upFrom);
    if (dnAnchor != null) lower[i] = dnAnchor + dnSlope * (i - dnFrom);
  }
  return { upper, lower };
}

// ── загрузка ──
const db = new Database(arg('db', 'candles.db'), { readonly: true });
const rows = db.prepare('SELECT coin,t,o,h,l,c FROM candles ORDER BY coin,t').all();
db.close();
const byCoin = new Map();
for (const r of rows) { let a = byCoin.get(r.coin); if (!a) byCoin.set(r.coin, (a = [])); a.push(r); }

const btc = byCoin.get('BTC') || [];
const btcAt = new Map(btc.map((b) => [b.t, b.c]));
const btcRegime = (t) => {
  const now = btcAt.get(t), then = btcAt.get(t - 24 * H1);
  if (now == null || then == null) return null;
  return now > then ? 'btc_up' : 'btc_down';
};

/**
 * mode: 'rule'   — пробой + TRAMA-фильтр (правило оператора)
 *       'nofilt' — тот же пробой, БЕЗ TRAMA (что даёт фильтр?)
 *       'rand'   — случайный бар, тот же выход по RSI (что даёт СИГНАЛ?)
 */
function run(mode, seed = 1) {
  let rng = seed;
  const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const trades = [];
  for (const [coin, bars] of byCoin) {
    if (bars.length < 400) continue;
    const c = bars.map((b) => b.c);
    const rsi = rsiSeries(c, 14);
    const tr = tramaSeries(bars, TRAMA);
    const { upper, lower } = trendlines(bars, LEN, MULT);

    let armedUp = false, armedDn = false, cooldownUntil = -1;
    for (let i = 2 * TRAMA + 1; i < bars.length - 1; i++) {
      const px = c[i];
      if (upper[i] == null || lower[i] == null || tr[i] == null || rsi[i] == null) continue;
      // пробой = первое закрытие выше/ниже линии с момента её установки
      const brUp = px > upper[i] && !armedUp, brDn = px < lower[i] && !armedDn;
      armedUp = px > upper[i]; armedDn = px < lower[i];
      if (i <= cooldownUntil) continue;

      let side = null;
      if (mode === 'rand') {
        if (rnd() > 0.01) continue;                     // ~1% баров, сопоставимо по n
        side = rnd() < 0.5 ? 'LONG' : 'SHORT';
      } else {
        if (brUp) side = 'LONG'; else if (brDn) side = 'SHORT'; else continue;
        if (mode === 'rule') {                          // ← ФИЛЬТР TRAMA
          if (side === 'LONG' && !(px > tr[i])) continue;
          if (side === 'SHORT' && !(px < tr[i])) continue;
        }
      }
      // вход по close сигнального бара, выход по RSI-порогу / стопу / таймауту
      const entry = px;
      const stop = STOPP > 0 ? (side === 'LONG' ? entry * (1 - STOPP / 100) : entry * (1 + STOPP / 100)) : null;
      let exit = null, why = 'timeout', barsHeld = 0;
      for (let j = i + 1; j <= Math.min(i + MAXH, bars.length - 1); j++) {
        barsHeld = j - i;
        if (stop != null && (side === 'LONG' ? bars[j].l <= stop : bars[j].h >= stop)) { exit = stop; why = 'stop'; break; }
        const rv = rsi[j];
        if (rv != null && (side === 'LONG' ? rv > 70 : rv < 30)) { exit = c[j]; why = 'rsi'; break; }
      }
      if (exit == null) exit = c[Math.min(i + MAXH, bars.length - 1)];
      const gross = ((side === 'LONG' ? exit - entry : entry - exit) / entry) * 100;
      trades.push({ coin, t: bars[i].t, side, why, bars: barsHeld,
        pnl: gross, net: gross - RT, regime: btcRegime(bars[i].t) });
      cooldownUntil = i + 8;
    }
  }
  return trades;
}

// ── статистика ──
function stats(tr, key = 'net') {
  const n = tr.length; if (!n) return { n: 0 };
  const rs = tr.map((x) => x[key]);
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const wr = rs.filter((x) => x > 0).length / n;
  const win = rs.filter((x) => x > 0), los = rs.filter((x) => x <= 0);
  const avgW = win.length ? win.reduce((a, b) => a + b, 0) / win.length : 0;
  const avgL = los.length ? los.reduce((a, b) => a + b, 0) / los.length : 0;
  return { n, mean, ciLo: mean - 1.96 * se, ciHi: mean + 1.96 * se, wr, avgW, avgL, sum: mean * n };
}
const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
function line(label, s) {
  if (!s.n) return console.log(`${label.padEnd(28)} n=0`);
  console.log(`${label.padEnd(28)} n=${String(s.n).padStart(6)}  E[%]=${f(s.mean).padStart(7)}  ` +
    `CI95[${f(s.ciLo)}, ${f(s.ciHi)}]  WR=${(s.wr * 100).toFixed(1)}%  ` +
    `ср.плюс=${f(s.avgW, 2)}%  ср.минус=${f(s.avgL, 2)}%`);
}

const tMin = rows.reduce((m, r) => Math.min(m, r.t), Infinity);
const tMax = rows.reduce((m, r) => Math.max(m, r.t), -Infinity);
console.log(`[данные] ${rows.length} свечей · ${byCoin.size} монет · ` +
  `${new Date(tMin).toISOString().slice(0, 10)} → ${new Date(tMax).toISOString().slice(0, 10)}`);
console.log(`[параметры] trendline len=${LEN} mult=${MULT} · TRAMA=${TRAMA} · RSI 14 (70/30) · ` +
  `таймаут=${MAXH}бар · стоп=${STOPP || 'нет'} · издержки=${RT}% RT\n`);

const rule = run('rule'), nofilt = run('nofilt'), rand = run('rand');

console.log('═══ 1. ПРАВИЛО ПРОТИВ БЕЙЗЛАЙНОВ (после издержек) ═══');
line('правило (пробой+TRAMA+RSI)', stats(rule));
line('пробой без TRAMA', stats(nofilt));
line('случайный вход, тот же выход', stats(rand));
console.log(`\nразница с «без фильтра»: ${f(stats(rule).mean - stats(nofilt).mean)} пп`);
console.log(`разница со случайным:    ${f(stats(rule).mean - stats(rand).mean)} пп\n`);

console.log('═══ 2. БЕЗ ИЗДЕРЖЕК ═══');
line('правило, gross', stats(rule, 'pnl'));
line('случайный, gross', stats(rand, 'pnl'));

console.log('\n═══ 3. OOS-СПЛИТ ═══');
const mid = (tMin + tMax) / 2;
line('правило · 1-я половина', stats(rule.filter((t) => t.t < mid)));
line('правило · 2-я половина', stats(rule.filter((t) => t.t >= mid)));

console.log('\n═══ 4. ЭДЖ ИЛИ БЕТА? (режим BTC × сторона) ═══');
for (const rg of ['btc_up', 'btc_down']) for (const sd of ['LONG', 'SHORT'])
  line(`  ${sd} · ${rg}`, stats(rule.filter((t) => t.regime === rg && t.side === sd)));

console.log('\n═══ 4b. ПО МЕСЯЦАМ (стабильность во времени) ═══');
{
  const mon = (t) => new Date(t).toISOString().slice(0, 7);
  const ms = [...new Set(rule.map((t) => mon(t.t)))].sort();
  for (const m of ms) {
    line(`  правило · ${m}`, stats(rule.filter((t) => mon(t.t) === m)));
    line(`  случайный · ${m}`, stats(rand.filter((t) => mon(t.t) === m)));
  }
}

console.log('\n═══ 5. КАК ЗАКРЫВАЛИСЬ ═══');
for (const w of ['rsi', 'stop', 'timeout']) {
  const s = stats(rule.filter((t) => t.why === w));
  if (s.n) console.log(`  ${w.padEnd(8)} ${(s.n / rule.length * 100).toFixed(1)}% сделок · E[%]=${f(s.mean)} · ` +
    `медиана удержания ${(rule.filter((t) => t.why === w).map((t) => t.bars).sort((a, b) => a - b)[Math.floor(s.n / 2)] * 15 / 60).toFixed(1)}ч`);
}

if (process.argv.includes('--boot')) {
  const dayOf = (t) => Math.floor(t / 86400_000);
  const byDay = new Map();
  for (const t of rule) { const d = dayOf(t.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(t); }
  const days = [...byDay.keys()], B = 2000, means = [];
  for (let b = 0; b < B; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < days.length; i++) { const d = days[(Math.random() * days.length) | 0];
      for (const tr of byDay.get(d)) { sum += tr.net; n++; } }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  console.log(`\n═══ 6. КЛАСТЕРНЫЙ БУТСТРАП ПО ДНЯМ (${days.length} дней, B=${B}) ═══`);
  console.log(`E[%] = ${f(stats(rule).mean)}   CI95 кластерный = [${f(means[50])}, ${f(means[1949])}]`);
  console.log(`доля выборок с E>0: ${(means.filter((m) => m > 0).length / B * 100).toFixed(1)}%`);
}
