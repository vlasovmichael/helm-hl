// ─────────────────────────────────────────────────────────────────────────────
//  rsiExtremes — проверка «RSI выше 70/80 → шорт, ниже 30/20 → лонг»
//
//  ПРЕДЗАЯВКА (08.09.2026, до первого прогона):
//
//  ГИПОТЕЗА. Возврат к среднему из зон перекупленности/перепроданности RSI(14)
//  даёт положительное ожидание после комиссий.
//
//  СЕМЕЙСТВО. 2 порога {70/30, 80/20} × 2 выхода {фикс. горизонт, RSI назад к 50}
//  × 2 таймфрейма {1ч, 4ч} × 2 стороны = 16 ячеек. Множественность обязана
//  учитываться: при 16 независимых проверках хотя бы одна «работает» на
//  пятипроцентном уровне с вероятностью ~55%. Поправка — Benjamini-Hochberg
//  FDR 10%.
//
//  ПРАВИЛО РЕШЕНИЯ. Ячейка принимается, только если среднее net > 0 И её
//  p-значение переживает BH-FDR. p односторонний (гипотеза направленная),
//  считается кластерным бутстрапом по символам: сделки одного символа не
//  независимы, и бутстрап по сделкам занизил бы p в разы.
//
//  МЕХАНИКА, зафиксирована до прогона:
//    · RSI(14) по Уайлдеру на закрытиях;
//    · сигнал — ПЕРЕСЕЧЕНИЕ порога, не «каждый бар в зоне»: иначе один эпизод
//      родит десятки почти одинаковых сделок и раздует n;
//    · повторный вход по символу запрещён, пока RSI не вернулся к 50;
//    · вход по ОТКРЫТИЮ следующего бара — заглядывания в закрытие сигнального
//      бара нет;
//    · издержки 9 бп на круг (тейкер обеими ногами).
//
//  БЕЙЗЛАЙН. Случайные входы по тем же символам и в те же моменты, столько же
//  сделок, тот же выход — иначе не с чем сравнить «положительное среднее».
//
//  СТОП-ПРАВИЛО. Один взгляд, всё окно. Параметры после просмотра результата
//  не подбираются.
//
//  РЕЖИМ. Один прогон ничего не решает: тот же каталог нужно прогнать на втором
//  окне с другим характером рынка (например 2022 год) и сравнить знак. Правило,
//  меняющее знак между окнами, — это бета, а не эдж.
//
//  ОГРАНИЧЕНИЯ, называть вместе с выводом: survivorship (только символы, дожившие
//  до сегодня); Binance ≠ HL по составу и ликвидности; вывод «не работает»
//  переносится на HL сильнее, чем вывод «работает».
//
//  Запуск: node tools/rsiExtremes.mjs <каталог с *.csv свечей 1ч>
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'node:fs';

const DIR = process.argv[2];
if (!DIR) { console.error('нужен каталог со свечами'); process.exit(1); }

const P = Object.freeze({
  RSI_LEN: 14,
  THRESHOLDS: [[70, 30], [80, 20]],
  TF_HOURS: [1, 4],
  HORIZON_BARS: 24,     // фикс-выход: 24 бара своего ТФ
  EXIT_MID: 50,         // выход «RSI вернулся к середине»
  FEE_BP: 9,            // круг, тейкер обеими ногами
  BOOT: 2000,
  FDR_Q: 0.10,
});

// ── Свечи ───────────────────────────────────────────────────────────────────
const bars = new Map();  // symbol → [{t, o, c}]
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.csv'))) {
  const sym = f.replace(/-1h-.*/, '');
  const rows = [];
  for (const line of readFileSync(`${DIR}/${f}`, 'utf8').split('\n')) {
    if (!line || line.startsWith('open_time')) continue;
    const p = line.split(',');
    const t = Number(p[0]), o = Number(p[1]), h = Number(p[2]), l = Number(p[3]), c = Number(p[4]);
    if (Number.isFinite(t) && o > 0 && c > 0) rows.push({ t, o, h, l, c });
  }
  if (!rows.length) continue;
  if (!bars.has(sym)) bars.set(sym, []);
  bars.get(sym).push(...rows);
}
for (const [sym, rows] of bars) {
  rows.sort((a, b) => a.t - b.t);
  if (rows.length < 5000) bars.delete(sym);
}
console.log(`символов ${bars.size} | баров у первого ${[...bars.values()][0].length}\n`);

