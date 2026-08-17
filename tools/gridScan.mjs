// ─────────────────────────────────────────────────
//  gridScan — предзаявленная сетка признаков поверх harness
// ─────────────────────────────────────────────────
// Это НЕ «агент перебирает гипотезы». Сетка фиксируется здесь, в коде, до
// прогона, и её размер известен заранее — значит знаменатель поправки на
// множественность честный. Свободный перебор даёт при alpha=0.05 одно ложное
// срабатывание на каждые 20 попыток; на 400 сделках мы это уже проходили.
//
// ── СЕТКА (48 ячеек = 8 признаков × 2 хвоста × 3 горизонта) ────────────────
// Признаки считаются ТОЛЬКО по барам ≤ t. Сигнал — попадание в верхний или
// нижний дециль ПО СРЕЗУ РЫНКА в тот же момент времени (кросс-секция), а не по
// квантилю всей выборки: квантиль по всей истории знает будущее, и на нём
// «эдж» появляется из ничего.
//
//   mom4/mom16/mom96 — доходность за 4/16/96 баров (1ч/4ч/24ч): импульс
//   rev1             — доходность за 1 бар: краткосрочный разворот
//   atr14            — ATR(14)/close: уровень волатильности
//   volshock         — объём за 4 бара / медиана объёма за 96: объёмный шок
//   rangepos         — где close внутри диапазона 48 баров: пробой/прижатие
//   wick             — асимметрия фитилей последнего бара
//
// Горизонты: 4, 16, 96 баров (1ч, 4ч, 24ч на 15m).
//
// ── Две ловушки, на которых такие прогоны врут чаще всего ──────────────────
// 🚨 ПЕРЕКРЫТИЕ ОКОН. Соседние бары дают почти одно и то же событие, их
//    форвардные окна перекрываются, наблюдения зависимы — и значимость
//    раздувается в разы. Здесь на монету разрешено одно событие на горизонт:
//    следующее не раньше, чем закроется окно предыдущего.
// 🚨 ЗАГЛЯДЫВАНИЕ. Все признаки — из прошлого, дециль — из текущего среза
//    рынка. Ни одна величина не использует бар, который ещё не закрылся.
//
// ── Что здесь НЕ проверяется ──────────────────────────────────────────────
// ⚠️ Исполнимость. Форвардная доходность бара — это не PnL: нет спреда (а он
//    на наших монетах 16 бп, см. postOnlySim), нет проскальзывания, нет стопа.
//    Найденный тут эффект в 5 бп неторгуем. Порог осмысленности — десятки бп.
// ⚠️ Режим. 52 дня — почти наверняка ОДИН режим рынка. Статус «подтверждено»
//    на таком окне недостижим (harness, правило 4). Всё, что тут может
//    получиться, — КАНДИДАТ, ждущий смены режима.
//
// Запуск:
//   node tools/gridScan.mjs --register   # предзаявить сетку (один раз)
//   node tools/gridScan.mjs              # прогон
//   node tools/gridScan.mjs --k 300      # больше суррогатов (медленнее)

import { setCandleSource, baselineTest } from "./baseline.mjs";
import { loadGridCandles, gridCoins } from "./gridData.mjs";
import { preregister, loadRegistry } from "./harness.mjs";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };

const IV_MS = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};
const INTERVAL = argVal("--interval", "15m");
const BAR_MS = IV_MS[INTERVAL];
if (!BAR_MS) { console.error(`неизвестный интервал ${INTERVAL}`); process.exit(1); }

// Минимум монет в срезе, чтобы дециль вообще что-то значил.
const MIN_COINS_PER_TS = 30;
// Разогрев: самому длинному признаку нужно 96 баров предыстории.
const WARMUP = 96;
const DECILE = 0.1;
// Потолок событий на ячейку. Мощность упирается не в это: при sd ~0.8% эффект
// 5 бп ловится примерно на 2000 наблюдениях, 4000 — двойной запас. А без
// потолка короткий горизонт даёт ~20 000 событий, и 200 суррогатов × 48 ячеек
// превращаются в миллиарды операций без выигрыша в точности.
// Прореживание РАВНОМЕРНОЕ по времени, а не случайное: случайное выкинуло бы
// разные куски у разных ячеек, и ячейки перестали бы сравниваться между собой.
const MAX_EVENTS = 4000;

