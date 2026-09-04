// ─────────────────────────────────────────────────
//  adoptExitSweep — перебор правил выхода на реальных adopt-сделках
// ─────────────────────────────────────────────────
// 🚨 Перебрать сетку на своих же сделках и объявить лучшую — это гарантированно
// найти победителя, даже если правила не отличаются ничем. Поэтому протокол
// объявлен ЗАРАНЕЕ, до первого прогона, и записан здесь.
//
// ── ЧТО МЕРЯЕМ ─────────────────────────────────────────────────────────────
// Берём РЕАЛЬНЫЕ входы adopt (вход не трогаем — он и так был), проигрываем по
// минутным свечам, что дало бы каждое АЛЬТЕРНАТИВНОЕ правило выхода.
// Метрика на сделку: чистый % от номинала (ход в свою сторону − 4 бп комиссий).
// Это парное сравнение на одних и тех же входах: разброс режется на порядок
// против сравнения абсолютных доходностей, поэтому мощности хватает там, где на
// «есть ли эдж» её не было бы.
//
// ── КАК СРАВНИВАЕМ (объявлено до результатов) ──────────────────────────────
//  1. Первичная метрика — средний чистый % на сделку.
//  2. Сравнение с ТЕКУЩИМ конфигом (arm 2%, отдача 30%) — парный бутстрап,
// 10 000 ресэмплов, 95% ДИ на РАЗНИЦУ. Абсолютные числа без ДИ результатом
// не считаются.
//  3. Правил в сетке ~35 → множественные сравнения. BH-FDR при q=0.10.
//  4. Холдаут по времени: выборка делится пополам по дате входа. Победитель
//     обязан выигрывать в ОБЕИХ половинах. Это не полноценный out-of-sample
//     (обе половины — один режим рынка), но ловит подгонку под один месяц.
//  5. Нулевые модели в сетке НЕ для украшения: случайный выход и «просто держать
//     сутки» должны проигрывать. Если случайный выход не отличим от лучшего
//     правила — значит меряем шум, и вывод один: НИЧЕГО НЕ МЕНЯТЬ.
//
// ── СТОП-ПРАВИЛО ───────────────────────────────────────────────────────────
// Если после FDR ни одно правило не бьёт текущее с ДИ, не накрывающим ноль, —
// вывод «не подтверждено», настройки остаются как есть. Ответ «оставить как
// было» здесь такой же законный результат, как и смена конфига.
//
// ── ЧЕСТНЫЕ ОГОВОРКИ ───────────────────────────────────────────────────────
//  • Порядок внутри минутной свечи неизвестен. Считаем ПЕССИМИСТИЧНО: сначала
//    ход против позиции, потом в пользу. Значит стопы срабатывают раньше, чем
//    могли бы, — смещение одинаково для всех правил, включая текущее.
//  • Реальные сделки имели свой resting-SL на бирже, в истории он не сохранён.
//    Всем правилам ставим ОДИН жёсткий стоп (--sl, по умолчанию 2%), иначе
//    сравнение будет не про выходы, а про разные стопы.
//  • Проскальзывание выхода не моделируется: все правила получают идеальное
//    исполнение по цене триггера. Правила, срабатывающие часто, от этого
// выигрывают незаслуженно — реальный перелёт съедает центы на сделку.
// Держать в уме при чтении близких результатов.
// • Данных adopt — пара месяцев, а не полгода.
//
// Запуск:
//   node tools/adoptExitSweep.mjs                     # архив из data/
//   node tools/adoptExitSweep.mjs --archive path.json
//   node tools/adoptExitSweep.mjs --sl 3 --window 12  # стоп 3%, окно 12ч

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rng } from "./baseline.mjs";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const ARCHIVE = arg("archive", "data/history_archive.json");
const CACHE_DIR = arg("cache", "data/exit-sweep");
const HARD_SL_PCT = parseFloat(arg("sl", "2"));
const WINDOW_H = parseFloat(arg("window", "24"));
// Разрешение свечей. Hyperliquid держит ~5000 баров на интервал, то есть
// 1m ≈ 3.5 дня назад, 5m ≈ 17 дней, 15m ≈ 52 дня, 1h ≈ 90 дней (замер 15.08).
// Сделки старше глубины интервала просто не имеют пути — и первый прогон
// молча посчитал сетку на 18 сделках из 508, напечатав уверенный вердикт.
// Поэтому: интервал задаётся явно, сделки вне его глубины отсекаются ДО
// прогона, а покрытие проверяется гейтом ниже.
const INTERVAL = arg("interval", "5m");
const DEPTH_DAYS = { "1m": 3.5, "5m": 17.2, "15m": 52.0, "1h": 89.6 };
const BAR_MIN = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 }[INTERVAL];
// Меньше этого числа баров на сделку — правило выхода не разрешается по
// времени, и сравнение превращается в сравнение округлений.
const MIN_BARS = 5;
const FEE_BP = 4; // taker обе стороны, 2 бп × 2 (сверено с fee_paid по CASHCAT)
const BOOTSTRAP = 10_000;
const FDR_Q = 0.10;

