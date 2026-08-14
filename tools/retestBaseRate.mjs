// ─────────────────────────────────────────────────
//  retestBaseRate — «ретест приходит в 80% случаев» это сколько на самом деле
// ─────────────────────────────────────────────────
// Повод (2026-08-14). Тред про market structure: девять «истин», из которых
// фальсифицируемая ровно одна — Truth 6, «wait for the retest, it comes 80% of
// the time». Остальное либо метафоры, либо определения задним числом. Это
// единственное число во всём посте, и оно проверяется на свечах.
//
// ⚠️ Это ИЗМЕРЕНИЕ БАЗРЕЙТА, а не стратегия. Вопрос ровно один: возвращается ли
// цена к пробитому структурному уровню. Что делать после возврата, прибыльно ли
// это, куда ставить стоп — здесь НЕ спрашивается и не отвечается.
//
// ── Почему один процент ничего не значит без нулевой модели ────────────────
// Допустим, ответ «78%». Это подтверждает Truth 6? Нет. Цена болтается и задевает
// произвольные уровни постоянно — тем чаще, чем ближе уровень и чем выше
// волатильность. Пока не измерено, сколько даёт ПРОИЗВОЛЬНЫЙ уровень на том же
// расстоянии, «78%» — это замер волатильности, а не структуры.
//
// Поэтому три модели, у каждой сломано ровно одно свойство:
//
//   real   — пробой структурного уровня, ждём возврата к нему.
//   time   — тот же коин, то же расстояние d, но момент СЛУЧАЙНЫЙ. Ломает
//            структуру, сохраняет коин и геометрию. «А важно ли, что уровень
//            структурный, или достаточно быть уровнем на расстоянии d?»
//   mirror — тот же бар, то же расстояние d, но уровень с ДРУГОЙ стороны цены.
//            Ломает направление, сохраняет момент, коин и волатильность.
//            «А это возврат к уровню или просто болтанка амплитуды d?»
//
// mirror — самая жёсткая из трёх: она держит фиксированным всё, включая
// мгновенную волатильность в момент события. Если real ≈ mirror, то «ретест» —
// это переименованная амплитуда.
//
// ── САМОПРОВЕРКА: откуда берётся механический перекос ──────────────────────
// У real есть встроенное преимущество, не связанное со структурой: BOS случается
// в момент, когда цена ТОЛЬКО ЧТО пересекла уровень снизу вверх, то есть она
// пришла туда с ходу и уровень позади неё в шаге. Случайный момент такой
// «свежести» не имеет. Этот перекос механический, он был бы и на чистом
// случайном блуждании, где структуры нет по построению.
//
// Поэтому прибор сначала гоняет себя на синтетическом GBM. Полученный там зазор
// real−null — это ЦЕНА АРТЕФАКТА. На реальных данных зазор обязан превысить её,
// иначе никакой структуры не измерено. Без этого шага я бы отрапортовал артефакт
// собственного определения BOS как находку.
//
// ── ПРЕДЗАЯВКА (зафиксировано ДО первого прогона) ──────────────────────────
// Определения:
//   TF          1h (склеен из кэша 15m ×4)
//   swing high  бар, чей high строго выше highs L=3 баров с каждой стороны
//   BOS вверх   close бара пробивает ближайший НЕПРОБИТЫЙ swing high выше цены
//   ретест      в следующие N=24 бара (сутки) какой-нибудь low ≤ уровня
//   вниз        всё зеркально
// Уровень пробивается один раз: после BOS он помечен и больше не стреляет.
//
// Правило решения, объявленное заранее:
//   1. Число 80% считается опровергнутым, если 95% ДИ реального базрейта его
//      не накрывает.
//   2. «Структура есть» засчитывается, только если (real − mirror) превышает
//      артефакт, измеренный на GBM, и ДИ этой разницы не задевает ноль.
//   3. ДИ считается ПО МОНЕТАМ, а не по событиям: события внутри одной монеты
//      не независимы (общий режим, общая волатильность), и биномиальный ДИ по
//      пулу соврёт в разы. Пул печатается справочно.
//
// ⚠️ Данные: ~40 дней, один режим рынка. Для базрейта возврата к уровню это
// менее губительно, чем для эджа, но вывод остаётся привязанным к этим 40 дням.
//
// usage: node tools/retestBaseRate.mjs [--bars=24] [--pivot=3] [--seed=12345]

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { rng } from "./baseline.mjs";

