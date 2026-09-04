#!/usr/bin/env node
// ─────────────────────────────────────────────────
//  winners — предзаявленный форвардный тест «есть ли те, кто стабильно в плюсе»
// ─────────────────────────────────────────────────
//
//   node tools/winners.mjs select   # заморозить список кандидатов (делается ОДИН раз)
//   node tools/winners.mjs track    # посчитать, что с ними стало
//
// Зачем ещё один заход после исследования 03.08. Тогда мерились МЕДИАНЫ ПО
// ДЕЦИЛЯМ — все отрицательные, топ-дециль −5.4 бп. Но дециль это 4100 адресов,
// и медиана группы ничего не говорит о трёх лучших людях внутри неё. Вопрос
// «а если взять не тысячу, а двух-трёх?» этим исследованием НЕ закрыт.
//
// Почему его нельзя решить по прошлому. Выбирая лучших из 38 тысяч, выбираешь
// из хвоста, где шум сильнее умения: даже при полном отсутствии мастерства
// кто-то покажет блестящую историю случайно. Отличить умение от везения можно
// только по будущему — и только если список зафиксирован ЗАРАНЕЕ.
//
// Поэтому здесь всё построено вокруг одной вещи: критерии и список пишутся
// в файл до наблюдения, файл коммитится, и дальше его нельзя трогать. Иначе
// через месяц появится соблазн «уточнить фильтр» — и тест превратится
// в подгонку.

import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = join(ROOT, "data", "leaderboard");
const FREEZE_FILE = join(ROOT, "docs", "winners-preregistration.json");
const RESULT_FILE = join(ROOT, "data", "winners-forward.json");

// ─── предзаявленные правила (менять нельзя после select) ────────────────────

export const RULES = {
  // Отбор идёт среди тех, у кого счёт и оборот делают результат осмысленным.
  // Фильтры механические — по размеру и активности, НЕ по прибыли: отбор по
  // результату внутри фильтра сломал бы весь тест.
  minAccountValue: 100_000,      // $ — не микросчёт, которому повезло трижды
  minAllTimeVolume: 10_000_000,  // $ — наторговал достаточно, чтобы PnL не был случайностью
  minMonthVolume: 1_000_000,     // $ — активен сейчас, а не легенда прошлого года

  // 🚨 Оборот к размеру счёта. Первая версия этого фильтра не имела, и отбор
  // выдал три счёта, прокрутивших депозит 0.4–1 раз за месяц при доходности
  // 35–114%. Это не торговля, это ДЕРЖАНИЕ: лидерборд HL считает PnL вместе
  // с плавающей прибылью открытых позиций, поэтому «купил и сидит в лонге на
  // растущем рынке» выглядит как гениальный трейдер. Ровно та бета, которая
  // уже обманула нас в истории с нянькой.
  minTurnover: 5,                // оборот за месяц ≥ 5 размеров счёта

  // Тот же предохранитель с другой стороны: 100 бп это 1% от оборота, и это
  // уже очень много. Всё, что выше, почти наверняка нереализованная прибыль,
  // а не заработок на сделках.
  maxPlausibleEdgeBp: 100,

  // Сигнал отбора: эдж в базисных пунктах = прибыль / оборот × 10000.
  // Требуется положительный эдж В ДВУХ окнах сразу — за месяц (их данные)
  // и за наши снимки. Одно окно = один режим рынка = n=1.
  requirePositiveBoth: true,

  k: 3,                          // сколько адресов берём в основную ставку
  kWide: 10,                     // и более широкий список для контроля

  // Горизонт. Юзер спрашивал про две недели — их недостаточно, но промежуточный
  // взгляд полезен, поэтому объявлены обе даты, и роль каждой названа заранее.
  interimDays: 14,               // «посмотреть», решения НЕ принимает
  decisionDays: 90,              // решает

  // Что считаем успехом на горизонте решения:
  // 1) медианный форвардный эдж выбранных > медианы контрольной группы
  //    (те же фильтры, но не выбранные) — то есть отбор что-то значил;
  // 2) и он положителен в абсолюте больше чем на 10 бп — потому что при
  //    выборе 3 из 38 000 маленький плюс неотличим от везения.
  successEdgeBp: 10,
};

