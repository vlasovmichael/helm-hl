// ─────────────────────────────────────────────────
//  regimeIndex — недостающая ось: чем ОТЛИЧАЛСЯ рынок в день замера
// ─────────────────────────────────────────────────
// Повод. Повторяющийся убийца выводов в этом проекте звучит так:
// «один режим = n=1, сколько сделок ни набери». Так умерла нянька — эффект
// инвертировался вместе с рынком. Так оговорён hunter_oi. Но при этом режим
// рынка НИГДЕ НЕ ЗАПИСАН: «рынок тухлый» — это ощущение, а не поле в данных.
// Из-за этого 108 сделок Hunter, 506 adopt и 55 событий liq-wick лежат единой
// кучей, и разрезать их по режиму нельзя даже задним числом.
//
// Источник — data/oi-collector/*.jsonl, который пишется с 12.07 каждые ~15 мин
// по ~232 монетам. Ничего нового качать не надо: месяц истории уже есть, и
// разметка получается РЕТРОАКТИВНОЙ. В этом весь смысл — построить ось надо
// ДО смены режима, иначе осенний замер снова окажется «на одном режиме».
//
// ── Честность метки ────────────────────────────────────────────────────────
// Соблазн: захардкодить «тухлый = дисперсия < 2%». Это была бы подгонка порога
// под ту же выборку, на которой его и смотришь. Поэтому здесь НЕТ абсолютных
// порогов: считаются непрерывные метрики, а метка выдаётся как ПЕРЦЕНТИЛЬ
// внутри наблюдённой истории, со штампом, на скольки днях он построен.
// На месяце истории перцентиль почти ничего не значит и честно об этом пишет.
// Через полгода — начнёт.
//
// Запуск:  node tools/regimeIndex.mjs [--bucket day|4h] [--json]

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join("data", "oi-collector");
const OUT_DIR = join("data", "regime");
const OUT_FILE = join(OUT_DIR, "regime.jsonl");

// Монеты с нулевым OI или нулевым объёмом — делистнутые/мёртвые (MATIC в данных
// именно такой). Они бы утянули breadth и дисперсию в шум.
const MIN_OI_USD = 50_000;
const MIN_VOL_USD = 10_000;

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const bucketArg = args[args.indexOf("--bucket") + 1];
const BUCKET_MS = bucketArg === "4h" ? 4 * 3_600_000 : 86_400_000;

// ── Чтение снимков ──────────────────────────────────────────────────────────