const DIR = join("data", "borrowed", "candles");

// ── параметры (предзаявлены, флагами меняются только для чувствительности) ──
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : def;
};
const HORIZON = arg("bars", 24);   // сколько баров ждём ретест
const PIVOT = arg("pivot", 3);     // L: сколько баров с каждой стороны у свинга
const SEED = arg("seed", 12345);
const AGG = 4;                     // 15m ×4 = 1h
const MIN_EVENTS_PER_COIN = 5;     // для ДИ по монетам
const MODELS = ["real", "time", "mirror", "level"];

// ГПСЧ берём из baseline.mjs — там единственная реализация и там же разбор,
// почему прежний LCG был сломан (терял младшие биты за 2⁵³).

// ── склейка 15m → 1h ──
// Дыры в данных HL реальны, поэтому группируем по метке часа, а не по счёту.
function aggregate(rows, factor) {
  const out = [];
  const bucketMs = 900_000 * factor;
  let cur = null;
  for (const [t, o, h, l, c] of rows) {
    const b = Math.floor(t / bucketMs) * bucketMs;
    if (!cur || cur[0] !== b) {
      if (cur) out.push(cur);
      cur = [b, o, h, l, c];
    } else {
      cur[2] = Math.max(cur[2], h);
      cur[3] = Math.min(cur[3], l);
      cur[4] = c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Свинг-точки. Бар i — свинг-хай, если его high строго выше highs L баров с
 * каждой стороны. Подтверждается только через L баров после себя — раньше
 * знать нельзя, и это не придирка: правило, использующее неподтверждённый
 * свинг, читает будущее.
 */
function swings(bars, L) {
  const highs = [], lows = [];
  for (let i = L; i < bars.length - L; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= L; k++) {
      if (bars[i][2] <= bars[i - k][2] || bars[i][2] <= bars[i + k][2]) isH = false;
      if (bars[i][3] >= bars[i - k][3] || bars[i][3] >= bars[i + k][3]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push({ idx: i, level: bars[i][2], confirmedAt: i + L, broken: false });
    if (isL) lows.push({ idx: i, level: bars[i][3], confirmedAt: i + L, broken: false });
  }
  return { highs, lows };
}

/**
 * Ищет BOS-события. Возвращает [{ i, level, close, d, dir }], где d — расстояние
 * от закрытия пробойного бара до уровня, в долях цены. Именно d потом
 * переносится в нулевые модели: сравнивать надо уровни одной геометрии.
 */
function findBOS(bars, L) {
  const { highs, lows } = swings(bars, L);
  const events = [];
  let hi = 0, lo = 0;
  const activeH = [], activeL = [];

  for (let i = 0; i < bars.length; i++) {
    while (hi < highs.length && highs[hi].confirmedAt <= i) activeH.push(highs[hi++]);
    while (lo < lows.length && lows[lo].confirmedAt <= i) activeL.push(lows[lo++]);
    const close = bars[i][4];

    // Вверх. Одно закрытие может перепрыгнуть сразу несколько свингов; тогда
    // трейдер по фреймворку («mark the NEAREST untested swing point») смотрел на
    // САМЫЙ НИЖНИЙ из них — цена шла снизу и первым встретила его. Остальные
    // гасим без события, иначе один импульс даёт три коррелированных «пробоя».
    const brokeUp = activeH.filter((s) => !s.broken && close >= s.level);
    if (brokeUp.length) {
      let lvl = Infinity;
      for (const s of brokeUp) { s.broken = true; if (s.level < lvl) lvl = s.level; }
      events.push({ i, level: lvl, close, d: (close - lvl) / close, dir: "up" });
    }

    // Вниз — зеркально: ближайший снизу это САМЫЙ ВЕРХНИЙ из пробитых.
    const brokeDown = activeL.filter((s) => !s.broken && close <= s.level);
    if (brokeDown.length) {
      let lvl = -Infinity;
      for (const s of brokeDown) { s.broken = true; if (s.level > lvl) lvl = s.level; }
      events.push({ i, level: lvl, close, d: (lvl - close) / close, dir: "down" });
    }
  }
  return events;
}

/** Коснулась ли цена уровня в следующие N баров. */
function touched(bars, from, N, level, side) {
  const end = Math.min(bars.length - 1, from + N);
  for (let i = from + 1; i <= end; i++) {
    if (side === "below" ? bars[i][3] <= level : bars[i][2] >= level) return true;
  }
  return false;
}

/**
 * Прогон нулевых моделей по одной монете.
 * real   — вернулась ли цена к пробитому уровню
 * time   — тот же d, случайный момент в той же серии
 * mirror — тот же момент, тот же d, зеркальная сторона
 * level  — тот же момент, та же сторона, но расстояние d ВЗЯТО ОТ ДРУГОГО
 *          события. Это ключевая модель: она оставляет всё состояние после
 *          пробоя (импульс, волатильность, склонность к откату) и ломает
 *          ровно одно — что уровень был ИМЕННО ЭТОЙ свинг-точкой.
 *
 * Зачем level отдельно от mirror и time. Обе те модели путают два разных
 * объяснения: «цена помнит уровень» и «после любого рывка бывает откат».
 * Откат после рывка поднял бы real над обеими, не имея к структуре отношения.
 * Разница real−level отвечает на вопрос в чистом виде: важно ли, что уровень
 * структурный, если момент и импульс те же самые.
 */
function measureCoin(bars, L, N, rnd, dPool = null) {
  const events = findBOS(bars, L);
  const res = { real: [0, 0], time: [0, 0], mirror: [0, 0], level: [0, 0] };
  const pool = dPool && dPool.length ? dPool : events.map((e) => e.d).filter((d) => d > 0);
  for (const e of events) {
    if (e.i + N >= bars.length) continue;      // не хватает будущего — не событие
    if (!(e.d > 0)) continue;

    const belowSide = e.dir === "up" ? "below" : "above";
    const mirrorSide = e.dir === "up" ? "above" : "below";

    res.real[1]++;
    if (touched(bars, e.i, N, e.level, belowSide)) res.real[0]++;

    // mirror: уровень на том же расстоянии, но с другой стороны от закрытия
    const mLevel = e.dir === "up" ? e.close * (1 + e.d) : e.close * (1 - e.d);
    res.mirror[1]++;
    if (touched(bars, e.i, N, mLevel, mirrorSide)) res.mirror[0]++;

    // time: случайный бар той же серии, уровень на том же расстоянии и с той же
    // стороны. Ломается ТОЛЬКО структурность момента.
    const r = L + Math.floor(rnd() * (bars.length - N - L - 1));
    if (r + N < bars.length) {
      const c = bars[r][4];
      const tLevel = e.dir === "up" ? c * (1 - e.d) : c * (1 + e.d);
      res.time[1]++;
      if (touched(bars, r, N, tLevel, belowSide)) res.time[0]++;
    }

    // level: тот же бар и та же сторона, но расстояние взято от чужого события.
    // Уровень перестаёт быть свинг-точкой, оставаясь такой же «геометрически».
    if (pool.length > 1) {
      let dOther = pool[Math.floor(rnd() * pool.length)];
      if (!(dOther > 0)) dOther = e.d;
      const lLevel = e.dir === "up" ? e.close * (1 - dOther) : e.close * (1 + dOther);
      res.level[1]++;
      if (touched(bars, e.i, N, lLevel, belowSide)) res.level[0]++;
    }
  }
  return res;
}

// ── статистика ──
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
/** ДИ по монетам: событий внутри монеты не независимы, пул соврёт. */
function coinCI(rates) {
  const m = mean(rates);
  const se = sd(rates) / Math.sqrt(rates.length);
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, n: rates.length, se };
}
function wilson(k, n) {
  if (!n) return { lo: 0, hi: 0 };
  const p = k / n, z = 1.96, z2 = z * z;
  const d = 1 + z2 / n;
  const c = p + z2 / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { lo: (c - s) / d, hi: (c + s) / d };
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * Медианная волатильность бара по реальным данным. Синтетический контроль обязан
 * дышать так же, как рынок: артефакт от геометрии зависит от размера шага, и
 * GBM с чужой волатильностью померил бы чужой артефакт.
 */
function medianBarVol(series) {
  const vols = [];
  for (const bars of series) {
    const r = [];
    for (let i = 1; i < bars.length; i++) {
      if (bars[i - 1][4] > 0 && bars[i][4] > 0) r.push(Math.log(bars[i][4] / bars[i - 1][4]));
    }
    if (r.length > 50) vols.push(sd(r));
  }
  vols.sort((a, b) => a - b);
  return vols[vols.length >> 1] || 0.008;
}

/** Синтетический GBM: структуры нет по построению. */
function fakeSeries(n, rnd, vol = 0.004) {
  const bars = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    // сумма четырёх шагов внутри бара, чтобы high/low были осмысленными
    let h = o, l = o, c = o;
    for (let k = 0; k < 4; k++) {
      const u = rnd(), v = rnd();
      const g = Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v);
      c = c * (1 + vol * g);
      h = Math.max(h, c); l = Math.min(l, c);
    }
    bars.push([i * 3600_000, o, h, l, c]);
    p = c;
  }
  return bars;
}

function runSet(series, label, rnd) {
  const perCoin = { real: [], time: [], mirror: [], level: [] };
  const pool = { real: [0, 0], time: [0, 0], mirror: [0, 0], level: [0, 0] };
  for (const bars of series) {
    const r = measureCoin(bars, PIVOT, HORIZON, rnd);
    for (const k of MODELS) {
      pool[k][0] += r[k][0]; pool[k][1] += r[k][1];
      if (r[k][1] >= MIN_EVENTS_PER_COIN) perCoin[k].push(r[k][0] / r[k][1]);
    }
  }
  return { label, perCoin, pool };
}

function report(res) {
  const { perCoin, pool } = res;
  console.log(`\n── ${res.label} ──`);
  console.log(`событий: ${pool.real[1]}, монет в ДИ: ${perCoin.real.length}`);
  for (const k of MODELS) {
    if (!pool[k][1]) continue;
    const w = wilson(pool[k][0], pool[k][1]);
    const ci = perCoin[k].length >= 2 ? coinCI(perCoin[k]) : null;
    const ciTxt = ci
      ? `${pct(ci.m)}  [${pct(ci.lo)} … ${pct(ci.hi)}]`
      : "—";
    console.log(
      `  ${k.padEnd(7)} по монетам ${ciTxt.padEnd(28)} пул ${pct(pool[k][0] / pool[k][1])} [${pct(w.lo)}…${pct(w.hi)}]`
    );
  }
  // Разница real−mirror с ДИ: считаем парно по монетам, это самая честная форма.
  return res;
}

/** Парная разница по монетам — для этого нужны обе метрики с одной монеты. */
function pairedDiff(series, rnd, which) {
  const diffs = [];
  for (const bars of series) {
    const r = measureCoin(bars, PIVOT, HORIZON, rnd);
    if (r.real[1] < MIN_EVENTS_PER_COIN || r[which][1] < MIN_EVENTS_PER_COIN) continue;
    diffs.push(r.real[0] / r.real[1] - r[which][0] / r[which][1]);
  }
  if (diffs.length < 2) return null;
  const m = mean(diffs), se = sd(diffs) / Math.sqrt(diffs.length);
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, n: diffs.length };
}

// ── main ──
console.log("═".repeat(70));
console.log("ПРЕДЗАЯВКА");
console.log(`  TF 1h (15m×${AGG}) · свинг L=${PIVOT} · горизонт ретеста ${HORIZON} баров (${HORIZON}ч)`);
console.log(`  проверяемое утверждение: «ретест приходит в 80% случаев»`);
console.log(`  опровергнуто, если 95% ДИ по монетам не накрывает 80%`);
console.log(`  структура засчитана, только если (real − mirror) > артефакта на GBM`);
console.log("═".repeat(70));

// Реальные данные грузим ПЕРВЫМИ: контроль строится под их волатильность.
const files = readdirSync(DIR).filter((f) => f.endsWith(".15m.json.gz"));
const real = [];
for (const f of files) {
  try {
    const p = JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString());
    if (!p.rows || p.rows.length < 400) continue;
    const bars = aggregate(p.rows, AGG);
    if (bars.length < 200) continue;
    real.push(bars);
  } catch { /* битый файл — пропускаем */ }
}
console.log(`\nмонет загружено: ${real.length}, баров 1h на монету ~${Math.round(mean(real.map((b) => b.length)))}`);

