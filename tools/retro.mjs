// ─────────────────────────────────────────────────────────────────────────────
//  retro — ретроспектива журнала: только то, что РЕШАЕМО на нашем размере
//
//  ПОЧЕМУ ТАКОЙ СОСТАВ (предзаявка 08.09.2026):
//
//  Пересчёт 26.07.2026 показал: sd сделки 2.79% при среднем +0.07% net ⇒ для
//  вывода об эдже нужно >10 000 сделок. На n≈900 ЛЮБАЯ нарезка журнала даёт
//  красивую подвыборку — так родились и рассыпались четыре «эджа» подряд.
//  Поэтому здесь НЕТ нарезок по монетам, сторонам и часам: это машина по
//  производству ложных находок.
//
//  Считается ровно то, что не требует статистической мощности:
//    1. КОНЦЕНТРАЦИЯ — сколько весит левый хвост. Арифметика, не гипотеза.
//    2. ИЗДЕРЖКИ ПРОТИВ КАПИТАЛА — оборот в размерах счёта и комиссии в % от
//       него. Детерминировано: комиссия известна до сделки.
//    3. ГЕОМЕТРИЯ — плановые и реальные стоп/цель, R:R, нужный винрейт.
//       Сравнение с фактическим попаданием — арифметика, а не прогноз.
//
//  Всё, что требует CI, идёт с CI. Метрика без CI в вывод не идёт.
//
//  Запуск (в контейнере, где лежит база):
//    docker exec -w /app hl-paper-scanner node tools/retro.mjs [дней]
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const WINDOW_D = Number(process.argv[2] || 14);
const db = new Database('data/trades.db', { readonly: true });

const archive = existsSync('data/history_archive.json')
  ? JSON.parse(readFileSync('data/history_archive.json', 'utf8')) : [];
const all = [...archive, ...db.prepare('select * from history').all()]
  .filter((r) => r.mode === 'PRODUCTION' && r.strategy_id !== 'manual_paper'
    && r.entry_price > 0 && r.close_price > 0);

/** Ход цены в пользу позиции, %. */
const pct = (r) => {
  const raw = ((r.close_price - r.entry_price) / r.entry_price) * 100;
  return r.side === 'short' ? -raw : raw;
};
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ── 1. Концентрация ─────────────────────────────────────────────────────────
const rets = all.map(pct).sort((a, b) => a - b);
const k = Math.max(1, Math.round(rets.length * 0.05));
const tail = sum(rets.slice(0, k));
const body = sum(rets.slice(k));
console.log('── Концентрация ──');
console.log(`  сделок ${rets.length} | сумма ходов ${sum(rets).toFixed(1)} п.п.`);
console.log(`  худшие 5% (${k}): ${tail.toFixed(1)} п.п. | остальные ${rets.length - k}: ${body.toFixed(1)} п.п.`);
console.log(`  без левого хвоста журнал ${body > 0 ? 'ПЛЮСОВОЙ' : 'минусовой'}`);

// ── 2. Издержки против капитала ─────────────────────────────────────────────
const fc = db.prepare('select sum(notional) ntl, sum(fee) fee, count(*) n, sum(crossed) taker, min(ts) t0, max(ts) t1 from fill_costs').get();
console.log('\n── Издержки против капитала ──');
if (fc?.n) {
  const days = (fc.t1 - fc.t0) / 86400000;
  const eq = db.prepare('select avg(equity) e from equity_snapshots where ts > ?').get(fc.t0)?.e;
  console.log(`  за ${days.toFixed(0)} дней: оборот $${fc.ntl.toFixed(0)} | комиссии $${fc.fee.toFixed(2)} | тейкером ${(fc.taker / fc.n * 100).toFixed(1)}%`);
  if (eq > 0) {
    console.log(`  оборот = ${(fc.ntl / eq).toFixed(0)}× счёта | комиссии = ${(fc.fee / eq * 100).toFixed(0)}% счёта за ${days.toFixed(0)} дней`);
    console.log(`  в годовом выражении: ${(fc.fee / eq * 365 / days * 100).toFixed(0)}% счёта`);
  }
} else console.log('  строк издержек нет');

// ── 3. Геометрия за окно ────────────────────────────────────────────────────
const win = all.filter((r) => r.closed_at > Date.now() - WINDOW_D * 86400000);
const sl = win.filter((r) => r.reason === 'sl_trigger').map(pct);
const tp = win.filter((r) => /tp/.test(r.reason || '')).map(pct);
const mc = win.filter((r) => r.reason === 'manual_close').map(pct);
console.log(`\n── Геометрия за ${WINDOW_D} дней ──`);
if (sl.length && tp.length) {
  const rr = Math.abs(med(tp) / med(sl));
  console.log(`  стоп n=${sl.length} медиана ${med(sl).toFixed(2)}% | цель n=${tp.length} медиана +${med(tp).toFixed(2)}% | руками n=${mc.length} медиана ${med(mc).toFixed(2)}%`);
  console.log(`  R:R ${rr.toFixed(2)} → нужен винрейт ${(1 / (1 + rr) * 100).toFixed(0)}%, фактическое попадание ${(tp.length / (tp.length + sl.length) * 100).toFixed(0)}%`);
  const ev = sum([...sl, ...tp, ...mc]) / (sl.length + tp.length + mc.length);
  console.log(`  ожидание на сделку ${ev.toFixed(2)}%`);
} else console.log('  в окне нет механических выходов — сравнивать нечего');