const FEATURES = ["mom4", "mom16", "mom96", "rev1", "atr14", "volshock", "rangepos", "wick"];
const TAILS = ["top", "bottom"];
const HORIZONS_BARS = String(argVal("--horizons", "4,16,96")).split(",").map(Number).filter((x) => x > 0);

// Фильтр по ликвидности: оставить только монеты, чей трейлинговый медианный
// оборот в долларах попадает в верхние (100−X)% кросс-секции. Ранг берётся по
// СРЕЗУ на ту же метку времени, поэтому заглядывания нет. 0 = без фильтра.
const MIN_TURN_PCT = Number(argVal("--minturn", 0));
// Окно по датам — под holdout: гипотеза, придуманная после взгляда на данные,
// обязана проверяться на периоде, в который не заглядывали (harness, postHoc).
const FROM = argVal("--from", null) ? new Date(argVal("--from", null)).getTime() : null;
const TO = argVal("--to", null) ? new Date(argVal("--to", null)).getTime() : null;
// Сузить сетку до конкретных ячеек — для репликации одной находки, а не поиска.
const ONLY_FEATURES = argVal("--features", null)?.split(",");
const ONLY_TAILS = argVal("--tails", null)?.split(",");

const K = Number(argVal("--k", 200));
const DO_REGISTER = args.includes("--register");

// Гипотеза своя на каждый интервал: спецификация сетки (таймфрейм + горизонты)
// входит в условие, а переиспользовать чужое предзаявление под другую
// спецификацию — это и есть подгонка через чёрный ход. Каждая новая сетка
// добавляет свои ячейки в знаменатель FDR по всему реестру.
const HYP_ID = argVal("--id", INTERVAL === "15m" ? "grid-scan-2026-08" : `grid-scan-${INTERVAL}-2026-08`);

// ── Признаки ────────────────────────────────────────────────────────────────
// rows: [t, o, h, l, c, v, n]