// ─── чтение снимков ─────────────────────────────────────────────────────────

const COL = { addr: 0, account: 1, monthPnl: 8, monthRoi: 9, monthVlm: 10, allPnl: 11, allRoi: 12, allVlm: 13 };

function listSnapshots() {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  return readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json.gz")).sort();
}

function loadSnapshot(file) {
  const json = JSON.parse(gunzipSync(readFileSync(join(SNAPSHOT_DIR, file))));
  const map = new Map();
  for (const r of json.rows) map.set(r[COL.addr], r);
  return { date: file.slice(0, 10), capturedAt: json.capturedAt, map, rows: json.rows };
}

/** Эдж в базисных пунктах между двумя снимками. null — торговли не было. */
function forwardEdgeBp(from, to, addr) {
  const a = from.map.get(addr);
  const b = to.map.get(addr);
  if (!a || !b) return null;
  const dVlm = b[COL.allVlm] - a[COL.allVlm];
  if (dVlm <= 0) return null;
  const dPnl = b[COL.allPnl] - a[COL.allPnl];
  return { edgeBp: (dPnl / dVlm) * 10_000, pnl: dPnl, volume: dVlm };
}

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ─── режим select: заморозка ────────────────────────────────────────────────

function select() {
  if (existsSync(FREEZE_FILE)) {
    console.log(`\n  ✗ список уже заморожен: ${FREEZE_FILE}`);
    console.log("    Это сделано намеренно: переотбор превращает форвардный тест в подгонку.");
    console.log("    Нужен новый тест — заводи новый файл с новой датой и новыми правилами.\n");
    process.exit(1);
  }

  const files = listSnapshots();
  if (files.length < 2) {
    console.log("\n  ✗ нужно минимум два снимка лидерборда\n");
    process.exit(1);
  }

  const first = loadSnapshot(files[0]);
  const last = loadSnapshot(files[files.length - 1]);

  const pool = [];
  for (const row of last.rows) {
    const addr = row[COL.addr];
    if (row[COL.account] < RULES.minAccountValue) continue;
    if (row[COL.allVlm] < RULES.minAllTimeVolume) continue;
    if (row[COL.monthVlm] < RULES.minMonthVolume) continue;

    const turnover = row[COL.monthVlm] / row[COL.account];
    if (turnover < RULES.minTurnover) continue;

    const monthEdgeBp = (row[COL.monthPnl] / row[COL.monthVlm]) * 10_000;
    if (monthEdgeBp > RULES.maxPlausibleEdgeBp) continue;

    const window = forwardEdgeBp(first, last, addr);
    if (!window) continue;
    if (window.edgeBp > RULES.maxPlausibleEdgeBp) continue;
    if (RULES.requirePositiveBoth && !(monthEdgeBp > 0 && window.edgeBp > 0)) continue;

    pool.push({
      address: addr,
      accountValue: row[COL.account],
      monthEdgeBp,
      monthPnl: row[COL.monthPnl],
      monthVolume: row[COL.monthVlm],
      windowEdgeBp: window.edgeBp,
      turnover,
      allTimeVolume: row[COL.allVlm],
    });
  }

  // Ранжируем по месячному эджу: окно снимков короче и шумнее, оно работает
  // как фильтр согласия, а не как основной сигнал.
  pool.sort((a, b) => b.monthEdgeBp - a.monthEdgeBp);

  const selected = pool.slice(0, RULES.k);
  const wide = pool.slice(0, RULES.kWide);

  // Контроль: прошли те же фильтры, но в список не попали. Сравнение идёт
  // с ними, а не с нулём — иначе мы измерим не отбор, а рынок целиком.
  const controlPool = pool.slice(RULES.kWide).map((p) => p.address);

  const freeze = {
    frozenAt: new Date().toISOString(),
    selectionSnapshots: { from: first.date, to: last.date, count: files.length },
    rules: RULES,
    poolSize: pool.length,
    selected: selected.map((s) => ({ ...s })),
    wide: wide.map((s) => s.address),
    control: controlPool,
    interimDate: new Date(Date.now() + RULES.interimDays * 864e5).toISOString().slice(0, 10),
    decisionDate: new Date(Date.now() + RULES.decisionDays * 864e5).toISOString().slice(0, 10),
  };

  mkdirSync(dirname(FREEZE_FILE), { recursive: true });
  writeFileSync(FREEZE_FILE, JSON.stringify(freeze, null, 2));

  console.log(`\n  заморожено: ${files.length} снимков, ${first.date} → ${last.date}`);
  console.log(`  прошли фильтры и оба окна в плюс: ${pool.length} адресов из ${last.rows.length}`);
  console.log(`\n  выбраны ${RULES.k}:`);
  for (const s of selected) {
    console.log(`    ${s.address}`);
    console.log(`      счёт $${(s.accountValue / 1e6).toFixed(2)}М · эдж за месяц ${s.monthEdgeBp.toFixed(1)} бп · за окно снимков ${s.windowEdgeBp.toFixed(1)} бп`);
  }
  console.log(`\n  контрольная группа: ${controlPool.length} адресов (те же фильтры, не выбраны)`);
  console.log(`  промежуточный взгляд: ${freeze.interimDate} (не решает)`);
  console.log(`  дата решения:         ${freeze.decisionDate}\n`);
}