// 1. САМОПРОВЕРКА на синтетике без структуры.
// Серий много (FAKE_N) не для красоты: при 120 сериях ДИ артефакта был шире
// самого измеряемого эффекта, и вердикт переворачивался от смены сида контроля.
// Контроль обязан быть точнее того, что им проверяют.
const FAKE_N = 1200;
const barVol = medianBarVol(real);
const rndFake = rng(SEED);
console.log(`контроль: ${FAKE_N} синтетических серий, vol/бар = ${(barVol * 100).toFixed(2)}% (медиана по рынку)`);
const fake = Array.from({ length: FAKE_N }, () => fakeSeries(900, rndFake, barVol / 2));
const fakeRes = report(runSet(fake, "САМОПРОВЕРКА: случайное блуждание (структуры нет по построению)", rng(SEED + 1)));
const fakeMirror = pairedDiff(fake, rng(SEED + 2), "mirror");
const fakeTime = pairedDiff(fake, rng(SEED + 3), "time");
const fakeLevel = pairedDiff(fake, rng(SEED + 4), "level");
console.log(`  артефакт real−mirror: ${fakeMirror ? pct(fakeMirror.m) : "—"}  [${fakeMirror ? pct(fakeMirror.lo) + " … " + pct(fakeMirror.hi) : ""}]`);
console.log(`  артефакт real−time  : ${fakeTime ? pct(fakeTime.m) : "—"}  [${fakeTime ? pct(fakeTime.lo) + " … " + pct(fakeTime.hi) : ""}]`);
console.log(`  артефакт real−level : ${fakeLevel ? pct(fakeLevel.m) : "—"}  [${fakeLevel ? pct(fakeLevel.lo) + " … " + pct(fakeLevel.hi) : ""}]`);