// ── Загрузка сделок ────────────────────────────────────────────────────────
function loadTrades() {
  const raw = JSON.parse(readFileSync(ARCHIVE, "utf8"));
  const all = Array.isArray(raw) ? raw : raw.trades || [];
  return all
    .filter(
      (r) =>
        r.strategy_id === "adopt" &&
        r.mode === "PRODUCTION" &&
        r.entry_time > 0 &&
        r.entry_price > 0 &&
        r.close_price > 0 &&
        r.close_price !== r.entry_price,
    )
    .map((r) => {
      const isShort = (r.side || "short") === "short";
      // Размер в истории не сохранён — восстанавливаем из факта:
      // pnl + fee = qty × (движение цены в пользу позиции).
      const move = isShort ? r.entry_price - r.close_price : r.close_price - r.entry_price;
      const qty = (r.realized_pnl + (r.fee_paid || 0)) / move;
      return {
        coin: r.coin,
        isShort,
        entry: r.entry_price,
        entryTime: r.entry_time,
        actualPct: (move / r.entry_price) * 100 - FEE_BP / 100,
        notional: qty * r.entry_price,
        reason: r.reason,
      };
    })
    .filter((t) => Number.isFinite(t.actualPct) && t.notional > 0 && t.notional < 1000)
    // Глубина истории интервала — жёсткая граница. Сделки старше неё выкидываем
    // явно и считаем, сколько выкинули: молчаливая потеря выборки здесь опаснее
    // любого результата.
    .filter((t) => t.entryTime >= Date.now() - DEPTH_DAYS[INTERVAL] * 86400_000)
    .sort((a, b) => a.entryTime - b.entryTime);
}

// ── Свечи ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCandles(coin, startTime, endTime) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${coin}-${startTime}.json`);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* битый кэш — перекачаем */
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "candleSnapshot",
          req: { coin, interval: INTERVAL, startTime, endTime },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = (Array.isArray(data) ? data : []).map((k) => ({
        t: k.t,
        h: parseFloat(k.h),
        l: parseFloat(k.l),
        c: parseFloat(k.c),
      }));
      // Пустой ответ в кэш НЕ пишем: он неотличим от «ещё не качали», а
      // закэшированная пустота — это ровно то, что превратило 508 сделок в 18.
      if (rows.length) writeFileSync(file, JSON.stringify(rows));
      // Пауза всегда после сетевого запроса. Раньше стояла под условием
      // «файла нет», но файл к этому месту уже записан — пауза не срабатывала
      // никогда, и API отвечал 429.
      await sleep(140);
      return rows;
    } catch (err) {
      if (attempt === 2) {
        console.error(`  ! ${coin}: ${err.message}`);
        return [];
      }
      await sleep(1200 * (attempt + 1));
    }
  }
  return [];
}

/**
 * Путь сделки в «процентах в пользу позиции». fav = лучшее, что было в свече,
 * adv = худшее. Для шорта верх и низ меняются местами.
 * Порядок внутри свечи неизвестен → adv считаем случившимся первым.
 */
