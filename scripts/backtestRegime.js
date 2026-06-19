// ─────────────────────────────────────────────────────────────────────────────
//  Регимо-зависимый exhaustion-тест на 52 днях 15m OHLC (candles.db).
//
//  Детектор режима = Kaufman Efficiency Ratio (ER) на erWin барах:
//    ER = |close[i]-close[i-W]| / Σ|close[k]-close[k-1]|   (0=чоп … 1=тренд)
//
//  Гипотеза: на резком ходе (|move|≥T за 30м) fade выгоден в ЧОПЕ (низкий ER),
//  а follow — в ТРЕНДЕ (высокий ER). Сначала смотрим эффект по ТЕРЦИЛЯМ ER (без
//  подгонки порогов), потом собираем комбо (fade в низком / follow в высоком) и
//  гоняем OOS-split по 5 отрезкам.
//
//  Запуск: node scripts/backtestRegime.js [--erWin 16] [--moveLb 2] [--rt 0.10]
//          [--tgt 1.5] [--stop 1.5] [--chunks 5] [--cooldownBars 2]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const ER_W = parseInt(arg('erWin', '16'), 10); // окно ER в барах (16=4ч)
const MOVE_LB = parseInt(arg('moveLb', '2'), 10); // окно «хода» в барах (2=30м)
const RT = parseFloat(arg('rt', '0.10'));
const TGT = parseFloat(arg('tgt', '1.5'));
const STOP = parseFloat(arg('stop', '1.5'));
const CHUNKS = parseInt(arg('chunks', '5'), 10);
const COOLDOWN = parseInt(arg('cooldownBars', '2'), 10);
const THRESHOLDS = [3, 5];
const HOR = [4, 8]; // 60/120м

const db = new Database('candles.db', { readonly: true });
const all = db.prepare('SELECT coin,t,o,h,l,c FROM candles ORDER BY coin,t').all();
db.close();
const byCoin = new Map();
for (const r of all) {
  let a = byCoin.get(r.coin);
  if (!a) byCoin.set(r.coin, (a = []));
  a.push(r);
}
const tMin = all.reduce((m, r) => Math.min(m, r.t), Infinity);
const tMax = all.reduce((m, r) => Math.max(m, r.t), -Infinity);

const signedClose = (side, e, c) => (side === 'LONG' ? ((c - e) / e) * 100 : ((e - c) / e) * 100);

function efficiencyRatio(bars, i) {
  if (i < ER_W) return null;
  const net = Math.abs(bars[i].c - bars[i - ER_W].c);
  let vol = 0;
  for (let k = i - ER_W + 1; k <= i; k++) vol += Math.abs(bars[k].c - bars[k - 1].c);
  return vol > 0 ? net / vol : null;
}

// исход сделки заданной стороны от бара i (first-touch по high/low; стоп при двойном)
function outcome(bars, i, side, entry) {
  const ret = {};
  for (const h of HOR) ret[h] = bars[i + h] ? signedClose(side, entry, bars[i + h].c) : null;
  const tgtPx = side === 'SHORT' ? entry * (1 - TGT / 100) : entry * (1 + TGT / 100);
  const stpPx = side === 'SHORT' ? entry * (1 + STOP / 100) : entry * (1 - STOP / 100);
  let touch = null;
  for (let k = i + 1; k <= i + HOR[HOR.length - 1] && k < bars.length; k++) {
    const b = bars[k];
    const hitStop = side === 'SHORT' ? b.h >= stpPx : b.l <= stpPx;
    const hitTgt = side === 'SHORT' ? b.l <= tgtPx : b.h >= tgtPx;
    if (hitStop) { touch = 'stop'; break; }
    if (hitTgt) { touch = 'tgt'; break; }
  }
  return { ret, touch };
}

// все события «резкого хода» с ER и исходами для FADE и FOLLOW
const events = [];
const startI = Math.max(ER_W, MOVE_LB);
for (const bars of byCoin.values()) {
  let last = new Map();
  for (let i = startI; i < bars.length - 1; i++) {
    const move = ((bars[i].c - bars[i - MOVE_LB].c) / bars[i - MOVE_LB].c) * 100;
    if (Math.abs(move) < THRESHOLDS[0]) continue;
    const dir = move > 0 ? 'up' : 'down';
    if (last.has(dir) && i - last.get(dir) < COOLDOWN) continue;
    last.set(dir, i);
    const er = efficiencyRatio(bars, i);
    if (er == null) continue;
    const entry = bars[i].c;
    const fadeSide = move > 0 ? 'SHORT' : 'LONG';
    const followSide = move > 0 ? 'LONG' : 'SHORT';
    events.push({
      t: bars[i].t,
      absMove: Math.abs(move),
      er,
      fade: outcome(bars, i, fadeSide, entry),
      follow: outcome(bars, i, followSide, entry),
    });
  }
}

