// ─────────────────────────────────────────────────────────────────────────────
//  oiEntry — есть ли вход в квадрантах «цена × открытый интерес»
//
//  ПРЕДЗАЯВКА (08.09.2026, до первого прогона):
//
//  ЗАЧЕМ ИМЕННО ЭТИ ДАННЫЕ. Исторического эндпоинта OI у HL нет: всё, чего нет
//  в нашем коллекторе, потеряно навсегда. Это единственный набор, которого нет
//  у Coinglass и TradingView в нашем разрезе, и единственное место, где ещё не
//  искали. Цену перемололи все.
//
//  ГИПОТЕЗА. Квадрант «ход цены × изменение OI» за час несёт направленный эдж
//  после издержек. Это тот самый классификатор, который витрина Hot Movers
//  показывает как Setup, но форвардом он никогда не мерился.
//
//    цена↑ OI↑ = новые лонги      → продолжение, LONG
//    цена↓ OI↑ = новые шорты      → продолжение, SHORT
//    цена↑ OI↓ = крытие шортов    → выдох, фейд в SHORT
//    цена↓ OI↓ = разгрузка лонгов → выдох, фейд в LONG
//
//  СЕМЕЙСТВО. 4 квадранта × 3 горизонта (1ч/4ч/24ч) = 12 ячеек. Поправка
//  Benjamini-Hochberg FDR 10%: при 12 проверках одна «работает» случайно с
//  вероятностью ~46%.
//
//  ПРАВИЛО РЕШЕНИЯ. Ячейка принимается, только если среднее net > 0, её
//  p переживает BH-FDR И знак сохраняется на обеих половинах окна. Метрика без
//  CI в вывод не идёт; CI кластерный по монетам.
//
//  МЕХАНИКА, заморожена до прогона:
//    · пороги: |ход цены за 1ч| ≥ 1.5%, |Δ OI за 1ч| ≥ 3%;
//    · вход по цене СЛЕДУЮЩЕГО снимка после условия — не по той же, на которой
//      условие увидели;
//    · повторный вход по монете запрещён, пока условие не разомкнулось: иначе
//      один эпизод даёт десятки почти одинаковых наблюдений и раздувает n;
//    · издержки 9 бп на круг (тейкер обеими ногами).
//
//  БЕЙЗЛАЙН. Случайный вход по тем же монетам и на ТОТ ЖЕ горизонт. 🚨 Горизонт
//  обязан совпадать: случайная сделка на 24ч и на 1ч — разные числа.
//
//  ОГРАНИЧЕНИЯ: окно ~2 месяца, один рынок (HL), состав монет сегодняшний.
//  Вывод «эджа нет» переносится дальше, чем вывод «эдж есть».
//
//  Запуск: node tools/oiEntry.mjs <каталог с oi-*.jsonl>
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'node:fs';

const DIR = process.argv[2];
if (!DIR) { console.error('нужен каталог с oi-*.jsonl'); process.exit(1); }

const P = Object.freeze({
  LB_MIN: 60,          // окно условия, мин
  MOVE_THR: 1.5,       // |ход цены| за окно, %
  OI_THR: 3,           // |Δ OI| за окно, %
  HORIZONS_MIN: [60, 240, 1440],
  FEE_BP: 9,
  BOOT: 2000,
  FDR_Q: 0.10,
});

// ── Чтение снимков ──────────────────────────────────────────────────────────
// series: coin → [{t, px, oi}] по возрастанию времени. Снимки раз в 15 минут.
const series = new Map();
const stamps = [];
for (const f of readdirSync(DIR).filter((x) => /^oi-.*\.jsonl$/.test(x)).sort()) {
  for (const line of readFileSync(`${DIR}/${f}`, 'utf8').split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row?.t || !row.d) continue;
    stamps.push(row.t);
    for (const [coin, v] of Object.entries(row.d)) {
      const px = Number(v?.px), oi = Number(v?.oi);
      if (!(px > 0) || !(oi > 0)) continue;
      if (!series.has(coin)) series.set(coin, []);
      series.get(coin).push({ t: row.t, px, oi });
    }
  }
}
for (const [c, a] of series) { a.sort((x, y) => x.t - y.t); if (a.length < 500) series.delete(c); }
const t0 = Math.min(...stamps), t1 = Math.max(...stamps);
console.log(`монет ${series.size} | снимков ${stamps.length} | окно ${((t1 - t0) / 86400000).toFixed(0)} суток\n`);

const STEP_MS = 15 * 60_000;
const idxBack = (min) => Math.round((min * 60_000) / STEP_MS);

// ── Сделки квадранта ────────────────────────────────────────────────────────
const QUADRANTS = {
  'цена↑ OI↑ → LONG':  { up: true,  oiUp: true,  side: 1 },
  'цена↓ OI↑ → SHORT': { up: false, oiUp: true,  side: -1 },
  'цена↑ OI↓ → SHORT': { up: true,  oiUp: false, side: -1 },
  'цена↓ OI↓ → LONG':  { up: false, oiUp: false, side: 1 },
};