/** Часовые бары → бары таймфрейма tf: открытие первого, закрытие последнего. */
function resample(rows, tf) {
  if (tf === 1) return rows;
  const out = [];
  for (let i = 0; i + tf <= rows.length; i += tf) {
    const sl = rows.slice(i, i + tf);
    out.push({
      t: sl[0].t, o: sl[0].o, c: sl[sl.length - 1].c,
      h: Math.max(...sl.map((x) => x.h)), l: Math.min(...sl.map((x) => x.l)),
    });
  }
  return out;
}

/** RSI(14) по Уайлдеру. Первые LEN значений — null. */
function rsi(rows, len) {
  const out = new Array(rows.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = rows[i].c - rows[i - 1].c;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= len; loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < rows.length; i++) {
    const d = rows[i].c - rows[i - 1].c;
    gain = (gain * (len - 1) + (d > 0 ? d : 0)) / len;
    loss = (loss * (len - 1) + (d < 0 ? -d : 0)) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// ── Сделки ──────────────────────────────────────────────────────────────────
// Возвращает [{sym, ret}] в долях, net после комиссий.
function trades({ tf, hi, lo, side, exit }) {
  const fee = P.FEE_BP / 10_000;
  const out = [];
  for (const [sym, hourly] of bars) {
    const rows = resample(hourly, tf);
    const r = rsi(rows, P.RSI_LEN);
    let armed = true;   // повторный вход только после возврата к середине
    for (let i = P.RSI_LEN + 1; i < rows.length - 1; i++) {
      const prev = r[i - 1], cur = r[i];
      if (prev == null || cur == null) continue;
      if (!armed) { if ((side === 'short' && cur < P.EXIT_MID) || (side === 'long' && cur > P.EXIT_MID)) armed = true; continue; }
      const fired = side === 'short' ? (prev <= hi && cur > hi) : (prev >= lo && cur < lo);
      if (!fired) continue;
      armed = false;
      const entry = rows[i + 1].o;
      let j;
      if (exit === 'fixed') {
        j = Math.min(i + 1 + P.HORIZON_BARS, rows.length - 1);
      } else {
        j = rows.length - 1;
        for (let k = i + 1; k < rows.length; k++) {
          if (r[k] != null && ((side === 'short' && r[k] <= P.EXIT_MID) || (side === 'long' && r[k] >= P.EXIT_MID))) { j = k; break; }
        }
      }
      const exitPx = rows[j].c;
      const raw = side === 'short' ? -(exitPx - entry) / entry : (exitPx - entry) / entry;
      // Просадка внутри сделки: она решает, доживёт ли позиция до выхода под стопом.
      let adverse = 0;
      for (let k = i + 1; k <= j; k++) {
        const move = side === 'short' ? (rows[k].h - entry) / entry : (rows[k].l - entry) / entry;
        const against = side === 'short' ? move : -move;
        if (against > adverse) adverse = against;
      }
      out.push({ sym, ret: raw - fee, mae: -adverse });
    }
  }
  return out;
}

/** Те же символы и столько же сделок, но моменты входа случайные. */
function randomBaseline({ tf, side, exit, n }) {
  const fee = P.FEE_BP / 10_000;
  const out = [];
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const syms = [...bars.keys()];
  while (out.length < n) {
    const sym = syms[Math.floor(rnd() * syms.length)];
    const rows = resample(bars.get(sym), tf);
    const i = P.RSI_LEN + 1 + Math.floor(rnd() * (rows.length - P.RSI_LEN - P.HORIZON_BARS - 3));
    const entry = rows[i + 1].o;
    const j = Math.min(i + 1 + P.HORIZON_BARS, rows.length - 1);
    const exitPx = rows[j].c;
    const raw = side === 'short' ? -(exitPx - entry) / entry : (exitPx - entry) / entry;
    out.push({ sym, ret: raw - fee });
  }
  void exit;
  return out;
}

// ── Кластерный бутстрап: CI и односторонний p ───────────────────────────────
function clustered(tr) {
  const byS = new Map();
  for (const t of tr) { if (!byS.has(t.sym)) byS.set(t.sym, []); byS.get(t.sym).push(t.ret); }
  const cl = [...byS.values()];
  const means = [];
  let seed = 999;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let b = 0; b < P.BOOT; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < cl.length; i++) { const c = cl[Math.floor(rnd() * cl.length)]; for (const v of c) { s += v; n++; } }
    if (n) means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const mean = tr.reduce((a, b) => a + b.ret, 0) / tr.length;
  const p = means.filter((m) => m <= 0).length / means.length;   // односторонний
  return { mean, lo: means[Math.floor(P.BOOT * 0.025)], hi: means[Math.floor(P.BOOT * 0.975)], p, clusters: cl.length };
}

const bp = (x) => (x * 10_000).toFixed(1);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const cells = [];
for (const [hi, lo] of P.THRESHOLDS) {
  for (const tf of P.TF_HOURS) {
    for (const side of ['short', 'long']) {
      for (const exit of ['fixed', 'mid']) {
        const tr = trades({ tf, hi, lo, side, exit });
        if (tr.length < 30) continue;
        const st = clustered(tr);
        cells.push({
          name: `${side === 'short' ? `RSI>${hi} шорт` : `RSI<${lo} лонг`} · ${tf}ч · выход ${exit === 'fixed' ? `${P.HORIZON_BARS} баров` : 'RSI→50'}`,
          n: tr.length, ...st, med: median(tr.map((t) => t.ret)),
          maes: tr.map((t) => t.mae).sort((a, b) => a - b),
        });
      }
    }
  }
}

// Benjamini-Hochberg: сортируем p по возрастанию, порог i/m·q.
const sorted = [...cells].sort((a, b) => a.p - b.p);
const m = sorted.length;
let kMax = 0;
sorted.forEach((c, i) => { if (c.p <= ((i + 1) / m) * P.FDR_Q) kMax = i + 1; });
const passing = new Set(sorted.slice(0, kMax).map((c) => c.name));

console.table(cells.map((c) => ({
  ячейка: c.name, n: c.n, 'ср, бп': bp(c.mean), 'медиана, бп': bp(c.med),
  'CI95': `[${bp(c.lo)}, ${bp(c.hi)}]`, p: c.p.toFixed(3),
  'BH-FDR 10%': passing.has(c.name) && c.mean > 0 ? 'ПРОШЛА' : '—',
})));

// 🚨 Бейзлайн обязан совпадать по ГОРИЗОНТУ с ячейкой. Случайный лонг на 4 днях
// в бычьем окне сам по себе в плюсе, и без такого сравнения любой лонг-фильтр
// выглядит открытием.
// Средний плюс ничего не стоит, если позиция до него не доживает: считаем, какая
// доля сделок была бы выбита стопом 3/5/8% ДО выхода.
console.log('\n── просадка внутри сделки и выживаемость под стопом ──');
console.table(cells.filter((c) => c.mean > 0).map((c) => {
  const m = c.maes;
  const qq = (p) => m[Math.floor(m.length * p)];
  return {
    ячейка: c.name, n: c.n,
    'MAE медиана': `${(qq(0.5) * 100).toFixed(1)}%`,
    'MAE худшие 5%': `${(qq(0.05) * 100).toFixed(1)}%`,
    'выбило стопом −3%': `${(m.filter((v) => v <= -0.03).length / m.length * 100).toFixed(0)}%`,
    'стопом −5%': `${(m.filter((v) => v <= -0.05).length / m.length * 100).toFixed(0)}%`,
  };
}));

console.log('\n── бейзлайн: случайный вход, горизонт как у ячейки ──');
console.table(P.TF_HOURS.flatMap((tf) => ['short', 'long'].map((side) => {
  const b = randomBaseline({ tf, side, exit: 'fixed', n: 4000 });
  const st = clustered(b);
  return {
    'горизонт': `${tf * P.HORIZON_BARS}ч (${tf}ч × ${P.HORIZON_BARS})`, сторона: side,
    n: b.length, 'ср, бп': bp(st.mean), 'CI95': `[${bp(st.lo)}, ${bp(st.hi)}]`,
  };
})));

console.log(`\nячеек ${m} | прошло BH-FDR ${P.FDR_Q * 100}%: ${kMax === 0 ? 'ни одной' : [...passing].join('; ')}`);