// 2. Реальные данные
const realRes = report(runSet(real, "РЕАЛЬНЫЕ ДАННЫЕ (HL, 15m→1h)", rng(SEED + 10)));
const dMirror = pairedDiff(real, rng(SEED + 11), "mirror");
const dTime = pairedDiff(real, rng(SEED + 12), "time");
const dLevel = pairedDiff(real, rng(SEED + 13), "level");
console.log(`  real−mirror: ${dMirror ? pct(dMirror.m) : "—"}  [${dMirror ? pct(dMirror.lo) + " … " + pct(dMirror.hi) : ""}]  (n=${dMirror?.n})`);
console.log(`  real−time  : ${dTime ? pct(dTime.m) : "—"}  [${dTime ? pct(dTime.lo) + " … " + pct(dTime.hi) : ""}]  (n=${dTime?.n})`);
console.log(`  real−level : ${dLevel ? pct(dLevel.m) : "—"}  [${dLevel ? pct(dLevel.lo) + " … " + pct(dLevel.hi) : ""}]  (n=${dLevel?.n})   ← уровень против «просто откат»`);

// 3. Вердикт по объявленным заранее правилам
console.log("\n" + "═".repeat(70));
console.log("ВЕРДИКТ (по правилам, объявленным до прогона)");
const rCI = coinCI(realRes.perCoin.real);
console.log(`  базрейт ретеста: ${pct(rCI.m)}  95% ДИ [${pct(rCI.lo)} … ${pct(rCI.hi)}]`);
console.log(`  утверждение «80%»: ${rCI.lo <= 0.8 && rCI.hi >= 0.8 ? "НЕ опровергнуто" : "ОПРОВЕРГНУТО"}`);
if (dMirror && fakeMirror) {
  const excess = dMirror.m - fakeMirror.m;
  const structural = dMirror.lo > fakeMirror.hi;
  console.log(`  сверх артефакта (real−mirror): ${pct(excess)} → структура ${structural ? "ЗАСЧИТАНА" : "НЕ засчитана"}`);
}
if (dLevel && fakeLevel) {
  const excess = dLevel.m - fakeLevel.m;
  const structural = dLevel.lo > Math.max(0, fakeLevel.hi);
  console.log(`  сверх артефакта (real−level) : ${pct(excess)} → «важен сам уровень» ${structural ? "ЗАСЧИТАНО" : "НЕ засчитано"}`);
}
console.log("═".repeat(70));