function trades(qname, horizonMin) {
  const q = QUADRANTS[qname];
  const lb = idxBack(P.LB_MIN);
  const fw = idxBack(horizonMin);
  const fee = P.FEE_BP / 10_000;
  const out = [];
  for (const [coin, a] of series) {
    let armed = true;
    for (let i = lb; i + 1 + fw < a.length; i++) {
      const move = ((a[i].px - a[i - lb].px) / a[i - lb].px) * 100;
      const doi = ((a[i].oi - a[i - lb].oi) / a[i - lb].oi) * 100;
      const hit =
        Math.abs(move) >= P.MOVE_THR && Math.abs(doi) >= P.OI_THR &&
        (move > 0) === q.up && (doi > 0) === q.oiUp;
      if (!hit) { armed = true; continue; }
      if (!armed) continue;
      armed = false;
      const entry = a[i + 1].px;
      const exit = a[i + 1 + fw].px;
      const raw = (q.side * (exit - entry)) / entry;
      out.push({ coin, ret: raw - fee, t: a[i].t });
    }
  }
  return out;
}

function randomBaseline(horizonMin, side, n) {
  const fw = idxBack(horizonMin);
  const fee = P.FEE_BP / 10_000;
  const coins = [...series.keys()];
  let seed = 20260908;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  while (out.length < n) {
    const coin = coins[Math.floor(rnd() * coins.length)];
    const a = series.get(coin);
    const i = Math.floor(rnd() * (a.length - fw - 2));
    const entry = a[i + 1].px, exit = a[i + 1 + fw].px;
    out.push({ coin, ret: (side * (exit - entry)) / entry - fee });
  }
  return out;
}

function clustered(tr) {
  const by = new Map();
  for (const t of tr) { if (!by.has(t.coin)) by.set(t.coin, []); by.get(t.coin).push(t.ret); }
  const cl = [...by.values()];
  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const means = [];
  for (let b = 0; b < P.BOOT; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < cl.length; i++) { const c = cl[Math.floor(rnd() * cl.length)]; for (const v of c) { s += v; n++; } }
    if (n) means.push(s / n);
  }
  means.sort((x, y) => x - y);
  const mean = tr.reduce((x, y) => x + y.ret, 0) / tr.length;
  return { mean, lo: means[Math.floor(P.BOOT * 0.025)], hi: means[Math.floor(P.BOOT * 0.975)], p: means.filter((m) => m <= 0).length / means.length };
}

const bp = (x) => (x * 10_000).toFixed(1);
const tMid = (t0 + t1) / 2;
const cells = [];
for (const H of P.HORIZONS_MIN) {
  for (const qname of Object.keys(QUADRANTS)) {
    const tr = trades(qname, H);
    if (tr.length < 50) continue;
    const st = clustered(tr);
    const h1 = tr.filter((x) => x.t < tMid), h2 = tr.filter((x) => x.t >= tMid);
    const m = (a) => (a.length ? a.reduce((x, y) => x + y.ret, 0) / a.length : NaN);
    cells.push({ qname, H, n: tr.length, ...st, half1: m(h1), half2: m(h2) });
  }
}
const sorted = [...cells].sort((a, b) => a.p - b.p);
let kMax = 0;
sorted.forEach((c, i) => { if (c.p <= ((i + 1) / sorted.length) * P.FDR_Q) kMax = i + 1; });
const pass = new Set(sorted.slice(0, kMax).map((c) => `${c.qname}|${c.H}`));

console.table(cells.map((c) => ({
  квадрант: c.qname, 'гор.': `${c.H / 60}ч`, n: c.n,
  'ср, бп': bp(c.mean), CI95: `[${bp(c.lo)}, ${bp(c.hi)}]`, p: c.p.toFixed(3),
  '1-я пол.': bp(c.half1), '2-я пол.': bp(c.half2),
  вердикт: pass.has(`${c.qname}|${c.H}`) && c.mean > 0 && c.half1 > 0 && c.half2 > 0 ? 'ПРОШЛА' : '—',
})));

console.log('\n── бейзлайн: случайный вход, горизонт как у ячейки ──');
console.table(P.HORIZONS_MIN.flatMap((H) => [1, -1].map((side) => {
  const st = clustered(randomBaseline(H, side, 4000));
  return { 'гор.': `${H / 60}ч`, сторона: side > 0 ? 'LONG' : 'SHORT', 'ср, бп': bp(st.mean), CI95: `[${bp(st.lo)}, ${bp(st.hi)}]` };
})));
console.log(`\nячеек ${cells.length} | прошло всё три условия: ${[...pass].length && kMax ? [...pass].join('; ') : 'ни одной'}`);