function computeFeatures(rows) {
  const N = rows.length;
  const out = { mom4: [], mom16: [], mom96: [], rev1: [], atr14: [], volshock: [], rangepos: [], wick: [], turn: [] };

  // True Range для ATR
  const tr = new Array(N).fill(NaN);
  for (let i = 1; i < N; i++) {
    const h = rows[i][2], l = rows[i][3], pc = rows[i - 1][4];
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  for (let i = 0; i < N; i++) {
    const c = rows[i][4];
    if (i < WARMUP || !(c > 0)) {
      for (const f of FEATURES) out[f].push(NaN);
      out.turn.push(NaN);
      continue;
    }
    const ret = (k) => {
      const p = rows[i - k][4];
      return p > 0 ? (c - p) / p : NaN;
    };
    out.mom4.push(ret(4));
    out.mom16.push(ret(16));
    out.mom96.push(ret(96));
    out.rev1.push(ret(1));

    let atr = 0;
    for (let j = i - 13; j <= i; j++) atr += tr[j];
    out.atr14.push(atr / 14 / c);

    let vRecent = 0;
    for (let j = i - 3; j <= i; j++) vRecent += rows[j][5];
    const vHist = [];
    for (let j = i - 95; j <= i; j++) vHist.push(rows[j][5]);
    vHist.sort((a, b) => a - b);
    const vMed = vHist[vHist.length >> 1];
    out.volshock.push(vMed > 0 ? vRecent / 4 / vMed : NaN);

    let hi = -Infinity, lo = Infinity;
    for (let j = i - 47; j <= i; j++) {
      if (rows[j][2] > hi) hi = rows[j][2];
      if (rows[j][3] < lo) lo = rows[j][3];
    }
    out.rangepos.push(hi > lo ? (c - lo) / (hi - lo) : NaN);

    const o = rows[i][1], h = rows[i][2], l = rows[i][3];
    const range = h - l;
    const upper = h - Math.max(o, c);
    const lower = Math.min(o, c) - l;
    out.wick.push(range > 0 ? (upper - lower) / range : NaN);

    // Вспомогательный ряд (НЕ признак сетки): медианный оборот в долларах за 96
    // баров. Нужен только фильтру ликвидности.
    const dv = [];
    for (let j = i - 95; j <= i; j++) dv.push(rows[j][5] * rows[j][4]);
    dv.sort((a, b) => a - b);
    out.turn.push(dv[dv.length >> 1]);
  }
  return out;
}

// ── Предзаявление ───────────────────────────────────────────────────────────
// Стоит ДО загрузки данных намеренно: предзаявление не должно ни в каком виде
// зависеть от того, что в данных видно.

if (DO_REGISTER) {
  preregister({
    id: HYP_ID,
    description:
      "Сеточный поиск эджа на барах: 8 признаков × 2 хвоста × 3 горизонта = 48 ячеек. " +
      "Сигнал — попадание монеты в дециль по кросс-секции рынка. Ищется условное среднее " +
      "форвардной доходности, отличимое от нулевой модели «случайный момент».",
    condition:
      `признаки ${FEATURES.join("/")}; хвосты ${TAILS.join("/")}; горизонты ${HORIZONS_BARS.join("/")} баров по ${INTERVAL}; ` +
      `дециль ${DECILE}; минимум ${MIN_COINS_PER_TS} монет в срезе; одно событие на монету на горизонт`,
    side: "long",
    holdMin: null,
    rationale:
      "Пересчёт 26.07: на уровне СДЕЛОК sd=2.79% при среднем +0.07%, поэтому для различения " +
      "с нулём нужно >10 000 сделок — недостижимо. На уровне БАРА тех же пяти слоёв шума " +
      "(стоп, трейл, комиссия, момент выхода, размер) нет: при sd 15-минутной доходности ~0.8% " +
      "эффект 5 бп ловится примерно на 2000 наблюдениях. Это не новая стратегия и не новая идея — " +
      "это перенос замера туда, где хватает мощности. Сетка фиксирована в коде ДО прогона, " +
      "её размер (48) и есть знаменатель поправки на множественность.",
    stopRule: {
      cells: 48,
      peeking: "запрещено — сетка прогоняется целиком одним заходом, ячейки не досыпаются",
    },
    evaluation:
      "Порог ДО прогона: ячейка считается КАНДИДАТОМ, если (а) проходит FDR Benjamini-Hochberg " +
      "при q=0.1 по всему реестру прогонов, И (б) |условное среднее| ≥ 20 бп — иначе эффект " +
      "неторгуем: спред на наших монетах 16 бп (postOnlySim 17.08) плюс комиссия. " +
      "Статус «подтверждено» на этом окне НЕДОСТИЖИМ: 52 дня — один режим рынка. " +
      "Кандидат ждёт смены режима и повторного прогона на свежих данных.",
    postHoc: false,
    evaluateAfter: "прогон всей сетки одним заходом",
  });
  console.log(`\n✅ сетка предзаявлена как «${HYP_ID}» (48 ячеек). Теперь прогон без --register.`);
  process.exit(0);
}

// Проверяем регистрацию до загрузки данных — падать после 30 секунд чтения
// кэша из-за отсутствующей строки в реестре незачем.
const reg = loadRegistry();
if (!reg.hypotheses.some((h) => h.id === HYP_ID)) {
  console.error(`гипотеза «${HYP_ID}» не зарегистрирована. Сначала: node tools/gridScan.mjs --register`);
  process.exit(1);
}

// ── Загрузка панели ─────────────────────────────────────────────────────────

console.log(`загружаю свечи ${INTERVAL}…`);
const coins = gridCoins(INTERVAL);
if (coins.length < MIN_COINS_PER_TS) {
  console.error(`монет в кэше ${coins.length} — мало. Сначала node tools/gridData.mjs`);
  process.exit(1);
}

const panel = new Map(); // coin → { rows, feats, idxByTs }
for (const coin of coins) {
  const c = loadGridCandles(coin, INTERVAL);
  if (!c?.rows?.length || c.rows.length < WARMUP + 200) continue;
  const idxByTs = new Map();
  c.rows.forEach((r, i) => idxByTs.set(r[0], i));
  panel.set(coin, { rows: c.rows, feats: computeFeatures(c.rows), idxByTs });
}
console.log(`монет пригодных: ${panel.size} из ${coins.length}`);

// Источник свечей для нулевых моделей — тот же кэш.
setCandleSource((coin) => loadGridCandles(coin, INTERVAL), BAR_MS);

// Все метки времени, отсортированные.
let allTs = [...new Set([...panel.values()].flatMap((p) => p.rows.map((r) => r[0])))].sort((a, b) => a - b);

// ── Половина периода (--half 1|2) ──────────────────────────────────────────
// Зачем: нулевая модель «случайный выбор монет» отвечает на вопрос «отличался
// ли дециль от среднего ВНУТРИ этой истории». На одной реализации ответ почти
// всегда «да», и p-value там измеряет выборку из фиксированного прошлого, а не
// неопределённость будущего. Единственный тест на forward-вопрос — вне выборки:
// смотреть, держится ли знак и размер эффекта во второй половине, если первую
// считать «где мы его увидели». Половина = 26 дней, это слабый тест, но
// единственный доступный на 52 днях.
if (FROM != null) allTs = allTs.filter((t) => t >= FROM);
if (TO != null) allTs = allTs.filter((t) => t <= TO);

const HALF = Number(argVal("--half", 0));
if (HALF === 1 || HALF === 2) {
  const mid = Math.floor(allTs.length / 2);
  allTs = HALF === 1 ? allTs.slice(0, mid) : allTs.slice(mid);
}
console.log(`меток времени: ${allTs.length}${HALF ? ` (половина ${HALF})` : ""}`);


// ── ТЕСТ: «а если в тот же момент выбрать монеты наугад?» ───────────────────
//
// 🚨 ДВЕ ПРЕДЫДУЩИЕ НУЛЕВЫЕ МОДЕЛИ БЫЛИ НЕПРАВИЛЬНЫМИ (обе найдены 17.08).
//
// Попытка 1 — побарный суррогат (baseline.mjs mode='time'): каждое событие
// переносится в случайный момент НЕЗАВИСИМО. Это разрушает кросс-секционную
// связку (в одну метку срабатывают ~17 монет, и их доходности связаны —
// рынок ходит вместе), разброс суррогата падает, значимость завышается.
// Результат: 17 значимых ячеек из 48 с одинаковым знаком.
//
// Попытка 2 — общий сдвиг всей сетки на δ. Связку сохраняет, но не помогает:
// события размазаны по всем 52 дням почти равномерно, поэтому средняя
// доходность сдвинутого набора почти не зависит от δ. Разброс суррогата
// схлопывается по другой причине, значимость завышается снова.
// Результат: 21 ячейка из 48.
//
// Обе модели ломали ВРЕМЯ. Но признак выбирает не время — он выбирает МОНЕТУ
// внутри уже заданного момента. Поэтому ломать надо именно отбор:
//
//   в каждый момент берём то же ЧИСЛО монет из того же набора доступных,
//   но выбираем их СЛУЧАЙНО вместо дециля по признаку.
//
// Тогда автоматически вычитается всё общее: движение рынка, время суток,
// кучность событий, режим, состав вселенной. Остаётся ровно один вопрос —
// умеет ли признак выбрать монеты лучше жребия. Это и есть определение эджа.
//
// Побочный выигрыш: запрет перекрытия окон больше не нужен. Перекрытие
// одинаково устроено у реальности и у суррогата, поэтому в сравнении оно
// сокращается — а раньше его приходилось давить прореживанием, теряя данные.

/** Детерминированный ГПСЧ (xorshift32). Тот же seed — тот же результат. */
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Срезы по каждой метке времени для горизонта h: какие монеты доступны, их
 * форвардная доходность и значения всех признаков. Строится один раз на
 * горизонт и переиспользуется всеми 16 парами (признак × хвост).
 */
// ── Ось режимов рынка ───────────────────────────────────────────────────────
// Правило 4 харнесса: статус «подтверждено» недостижим на одном режиме. Чтобы
// его вообще можно было получить, нужна ось, и она обязана быть объявлена ДО
// прогона и вычисляться механически — иначе граница режимов подгоняется под
// результат. Берём самую стандартную и неоспоримую: BTC выше/ниже своей
// 200-ДНЕВНОЙ средней. Никаких порогов «на глаз».
//
// ⚠️ На 15m 200 дней = 19 200 баров, а у нас 5000 ⇒ ось построить нельзя, и
// функция честно возвращает null вместо того, чтобы «что-нибудь придумать».
// Именно поэтому весь смысл 4h: 833 дня дают и 200-дневную среднюю, и оба
// режима внутри окна.
function buildRegimeLabels() {
  const btc = panel.get("BTC");
  if (!btc) return null;
  const barsPer200d = Math.round((200 * 864e5) / BAR_MS);
  if (btc.rows.length < barsPer200d + 50) return null;

  const labels = new Map(); // ts → 'рост' | 'падение'
  let sum = 0;
  for (let i = 0; i < btc.rows.length; i++) {
    sum += btc.rows[i][4];
    if (i >= barsPer200d) sum -= btc.rows[i - barsPer200d][4];
    if (i < barsPer200d) continue;
    const sma = sum / barsPer200d;
    labels.set(btc.rows[i][0], btc.rows[i][4] >= sma ? "рост" : "падение");
  }
  return labels;
}

function buildSlices(horizonBars) {
  const slices = [];
  for (const ts of allTs) {
    const items = [];
    for (const [, p] of panel) {
      const i = p.idxByTs.get(ts);
      if (i === undefined || i < WARMUP) continue;
      if (i + horizonBars >= p.rows.length) continue;
      const a = p.rows[i][4];
      const b = p.rows[i + horizonBars][4];
      if (!(a > 0) || !(b > 0)) continue;
      items.push({ i, fwd: (b - a) / a, p, turn: p.feats.turn[i] });
    }
    let kept = items;
    if (MIN_TURN_PCT > 0) {
      const withTurn = items.filter((x) => Number.isFinite(x.turn));
      if (withTurn.length < MIN_COINS_PER_TS) continue;
      withTurn.sort((a, b) => a.turn - b.turn);
      const drop = Math.floor(withTurn.length * (MIN_TURN_PCT / 100));
      kept = withTurn.slice(drop);
    }
    if (kept.length < MIN_COINS_PER_TS) continue;
    slices.push({ ts, items: kept });
  }
  return slices;
}

/** Среднее по децилю, отобранному признаком. */
function actualMean(slices, feature, tail) {
  let sum = 0, n = 0;
  for (const { items } of slices) {
    const vals = [];
    for (const it of items) {
      const v = it.p.feats[feature][it.i];
      if (Number.isFinite(v)) vals.push({ v, fwd: it.fwd });
    }
    if (vals.length < MIN_COINS_PER_TS) continue;
    vals.sort((a, b) => a.v - b.v);
    const cut = Math.max(1, Math.floor(vals.length * DECILE));
    const picked = tail === "top" ? vals.slice(-cut) : vals.slice(0, cut);
    for (const x of picked) { sum += x.fwd; n++; }
  }
  return { mean: n ? sum / n : NaN, n };
}

/**
 * Распределение среднего при случайном отборе. НЕ зависит ни от признака, ни
 * от хвоста — только от горизонта, поэтому считается один раз на горизонт и
 * переиспользуется всеми 16 ячейками. Это же делает прогон быстрым.
 */
function randomMeans(slices, k, seed) {
  const rnd = makeRng(seed);
  const out = [];
  for (let j = 0; j < k; j++) {
    let sum = 0, n = 0;
    for (const { items } of slices) {
      const len = items.length;
      const cut = Math.max(1, Math.floor(len * DECILE));
      // Частичный Фишер–Йейтс: cut случайных без повторов, без копии массива.
      const idx = [];
      const used = new Set();
      while (idx.length < cut) {
        const r = Math.floor(rnd() * len);
        if (used.has(r)) continue;
        used.add(r); idx.push(r);
      }
      for (const r of idx) { sum += items[r].fwd; n++; }
    }
    if (n) out.push(sum / n);
  }
  return out;
}

// ── Прогон ──────────────────────────────────────────────────────────────────

const cells = [];
const useFeatures = ONLY_FEATURES ? FEATURES.filter((f) => ONLY_FEATURES.includes(f)) : FEATURES;
const useTails = ONLY_TAILS ? TAILS.filter((t) => ONLY_TAILS.includes(t)) : TAILS;
for (const feature of useFeatures) {
  for (const tail of useTails) {
    for (const hb of HORIZONS_BARS) cells.push({ feature, tail, horizonBars: hb });
  }
}
console.log(`\nячеек: ${cells.length}, случайных отборов на горизонт: ${K}\n`);

const regimeLabels = buildRegimeLabels();
const REGIMES = regimeLabels ? ["рост", "падение"] : [];
if (regimeLabels) {
  // Считаем ТОЛЬКО внутри рабочего окна: labels строятся по всей серии BTC, и
  // печатать их целиком при активном --from/--to значит показывать режимы
  // периода, который в прогон не входит (поймано 17.08 на holdout-прогоне).
  const inWindow = new Set(allTs);
  const counts = {};
  for (const [ts, v] of regimeLabels) if (inWindow.has(ts)) counts[v] = (counts[v] || 0) + 1;
  const d = (n) => ((n * BAR_MS) / 864e5).toFixed(0);
  console.log(`ось режимов (BTC vs 200д SMA): рост ${d(counts["рост"] || 0)}д, падение ${d(counts["падение"] || 0)}д`);
} else {
  console.log(`ось режимов НЕДОСТУПНА на ${INTERVAL}: 200 дней не влезают в 5000 баров ⇒ окно = один режим`);
}

/** Эдж ячейки на подмножестве срезов. Своя нулевая модель на каждое подмножество:
 *  переиспользовать нули полного окна нельзя — у режимов разные средние. */
function cellEdge(slices, feature, tail, nulls, nullMean) {
  const a = actualMean(slices, feature, tail);
  if (!Number.isFinite(a.mean)) return null;
  const dev = Math.abs(a.mean - nullMean);
  const extreme = nulls.filter((x) => Math.abs(x - nullMean) >= dev).length;
  return { n: a.n, edgeBp: (a.mean - nullMean) * 10_000, p: (1 + extreme) / (nulls.length + 1) };
}

const results = [];
for (const hb of HORIZONS_BARS) {
  process.stdout.write(`\rгоризонт ${hb} баров: строю срезы…            `);
  const slices = buildSlices(hb);
  process.stdout.write(`\rгоризонт ${hb} баров: ${slices.length} срезов, случайный отбор ×${K}…   `);
  const nulls = randomMeans(slices, K, 7 + hb);
  const nullMean = nulls.reduce((a, b) => a + b, 0) / nulls.length;

  // Подмножества по режиму + свои нули для каждого.
  const byRegime = {};
  for (const rg of REGIMES) {
    const sub = slices.filter((s) => regimeLabels.get(s.ts) === rg);
    if (sub.length < 50) continue;
    const nl = randomMeans(sub, K, 21 + hb + rg.length);
    byRegime[rg] = { slices: sub, nulls: nl, nullMean: nl.reduce((a, b) => a + b, 0) / nl.length };
  }

  for (const feature of useFeatures) {
    for (const tail of useTails) {
      const a = actualMean(slices, feature, tail);
      const label = `${feature}.${tail}.${hb}b`;
      if (!Number.isFinite(a.mean)) {
        results.push({ feature, tail, horizonBars: hb, label, n: a.n, note: "нет данных" });
        continue;
      }
      const dev = Math.abs(a.mean - nullMean);
      const extreme = nulls.filter((x) => Math.abs(x - nullMean) >= dev).length;
      const perRegime = {};
      for (const [rg, ctx] of Object.entries(byRegime)) {
        const e = cellEdge(ctx.slices, feature, tail, ctx.nulls, ctx.nullMean);
        if (e) perRegime[rg] = e;
      }
      results.push({
        feature, tail, horizonBars: hb, label,
        n: a.n,
        edgeBp: (a.mean - nullMean) * 10_000,
        p: (1 + extreme) / (nulls.length + 1),
        perRegime,
      });
    }
  }
}
console.log("\n");

// ── Вывод ───────────────────────────────────────────────────────────────────

const scored = results.filter((r) => r.p != null);
scored.sort((a, b) => a.p - b.p);

const m = results.length;
const q = 0.1;
let kMax = 0;
scored.forEach((r, i) => { if (r.p <= ((i + 1) / m) * q) kMax = i + 1; });
const fdrThreshold = kMax ? (kMax / m) * q : null;

const sgn = (x) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`);

console.log(`  СЕТОЧНЫЙ ПРОГОН — ${panel.size} монет, ${INTERVAL}, ${allTs.length} меток времени`);
console.log(`  нулевая модель: случайный выбор монет в тот же момент, ×${K}`);
console.log(`  ячеек ${m}, с результатом ${scored.length}\n`);
console.log(`  ${"ячейка".padEnd(22)} ${"n".padStart(7)} ${"эдж,бп".padStart(9)} ${"p".padStart(7)}`);
console.log(`  ${"─".repeat(50)}`);
for (const r of scored.slice(0, Number(argVal("--top", 12)))) {
  console.log(`  ${r.label.padEnd(22)} ${String(r.n).padStart(7)} ${sgn(r.edgeBp).padStart(9)} ${r.p.toFixed(4).padStart(7)}`);
}

console.log(`\n  ── ОТБОР ПО ПРЕДЗАЯВЛЕННОМУ ПОРОГУ ──`);
console.log(`  FDR q=${q}: порог p ≤ ${fdrThreshold != null ? fdrThreshold.toFixed(5) : "ни одна ячейка не прошла"}`);
const survivors = fdrThreshold == null ? [] : scored.filter((r) => r.p <= fdrThreshold);
const tradeable = survivors.filter((r) => Math.abs(r.edgeBp) >= 20);

if (!survivors.length) {
  console.log(`  Ни одна ячейка не прошла поправку на множественность.`);
} else {
  console.log(`  Прошли FDR (${survivors.length}): ${survivors.map((s) => s.label).join(", ")}`);
  if (!tradeable.length) {
    console.log(`\n  Но ни одна не дотянула до 20 бп — все эффекты меньше спреда (16 бп). Неторгуемо.`);
  } else {
    console.log(`\n  ПРОШЛИ FDR + ≥20 бп: ${tradeable.map((t) => `${t.label} ${sgn(t.edgeBp)}бп`).join(", ")}`);

    if (!REGIMES.length) {
      console.log(`  ⚠️  КАНДИДАТЫ, не находки: ось режимов на ${INTERVAL} недоступна ⇒ окно = один режим.`);
    } else {
      // Правило 4 харнесса в исполняемом виде: эффект, который есть только в
      // одном режиме, — это бета. Так умерла нянька, так умер oi-up-px-flat.
      console.log(`\n  ── ПРОВЕРКА ПО РЕЖИМАМ (BTC vs 200д SMA) ──`);
      console.log(`  ${"ячейка".padEnd(22)} ${"всё".padStart(9)} ${"рост".padStart(9)} ${"падение".padStart(10)}   вердикт`);
      const survivors2 = [];
      for (const t of tradeable) {
        const up = t.perRegime["рост"], dn = t.perRegime["падение"];
        let verdict;
        if (!up || !dn) verdict = "нет данных в одном из режимов";
        else if (up.edgeBp * dn.edgeBp < 0) verdict = "ЗНАК ПЕРЕВЕРНУЛСЯ = бета";
        else if (Math.abs(up.edgeBp) < 20 || Math.abs(dn.edgeBp) < 20) verdict = "в одном режиме <20бп";
        else { verdict = "✅ ДЕРЖИТСЯ В ОБОИХ"; survivors2.push(t); }
        console.log(
          `  ${t.label.padEnd(22)} ${sgn(t.edgeBp).padStart(9)} ${(up ? sgn(up.edgeBp) : "—").padStart(9)}` +
          ` ${(dn ? sgn(dn.edgeBp) : "—").padStart(10)}   ${verdict}`,
        );
      }
      console.log("");
      if (!survivors2.length) {
        console.log(`  Ни одна ячейка не держится в обоих режимах ⇒ эджа нет, есть бета.`);
      } else {
        console.log(`  🔬 ВЫЖИЛИ НА ДВУХ РЕЖИМАХ: ${survivors2.map((t) => t.label).join(", ")}`);
        console.log(`  Это НЕ «работает». Это право идти на holdout (лестница статусов харнесса).`);
      }
    }
  }
}
console.log("");