function* readSnapshots() {
  if (!existsSync(SRC_DIR)) return;
  const files = readdirSync(SRC_DIR).filter((f) => /^oi-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  for (const file of files) {
    for (const line of readFileSync(join(SRC_DIR, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line);
        if (s && s.t && s.d) yield s;
      } catch { /* оборванная строка на хвосте файла — обычное дело для jsonl */ }
    }
  }
}

// ── Статистика ──────────────────────────────────────────────────────────────

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
/** Доля значений истории, которые НИЖЕ x. Метка = положение внутри своей же истории. */
const pct = (hist, x) => (hist.length ? hist.filter((h) => h < x).length / hist.length : NaN);

// ── Сборка вёдер ────────────────────────────────────────────────────────────

const buckets = new Map();
for (const snap of readSnapshots()) {
  const key = Math.floor(snap.t / BUCKET_MS) * BUCKET_MS;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(snap);
}

const rows = [];
for (const [key, snaps] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
  if (snaps.length < 2) continue;  // одного снимка мало: доходность не посчитать
  snaps.sort((a, b) => a.t - b.t);
  const first = snaps[0], last = snaps[snaps.length - 1];

  const live = (c, d) => d[c] && d[c].oi * d[c].px >= MIN_OI_USD && d[c].v >= MIN_VOL_USD;
  const coins = Object.keys(last.d).filter((c) => live(c, last.d) && live(c, first.d));
  if (coins.length < 20) continue;

  // Доходность монеты за ведро — основа и ширины, и дисперсии.
  const rets = [], fundings = [], oiDeltas = [];
  let volSum = 0, oiSum = 0;
  for (const c of coins) {
    const a = first.d[c], b = last.d[c];
    if (!(a.px > 0) || !(b.px > 0)) continue;
    rets.push(b.px / a.px - 1);
    fundings.push(b.f);
    const oiA = a.oi * a.px, oiB = b.oi * b.px;
    if (oiA > 0) oiDeltas.push(Math.abs(oiB - oiA) / oiA);
    volSum += b.v; oiSum += oiB;
  }
  if (rets.length < 20) continue;

  // Реализованная волатильность BTC — якорь направления, считается по всем
  // внутренним снимкам ведра, а не по концам (концы прячут дорогу между ними).
  const btcPx = snaps.map((s) => s.d.BTC?.px).filter((p) => p > 0);
  const btcRets = btcPx.slice(1).map((p, i) => Math.log(p / btcPx[i]));
  const btcRv = sd(btcRets) * Math.sqrt(btcRets.length);  // за ведро, не годовая

  rows.push({
    t: key,
    date: new Date(key).toISOString().slice(0, BUCKET_MS === 86_400_000 ? 10 : 13),
    snaps: snaps.length,
    coins: rets.length,
    // Ширина: доля монет в плюсе. 0.5 = рынок без общего направления.
    breadth: +(rets.filter((r) => r > 0).length / rets.length).toFixed(4),
    // Дисперсия: разброс доходностей поперёк монет. Низкая = «всё стоит».
    dispersion: +(sd(rets) * 100).toFixed(4),
    // Средний ход по модулю: сколько вообще шевелится медианная монета.
    absMove: +(median(rets.map(Math.abs)) * 100).toFixed(4),
    // Фандинг: среднее = перекос толпы, разброс = насколько он неоднороден.
    fundingMean: +(mean(fundings) * 1e6).toFixed(3),
    fundingSd: +(sd(fundings) * 1e6).toFixed(3),
    // Оборачиваемость: объём на доллар открытого интереса. Низкая = сонный рынок.
    turnover: +(oiSum > 0 ? volSum / oiSum : 0).toFixed(4),
    // Текучесть OI: насколько переставились позиции внутри ведра.
    oiChurn: +(median(oiDeltas) * 100).toFixed(4),
    btcRet: +((last.d.BTC?.px / first.d.BTC?.px - 1) * 100 || 0).toFixed(4),
    btcRv: +(btcRv * 100).toFixed(4),
  });
}

if (!rows.length) {
  console.error("Ни одного ведра не собралось — проверь data/oi-collector/.");
  process.exit(1);
}

// ── Метка режима: перцентиль внутри собственной истории ─────────────────────
// Не «тухло, потому что дисперсия < 2%», а «тухло относительно того, что мы
// вообще видели». Метка честно переедет, когда история станет длиннее.

const hDisp = rows.map((r) => r.dispersion);
const hTurn = rows.map((r) => r.turnover);
for (const r of rows) {
  r.pDispersion = +pct(hDisp, r.dispersion).toFixed(3);
  r.pTurnover = +pct(hTurn, r.turnover).toFixed(3);
  // Индекс активности — среднее двух перцентилей. Одно число, чтобы джойнить.
  r.activity = +((r.pDispersion + r.pTurnover) / 2).toFixed(3);
  r.label = r.activity < 0.33 ? "quiet" : r.activity > 0.66 ? "active" : "mid";
  r.histN = rows.length;  // штамп: на скольки вёдрах построен перцентиль
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

console.log(`\n  ИНДЕКС РЕЖИМА — ${rows[0].date} … ${rows[rows.length - 1].date}, вёдер: ${rows.length}\n`);
console.log("  дата         ширина  дисперс  ход%   оборот  фандинг  BTC%    метка");
for (const r of rows) {
  console.log(
    `  ${r.date.padEnd(12)}` +
    `${r.breadth.toFixed(2).padStart(6)}  ` +
    `${r.dispersion.toFixed(2).padStart(6)}  ` +
    `${r.absMove.toFixed(2).padStart(5)}  ` +
    `${r.turnover.toFixed(3).padStart(6)}  ` +
    `${r.fundingMean.toFixed(1).padStart(7)}  ` +
    `${(r.btcRet >= 0 ? "+" : "") + r.btcRet.toFixed(1)}`.padStart(6) + "  " +
    `${r.label}`,
  );
}
console.log(`\n  Записано в ${OUT_FILE}`);
console.log(
  `\n  ⚠️  Метка — ПЕРЦЕНТИЛЬ внутри ${rows.length} вёдер собственной истории, не абсолютный\n` +
  `      порог. На таком объёме она означает лишь «тише/активнее, чем было у нас»,\n` +
  `      и переедет, когда история удлинится. Абсолютных порогов здесь нет\n` +
  `      намеренно: подобрать их по этой же выборке = подогнать под неё.\n`,
);