function toPath(trade, candles) {
  const { entry, isShort } = trade;
  return candles.map((k) => ({
    t: k.t,
    fav: ((isShort ? entry - k.l : k.h - entry) / entry) * 100,
    adv: ((isShort ? entry - k.h : k.l - entry) / entry) * 100,
    close: ((isShort ? entry - k.c : k.c - entry) / entry) * 100,
    range: ((k.h - k.l) / entry) * 100,
  }));
}

// ── Правила выхода ─────────────────────────────────────────────────────────
// Каждое: (path) → { pct, minute, why }. Жёсткий стоп и конец окна добавляются
// снаружи, одинаково для всех, чтобы сравнение было про выход, а не про стоп.
function withGuards(rule) {
  return (path) => {
    const own = rule(path);
    // Жёсткий стоп проверяем на каждой свече ДО срабатывания правила.
    const limit = own ? own.minute : path.length - 1;
    for (let i = 0; i <= limit && i < path.length; i++) {
      if (path[i].adv <= -HARD_SL_PCT) return { pct: -HARD_SL_PCT, minute: i, why: "hard_sl" };
    }
    if (own) return own;
    const last = path[path.length - 1];
    return { pct: last.close, minute: path.length - 1, why: "window_end" };
  };
}

const trailRule = (armPct, gbPct, bePct = null) =>
  withGuards((path) => {
    let peak = 0;
    let beArmed = false;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      // BE-храповик: взводится по пику, режет по откату к нулю.
      if (bePct != null && peak >= bePct) beArmed = true;
      if (beArmed && p.adv <= 0) return { pct: 0, minute: i, why: "be" };
      if (peak >= armPct) {
        const floor = peak * (1 - gbPct / 100);
        if (p.adv <= floor) return { pct: floor - FEE_BP / 100, minute: i, why: "trail" };
      }
      if (p.fav > peak) peak = p.fav;
    }
    return null;
  });

// Chandelier: отступ от пика в единицах волатильности, а не в долях пика.
// ATR тут — EWMA размаха минутной свечи в % (тиковых баров у нас нет).
const chandelierRule = (mult, armPct = 1) =>
  withGuards((path) => {
    let peak = 0;
    let atr = null;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      atr = atr == null ? p.range : 0.8 * atr + 0.2 * p.range;
      if (peak >= armPct && atr > 0) {
        const floor = peak - mult * atr;
        if (p.adv <= floor) return { pct: floor - FEE_BP / 100, minute: i, why: "chandelier" };
      }
      if (p.fav > peak) peak = p.fav;
    }
    return null;
  });

// ── Другие семейства трейла ────────────────────────────────────────────────
// Сетка arm×отдача — это ОДНО правило с разными числами. Ниже правила, устроенные
// принципиально иначе. Добавлены 15.08 по запросу оператора («сэмулировать другую
// стратегию трейла»). Каждое отвечает на свою претензию к текущему.

// ФИКСИРОВАННЫЙ ОТСТУП. Претензия: отдача в долях пика при маленьком пике даёт
// микроскопический буфер (пик 2% → буфер 0.6%), и правило вылетает на шуме.
// Здесь отступ от пика постоянный в процентных пунктах и от размера пика не
// зависит: пока пик мал, стоп стоит дальше, а не ближе.
const fixedDistTrail = (armPct, distPct) =>
  withGuards((path) => {
    let peak = 0;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (peak >= armPct) {
        const floor = peak - distPct;
        if (p.adv <= floor) return { pct: floor - FEE_BP / 100, minute: i, why: "fixed_dist" };
      }
      if (p.fav > peak) peak = p.fav;
    }
    return null;
  });

// ТРЕЙЛ В ЕДИНИЦАХ РИСКА. Отступ = k × исходный риск сделки. Тот же смысл, что
// у R-мультипликатора в журнале: сделка меряется своим стопом, а не абсолютным %.
const rTrail = (armR, kR) =>
  withGuards((path) => {
    const risk = HARD_SL_PCT;
    let peak = 0;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (peak >= armR * risk) {
        const floor = peak - kR * risk;
        if (p.adv <= floor) return { pct: floor - FEE_BP / 100, minute: i, why: "r_trail" };
      }
      if (p.fav > peak) peak = p.fav;
    }
    return null;
  });