// ─── режим track: что стало ─────────────────────────────────────────────────

function track({ quiet = false } = {}) {
  if (!existsSync(FREEZE_FILE)) {
    console.log("\n  ✗ список не заморожен, сначала: node tools/winners.mjs select\n");
    process.exit(1);
  }
  const freeze = JSON.parse(readFileSync(FREEZE_FILE, "utf8"));
  const files = listSnapshots();

  // 🚨 Без двух снимков считать нечего. Раньше здесь был TypeError из join(undefined):
  // 28.08.2026 сбор лидерборда сняли при чистке лаборатории, не заметив, что от него
  // кормится ЖИВОЙ предзаявленный тест, и крон пять дней падал в лог, куда никто
  // не смотрел. Падение молчит громче, чем внятный отказ.
  if (files.length < 2) {
    console.log(
      `\n  ✗ снимков лидерборда ${files.length} — форвард считать не из чего.` +
        "\n    Собирает их node tools/leaderboardSnapshot.mjs (крон 03:00), считаем мы после.\n",
    );
    process.exit(1);
  }

  // Форвард считается ОТ снимка, на котором заморозили, а не от первого.
  const startFile = files.find((f) => f.startsWith(freeze.selectionSnapshots.to));
  // 🚨 Снимка заморозки может не быть на диске — ряд 12.08→28.08 удалён вместе
  // со сбором и в бэкап не входил, восстановить его нечем. Тогда честный ход
  // один: считать от первого уцелевшего снимка и НАЗВАТЬ разрыв в результате,
  // а не делать вид, что окно непрерывно. Дата решения при этом не двигается:
  // сдвигать её под то, как легли данные, — это уже подгонка.
  const gap = !startFile;
  const start = loadSnapshot(startFile ?? files[0]);
  const now = loadSnapshot(files[files.length - 1]);

  const days = (now.capturedAt - start.capturedAt) / 864e5;

  const measure = (addresses) => {
    const rows = [];
    for (const addr of addresses) {
      const f = forwardEdgeBp(start, now, addr);
      if (f) rows.push({ address: addr, ...f });
    }
    return rows;
  };

  const selectedRows = measure(freeze.selected.map((s) => s.address));
  const controlRows = measure(freeze.control);

  const selectedMedian = median(selectedRows.map((r) => r.edgeBp));
  const controlMedian = median(controlRows.map((r) => r.edgeBp));

  const result = {
    computedAt: new Date().toISOString(),
    frozenAt: freeze.frozenAt,
    from: start.date,
    to: now.date,
    // Разрыв ряда виден прямо в результате: витрина обязана показать его рядом
    // с цифрами, иначе «форвард 70 дней» прочитается как непрерывное наблюдение.
    gap: gap || undefined,
    gapNote: gap
      ? `ряд прерван: снимки ${freeze.selectionSnapshots.to}→2026-08-28 удалены 28.08.2026 вместе со сбором, наблюдение возобновлено ${start.date}`
      : undefined,
    days: Math.round(days * 10) / 10,
    interimDate: freeze.interimDate,
    decisionDate: freeze.decisionDate,
    decided: new Date() >= new Date(freeze.decisionDate),
    selected: freeze.selected.map((s) => {
      const row = selectedRows.find((r) => r.address === s.address);
      return {
        address: s.address,
        selectionEdgeBp: Math.round(s.monthEdgeBp * 10) / 10,
        forwardEdgeBp: row ? Math.round(row.edgeBp * 10) / 10 : null,
        forwardPnl: row ? Math.round(row.pnl) : null,
        forwardVolume: row ? Math.round(row.volume) : null,
      };
    }),
    selectedMedianBp: selectedMedian === null ? null : Math.round(selectedMedian * 10) / 10,
    controlMedianBp: controlMedian === null ? null : Math.round(controlMedian * 10) / 10,
    controlCount: controlRows.length,
    successEdgeBp: freeze.rules.successEdgeBp,
  };

  // Вердикт выносится только на дату решения. До неё — «рано», и это не
  // формальность: на коротком окне разброс перекрывает любой эффект.
  //
  // 🚨 В ФАЙЛ пишем по-английски: этот же объект читает дашборд, а интерфейс
  // там английский — русское «рано» вылезало в шапке карточки как
  // «verdict: рано». В консоли ниже вердикт по-прежнему по-русски.
  result.verdict = !result.decided
    ? "too early"
    : (selectedMedian !== null && controlMedian !== null &&
       selectedMedian > controlMedian && selectedMedian > freeze.rules.successEdgeBp)
      ? "confirmed"
      : "not confirmed";

  mkdirSync(dirname(RESULT_FILE), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  if (quiet) return result;

  console.log(`\n  форвард ${result.from} → ${result.to} (${result.days} дн.)\n`);
  if (gap) console.log(`  ⚠️  ${result.gapNote}\n`);
  for (const s of result.selected) {
    const fwd = s.forwardEdgeBp === null ? "не торговал" : `${s.forwardEdgeBp > 0 ? "+" : ""}${s.forwardEdgeBp} бп`;
    console.log(`    ${s.address.slice(0, 10)}…  отобран на ${s.selectionEdgeBp} бп  →  сейчас ${fwd}`);
  }
  console.log(`\n  медиана выбранных:   ${result.selectedMedianBp ?? "—"} бп`);
  console.log(`  медиана контроля:    ${result.controlMedianBp ?? "—"} бп  (${result.controlCount} адресов)`);
  const VERDICT_RU = { "too early": "рано", confirmed: "подтверждено", "not confirmed": "не подтверждено" };
  console.log(`  вердикт: ${VERDICT_RU[result.verdict] ?? result.verdict}${result.decided ? "" : ` — решение ${result.decisionDate}`}\n`);
  return result;
}

// ─── запуск ─────────────────────────────────────────────────────────────────

const mode = process.argv[2];
if (mode === "select") select();
else if (mode === "track") track();
else {
  console.log("\n  node tools/winners.mjs select   # заморозить список (один раз)");
  console.log("  node tools/winners.mjs track    # посчитать форвард\n");
  process.exit(2);
}

export { track };