const pct = (x) => (x == null ? '  — ' : `${(x * 100).toFixed(0)}%`.padStart(4));
const ret = (x) => (x == null ? '   —   ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7));
function stat(list, pick) {
  const r = list.map((e) => pick(e).ret[8]).filter((x) => x != null).map((x) => x - RT);
  const ft = list.map((e) => pick(e).touch).filter((x) => x != null);
  return {
    n: list.length,
    mean120: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null,
    win120: r.length ? r.filter((x) => x > 0).length / r.length : null,
    touch: ft.length ? ft.filter((x) => x === 'tgt').length / ft.length : null,
    touchN: ft.length,
  };
}
function line(label, list, pick) {
  if (list.length < 5) return console.log(`${label.padEnd(24)} n=${String(list.length).padStart(4)} (мало)`);
  const s = stat(list, pick);
  console.log(
    `${label.padEnd(24)} n=${String(s.n).padStart(4)}  120m ${ret(s.mean120)}/${pct(s.win120)}  ` +
      `│ touch ±${TGT}: ${pct(s.touch)} (n=${s.touchN})`,
  );
}
const quantile = (sorted, q) => sorted[Math.floor(sorted.length * q)];

console.log(
  `\n═══ Регимо-тест · ER окно ${ER_W * 15}m · ход ${MOVE_LB * 15}m · RT=${RT}% · ±${TGT}/${STOP}% ═══`,
);
console.log(`52 дня · ${byCoin.size} монет · ${events.length} событий хода ≥${THRESHOLDS[0]}%\n`);

for (const T of THRESHOLDS) {
  const ev = events.filter((e) => e.absMove >= T);
  if (ev.length < 30) continue;
  const ers = ev.map((e) => e.er).sort((a, b) => a - b);
  const p33 = quantile(ers, 1 / 3);
  const p66 = quantile(ers, 2 / 3);
  console.log(`──────── |ход| ≥ ${T}%  (ER p33=${p33.toFixed(2)} p66=${p66.toFixed(2)}) ────────`);
  const low = ev.filter((e) => e.er <= p33);
  const mid = ev.filter((e) => e.er > p33 && e.er < p66);
  const high = ev.filter((e) => e.er >= p66);
  console.log('  FADE по терцилям ER (ждём: низкий ER лучше):');
  line('   ER низкий (чоп)', low, (e) => e.fade);
  line('   ER средний', mid, (e) => e.fade);
  line('   ER высокий (тренд)', high, (e) => e.fade);
  console.log('  FOLLOW в высоком ER (ждём: тренд лучше):');
  line('   ER высокий FOLLOW', high, (e) => e.follow);
  console.log('');
}

// ── Стратегия (исправленная): FADE когда ER высокий (≥p66) · OOS 5-split ─────
console.log('══ FADE при высоком ER (≥p66) · OOS 5-split ══');
for (const T of THRESHOLDS) {
  const ev = events.filter((e) => e.absMove >= T);
  if (ev.length < 30) continue;
  const ers = ev.map((e) => e.er).sort((a, b) => a - b);
  const p66 = quantile(ers, 2 / 3);
  const trades = ev.filter((e) => e.er >= p66).map((e) => ({ t: e.t, o: e.fade }));
  console.log(`── |ход| ≥ ${T}% ──`);
  line('  ВСЁ (52д)', trades, (x) => x.o);
  const span = tMax - tMin;
  const dstr = (t) => new Date(t).toISOString().slice(5, 10);
  for (let ch = 0; ch < CHUNKS; ch++) {
    const lo = tMin + (span / CHUNKS) * ch;
    const hi = tMin + (span / CHUNKS) * (ch + 1);
    line(`  [${dstr(lo)}→${dstr(hi)}]`, trades.filter((x) => x.t >= lo && x.t < hi), (x) => x.o);
  }
  console.log('');
}