// СТУПЕНЧАТЫЙ ХРАПОВИК. Пол не ползёт непрерывно, а щёлкает по вехам и назад не
// ходит. Между вехами позиция дышит свободно — лечит «выбило на первом же шуме».
// steps: [[пик достиг, пол встал на], ...] — по возрастанию.
const stepRatchet = (steps) =>
  withGuards((path) => {
    let peak = 0;
    let floor = null;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (floor != null && p.adv <= floor)
        return { pct: floor - FEE_BP / 100, minute: i, why: "ratchet" };
      if (p.fav > peak) {
        peak = p.fav;
        for (const [at, to] of steps) if (peak >= at) floor = Math.max(floor ?? -Infinity, to);
      }
    }
    return null;
  });

// ПЛАНКА, ПАДАЮЩАЯ СО ВРЕМЕНЕМ. Сделке даётся окно на большой профит; не доехала
// — порог опускается, забираем что есть. Уже живёт в hunterShadowExits как
// TIME-DECAY TP; здесь та же идея на adopt-сделках.
// schedule: [[до N-й минуты, целевой профит%], ...]
const timeDecayTp = (schedule) =>
  withGuards((path) => {
    for (let i = 0; i < path.length; i++) {
      const min = (i * BAR_MIN);
      let target = schedule[schedule.length - 1][1];
      for (const [mm, tp] of schedule)
        if (min <= mm) { target = tp; break; }
      if (path[i].fav >= target) return { pct: target - FEE_BP / 100, minute: i, why: "decay_tp" };
    }
    return null;
  });

// ЗАТЯГИВАЮЩИЙСЯ ТРЕЙЛ. Отдача сжимается по мере роста пика: пока ход мал, даём
// дышать, когда прибыль крупная — держим коротко. Ровно обратное текущему
// правилу, где буфер в пунктах РАСТЁТ вместе с пиком.
const tighteningTrail = (armPct, gbAtArm, gbFar, farPct) =>
  withGuards((path) => {
    let peak = 0;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (peak >= armPct) {
        const k = Math.min(1, Math.max(0, (peak - armPct) / (farPct - armPct)));
        const gb = gbAtArm + (gbFar - gbAtArm) * k;
        const floor = peak * (1 - gb / 100);
        if (p.adv <= floor) return { pct: floor - FEE_BP / 100, minute: i, why: "tightening" };
      }
      if (p.fav > peak) peak = p.fav;
    }
    return null;
  });

// ЧАСТИЧНЫЙ ВЫХОД. Половина снимается на цели, остаток идёт под трейл. Меняет
// не момент выхода, а ФОРМУ выплаты — единственное правило в сетке, которое
// вообще не сводится к «когда закрыть всё».
const scaleOut = (tpPct, armPct, gbPct, part = 0.5) => (path) => {
  const rest = trailRule(armPct, gbPct, 1.5);
  // До цели ведём себя как обычный трейл (включая жёсткий стоп).
  let hit = -1;
  for (let i = 0; i < path.length; i++) {
    if (path[i].adv <= -HARD_SL_PCT) break;
    if (path[i].fav >= tpPct) { hit = i; break; }
  }
  if (hit < 0) return rest(path);
  const tail = rest(path.slice(hit));
  return {
    pct: part * (tpPct - FEE_BP / 100) + (1 - part) * tail.pct,
    minute: hit + tail.minute,
    why: "scale_out",
  };
};

const fixedTpRule = (tpPct) =>
  withGuards((path) => {
    for (let i = 0; i < path.length; i++) {
      if (path[i].fav >= tpPct) return { pct: tpPct - FEE_BP / 100, minute: i, why: "tp" };
    }
    return null;
  });

const timeStopRule = (minutes) =>
  withGuards((path) => {
    const i = Math.min(minutes, path.length - 1);
    return { pct: path[i].close - FEE_BP / 100, minute: i, why: "time" };
  });

// Нулевая модель: выход в случайную минуту окна. Если её не бьют — меряем шум.
const randomRule = (seed) => {
  const rand = rng(seed);
  return withGuards((path) => {
    const i = Math.floor(rand() * path.length);
    return { pct: path[i].close - FEE_BP / 100, minute: i, why: "random" };
  });
};

const RULES = [];
for (const arm of [1, 2, 3, 5, 8])
  for (const gb of [20, 30, 40, 50, 60])
    RULES.push({ name: `трейл arm ${arm}% / отдача ${gb}%`, fn: trailRule(arm, gb, 1.5), family: "trail", arm, gb });
for (const m of [2, 3, 4, 6]) RULES.push({ name: `chandelier ${m}×ATR`, fn: chandelierRule(m), family: "chandelier" });
// Другие семейства трейла (добавлены 15.08). Правил в сетке стало больше, значит
// поправка FDR стала строже — это цена вопроса «а если попробовать вот так», и
// платить её обязательно, иначе новые правила получают фору перед старыми.
for (const d of [0.5, 1, 1.5, 2, 3])
  RULES.push({ name: `отступ фикс ${d}пп (arm 1%)`, fn: fixedDistTrail(1, d), family: "fixed_dist" });
for (const k of [0.25, 0.5, 1])
  RULES.push({ name: `трейл ${k}R (arm 1R)`, fn: rTrail(1, k), family: "r_trail" });
RULES.push({
  name: "храповик 1→БУ, 2→1, 4→2.5",
  fn: stepRatchet([[1, 0], [2, 1], [4, 2.5], [8, 5.5]]),
  family: "ratchet",
});
RULES.push({
  name: "храповик 2→БУ, 4→2, 8→5",
  fn: stepRatchet([[2, 0], [4, 2], [8, 5]]),
  family: "ratchet",
});
RULES.push({
  name: "планка падает 3%→0.5% за 2ч",
  fn: timeDecayTp([[15, 3], [30, 2], [60, 1], [120, 0.5]]),
  family: "decay",
});
RULES.push({
  name: "затяг. отдача 60%→20% к 8%",
  fn: tighteningTrail(1, 60, 20, 8),
  family: "tightening",
});
RULES.push({
  name: "затяг. отдача 50%→25% к 5%",
  fn: tighteningTrail(1, 50, 25, 5),
  family: "tightening",
});
for (const tp of [1, 2])
  RULES.push({
    name: `половина на +${tp}%, остаток трейл`,
    fn: scaleOut(tp, 2, 30),
    family: "scale_out",
  });
for (const tp of [1, 2, 3, 5]) RULES.push({ name: `фикс TP ${tp}%`, fn: fixedTpRule(tp), family: "tp" });
for (const mm of [15, 60, 240, 1440]) RULES.push({ name: `тайм-стоп ${mm}м`, fn: timeStopRule(mm), family: "time" });
RULES.push({ name: "БАЗА: случайный выход", fn: randomRule(20260815), family: "baseline" });
RULES.push({ name: "БАЗА: держать всё окно", fn: withGuards(() => null), family: "baseline" });

const CURRENT = "трейл arm 2% / отдача 30%";

// ── Статистика ─────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/** Парный бутстрап разницы (rule − current). Возвращает ДИ и двусторонний p. */
function pairedBootstrap(diffs, seed = 777) {
  const rand = rng(seed);
  const n = diffs.length;
  const obs = mean(diffs);
  const boot = new Array(BOOTSTRAP);
  for (let b = 0; b < BOOTSTRAP; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[(rand() * n) | 0];
    boot[b] = s / n;
  }
  boot.sort((a, b) => a - b);
  const lo = boot[Math.floor(BOOTSTRAP * 0.025)];
  const hi = boot[Math.floor(BOOTSTRAP * 0.975)];
  // p через сдвиг распределения к нулю (bootstrap-t упрощённо).
  const centered = boot.map((x) => x - obs);
  const extreme = centered.filter((x) => Math.abs(x) >= Math.abs(obs)).length;
  return { obs, lo, hi, p: (extreme + 1) / (BOOTSTRAP + 1) };
}

/** BH-FDR: возвращает Set имён, прошедших при q. */
function bhFdr(entries, q) {
  const sorted = [...entries].sort((a, b) => a.p - b.p);
  const m = sorted.length;
  let kMax = -1;
  for (let i = 0; i < m; i++) if (sorted[i].p <= ((i + 1) / m) * q) kMax = i;
  return new Set(sorted.slice(0, kMax + 1).map((e) => e.name));
}

// ── Прогон ─────────────────────────────────────────────────────────────────
async function main() {
  const trades = loadTrades();
  console.log(`\n  Сделок adopt (PRODUCTION, пригодных): ${trades.length}`);
  console.log(
    `  Период: ${new Date(trades[0].entryTime).toISOString().slice(0, 10)} → ` +
      `${new Date(trades[trades.length - 1].entryTime).toISOString().slice(0, 10)}`,
  );
  console.log(`  Окно ${WINDOW_H}ч, жёсткий стоп −${HARD_SL_PCT}%, комиссии ${FEE_BP} бп\n`);

  const paths = [];
  let done = 0;
  let noData = 0;
  for (const t of trades) {
    const end = t.entryTime + WINDOW_H * 3600_000;
    const candles = await fetchCandles(t.coin, t.entryTime, end);
    done++;
    if (done % 25 === 0) process.stdout.write(`  свечи: ${done}/${trades.length}\r`);
    if (candles.length < MIN_BARS) {
      noData++;
      continue;
    }
    paths.push({ trade: t, path: toPath(t, candles) });
  }
  const coverage = paths.length / trades.length;
  console.log(
    `  свечи: путей ${paths.length}/${trades.length} ` +
      `(${(coverage * 100).toFixed(0)}% покрытия, без данных ${noData})          \n`,
  );

  // ── ГЕЙТ ПОКРЫТИЯ ────────────────────────────────────────────────────────
  // Прибор обязан молчать, когда мерить не на чем. Первый прогон 15.08 посчитал
  // всю сетку на 18 сделках из 508 и напечатал уверенный вердикт «ничего не
  // менять» — правильный по форме и пустой по существу. Такое не должно
  // повторяться: лучше отказ, чем красивая таблица ни о чём.
  const holdBars = paths
    .map((p) => p.path.length)
    .sort((a, b) => a - b);
  const medBars = holdBars[Math.floor(holdBars.length / 2)] ?? 0;
  const problems = [];
  if (paths.length < 50) problems.push(`сделок с путём ${paths.length} < 50`);
  if (coverage < 0.6) problems.push(`покрытие ${(coverage * 100).toFixed(0)}% < 60%`);
  if (medBars < MIN_BARS * 2)
    problems.push(`медиана длины пути ${medBars} баров — правило выхода не разрешается по времени`);
  if (problems.length) {
    console.log("  ── ОТКАЗ СЧИТАТЬ ────────────────────────────────────────");
    for (const p of problems) console.log(`  • ${p}`);
    console.log(
      `\n  Интервал ${INTERVAL} держится ${DEPTH_DAYS[INTERVAL]} дней назад.\n` +
        "  Более грубый интервал даёт больше сделок, но меньше баров на сделку —\n" +
        "  при медиане удержания ~30 мин это обмен одной непригодности на другую.\n" +
        "  Вывод: вопрос не решается на том, что хранит биржа. Нужен собственный\n" +
        "  лог пути позиции (бот и так осматривает позы каждые 2 с).\n",
    );
    process.exit(2);
  }

  // Результат каждого правила на каждой сделке.
  const results = new Map();
  for (const r of RULES) results.set(r.name, paths.map((p) => r.fn(p.path).pct));
  const actual = paths.map((p) => p.trade.actualPct);
  const cur = results.get(CURRENT);

  // Холдаут по времени.
  const half = Math.floor(paths.length / 2);
  const idxA = [...Array(half).keys()];
  const idxB = [...Array(paths.length - half).keys()].map((i) => i + half);
  const sub = (arr, idx) => idx.map((i) => arr[i]);

  const rows = [];
  for (const r of RULES) {
    const v = results.get(r.name);
    const diffs = v.map((x, i) => x - cur[i]);
    const bs = r.name === CURRENT ? { obs: 0, lo: 0, hi: 0, p: 1 } : pairedBootstrap(diffs);
    rows.push({
      name: r.name,
      family: r.family,
      mean: mean(v),
      total: v.reduce((s, x, i) => s + (x / 100) * paths[i].trade.notional, 0),
      diff: bs.obs,
      lo: bs.lo,
      hi: bs.hi,
      p: bs.p,
      halfA: mean(sub(diffs, idxA)),
      halfB: mean(sub(diffs, idxB)),
    });
  }

  const passed = bhFdr(
    rows.filter((r) => r.name !== CURRENT),
    FDR_Q,
  );

  rows.sort((a, b) => b.mean - a.mean);
  console.log(`  ФАКТ (как торговал бот): ${mean(actual).toFixed(3)}% на сделку\n`);
  console.log("  правило                        ср.%   Δк тек.   95% ДИ разницы      p     половины   FDR");
  console.log("  " + "─".repeat(97));
  for (const r of rows) {
    const isCur = r.name === CURRENT;
    const halves = isCur ? "     —     " : `${r.halfA >= 0 ? "+" : ""}${r.halfA.toFixed(2)}/${r.halfB >= 0 ? "+" : ""}${r.halfB.toFixed(2)}`;
    console.log(
      `  ${(isCur ? "▶ " : "  ") + r.name.padEnd(29)}` +
        `${r.mean.toFixed(3).padStart(6)} ` +
        `${(isCur ? "—" : (r.diff >= 0 ? "+" : "") + r.diff.toFixed(3)).padStart(8)} ` +
        `${(isCur ? "" : `[${r.lo >= 0 ? "+" : ""}${r.lo.toFixed(3)} … ${r.hi >= 0 ? "+" : ""}${r.hi.toFixed(3)}]`).padStart(20)} ` +
        `${(isCur ? "" : r.p.toFixed(3)).padStart(6)} ` +
        `${halves.padStart(12)}  ` +
        `${isCur ? "" : passed.has(r.name) ? "✓" : "·"}`,
    );
  }

  // ── Вердикт по объявленному стоп-правилу ─────────────────────────────────
  const winners = rows.filter(
    (r) => r.name !== CURRENT && r.family !== "baseline" && r.lo > 0 && passed.has(r.name),
  );
  const stable = winners.filter((r) => r.halfA > 0 && r.halfB > 0);
  const bestBaseline = Math.max(...rows.filter((r) => r.family === "baseline").map((r) => r.diff));

  console.log("\n  ── Вердикт по протоколу ─────────────────────────────────");
  console.log(`  Лучшая нулевая модель даёт Δ = ${bestBaseline >= 0 ? "+" : ""}${bestBaseline.toFixed(3)}пп к текущему`);
  if (!winners.length) {
    console.log("  Ни одно правило не бьёт текущее (ДИ > 0 + FDR). НИЧЕГО НЕ МЕНЯЕМ.");
  } else if (!stable.length) {
    console.log(`  ${winners.length} правил прошли FDR, но НИ ОДНО не выигрывает в обеих половинах.`);
    console.log("  Это подгонка под период. НИЧЕГО НЕ МЕНЯЕМ.");
  } else {
    console.log(`  Прошли всё (ДИ > 0, FDR, обе половины): ${stable.length}`);
    for (const r of stable.slice(0, 5))
      console.log(`    ${r.name}: +${r.diff.toFixed(3)}пп [${r.lo.toFixed(3)} … ${r.hi.toFixed(3)}], половины ${r.halfA.toFixed(2)}/${r.halfB.toFixed(2)}`);
    if (bestBaseline > 0)
      console.log("  ⚠️ Нулевая модель тоже бьёт текущее — значит текущее плохо, а не найденное хорошо.");
  }
  console.log("");
}

main();
