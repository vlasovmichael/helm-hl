// ─────────────────────────────────────────────────
//  crossVenueCollector — межбиржевой спред копится только вперёд
// ─────────────────────────────────────────────────
// Зачем (2026-08-14). Вопрос: существует ли окно «купи на одной бирже дешевле,
// продай на другой дороже» размером больше издержек — и живёт ли оно достаточно
// долго, чтобы человек (или бот с домашнего интернета) успел в него влезть.
//
// ── Почему форвардно, а не бэктестом ───────────────────────────────────────
// Та же стена, что у bookCollector: Hyperliquid НЕ отдаёт исторический стакан.
// Свечи есть, но 1m close — это мид на несинхронной сетке, а не bid/ask. Если
// посчитать «HL close минус Binance close» за год, получится расхождение мидов
// в моменты, которые на двух биржах даже не совпадают по времени, и красивая
// эквити на спреде, которого нельзя было коснуться. Поэтому: пишем с сегодня.
//
// ── Модель издержек: почему порог именно такой ─────────────────────────────
// Чтобы забрать расхождение, нужны ЧЕТЫРЕ тейкерских исполнения, а не два:
// открыть обе ноги на расхождении и закрыть обе, когда оно схлопнется.
//   2 × HL taker (4.5 бп) + 2 × Binance taker (5.0 бп) ≈ 19 бп.
// Считать по двум ногам (≈10 бп) — самый лёгкий способ нарисовать себе эдж,
// которого нет. Порог по умолчанию = полная четвёрка, см. COST_BP.
// Модель предполагает выход при gap≈0. Если расхождение не схлопывается, это
// уже не арбитраж, а базисная позиция — другой зверь, здесь не меряется.
//
// ── Главный источник ЛОЖНЫХ находок: замерший сокет ────────────────────────
// Если один сокет молча встал, вторая биржа продолжает ехать, и «расхождение»
// растёт линейно до любых величин. Это выглядит как жирный арбитраж и им не
// является. Отсюда STALE_MS.
// ВАЖНО, где именно проверять свежесть: на уровне СОЕДИНЕНИЯ, а не монеты —
// подробности и цена ошибки в комментарии к venueLastMsg ниже.
//
// ── Второй источник: gap без размера и без времени ─────────────────────────
// 30 бп на $40 стакана — не деньги. 30 бп, прожившие 40 мс, — недостижимы
// физически (только round-trip до биржи ~50-200 мс с домашнего канала).
// Поэтому каждая строка несёт usd (исполнимый объём) и holdMs (сколько окно
// прожило). Анализ обязан фильтровать по обоим, иначе смотрит на мираж.
//
// ── Почему пишется файл статистики, даже когда находок ноль ─────────────────
// Пустой файл окон двусмыслен: «окна нет» и «прибор не смотрел» выглядят
// одинаково. Раз в STATS_MS пишем перцентили расхождения по каждой монете —
// это доказательство, что замер шёл, и заодно ответ «а насколько близко было».
//
// Ордеров не ставит, ключей не читает, к торговому пути не подключается.
// WS не тратит REST-бюджет веса (на котором проект горел 19.07 и 31.07),
// но подписки идут с того же IP: 14 монет × 1 подписка — это единицы процентов
// лимита HL, а торговый бот держит свои сокеты отдельно.
//
// Запуск:
//   node tools/crossVenueCollector.mjs                 # копить бесконечно
//   node tools/crossVenueCollector.mjs --seconds 120   # разведка, сводка в конце
//   XV_COINS=BTC,HYPE,PUMP node tools/crossVenueCollector.mjs

import { appendFileSync, mkdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
// Пакет ws, а не глобальный WebSocket: глобальный появился только в Node 21, а
// образ проекта собран на Node 20 — локально (Node 22) файл работал, в
// контейнере падал с ReferenceError на старте.
import WebSocket from "ws";

const OUT_DIR = join("data", "xvenue");

// Монеты: те, которыми ты реально торгуешь (список из bookCollector) плюс
// крупняк как контроль. CASHCAT выброшен — его нет на Binance, сравнивать не с чем.
const COINS = (process.env.XV_COINS ||
  "BTC,ETH,SOL,HYPE,ACE,HMSTR,KAITO,MANTA,PUMP,DYDX,JTO,XPL,AERO,RESOLV"
).split(",").map((c) => c.trim()).filter(Boolean);

// Комиссии тейкером в базисных пунктах, одна нога.
const HL_TAKER_BP = Number(process.env.XV_HL_TAKER_BP || 4.5);
const BN_TAKER_BP = Number(process.env.XV_BN_TAKER_BP || 5.0);
// Полный круг: открыть две ноги + закрыть две ноги.
const COST_BP = 2 * HL_TAKER_BP + 2 * BN_TAKER_BP;

const STALE_MS = Number(process.env.XV_STALE_MS || 1500);
const STATS_MS = Number(process.env.XV_STATS_MS || 5 * 60_000);
// Живой снимок для витрины на /lab. Дашборд читает файл, а НЕ держит свои
// сокеты к биржам: два процесса с одинаковыми подписками — это удвоенный
// трафик ради одной и той же цифры, плюс второй источник правды, который
// рано или поздно разъедется с первым.
const LIVE_MS = Number(process.env.XV_LIVE_MS || 2_000);
const RUN_SECONDS = (() => {
  const i = process.argv.indexOf("--seconds");
  return i > -1 ? Number(process.argv[i + 1]) : 0;
})();

// ── Соответствие тикеров ───────────────────────────────────────────────────
// HL пишет пачечные монеты как kPEPE (= 1000 PEPE), Binance как 1000PEPE —
// множитель одинаковый, поэтому цены сравнимы напрямую, менять надо только имя.
// См. память про kcoin naming: строчная k у HL.
const toBinance = (coin) =>
  (coin.startsWith("k") && coin.length > 1 && coin[1] === coin[1].toUpperCase()
    ? `1000${coin.slice(1)}`
    : coin) + "USDT";

const BN_TO_HL = new Map(COINS.map((c) => [toBinance(c), c]));

/** Состояние лучшей цены по каждой бирже. Обновляется по месту, без аллокаций. */
const book = new Map(
  COINS.map((c) => [c, {
    hl: null, // { bid, ask, bidUsd, askUsd, t }
    bn: null,
    open: new Map(), // dir -> { since, peakNetBp, minUsd, ticks }
    samples: [],     // сырые gross-расхождения для перцентилей
  }]),
);

// ── Учёт ───────────────────────────────────────────────────────────────────
const stats = { windows: 0, hlMsg: 0, bnMsg: 0, staleSkips: 0, since: Date.now() };

// ── Свежесть проверяется на уровне СОЕДИНЕНИЯ, а не монеты ─────────────────
// Первая версия гарда смотрела на возраст котировки по каждой монете и при
// 1.5с тишины переставала считать. Витрина сразу показала, чем это кончается:
// ночью половина списка (DYDX, HMSTR, JTO, MANTA, RESOLV) висела как «фид
// молчит». А это не мёртвый фид — это тихая монета: в стакане отсутствие
// апдейта означает «цена та же», а не «данных нет».
//
// Цена ошибки не косметическая: из замера выбрасывались ровно те неликвидные
// альты, ради которых всё и затевалось, то есть выборка смещалась к крупняку.
//
// Настоящий отказ, от которого гард и защищает (замерший сокет при живом
// втором), виден именно на уровне соединения: живой сокет присылает хоть
// что-то по хоть какой-то монете постоянно. Тишина по ВСЕМ 14 монетам разом —
// это уже поломка, а не спокойный рынок.
const venueLastMsg = { hl: 0, bn: 0 };

function outFile(kind) {
  const month = new Date().toISOString().slice(0, 7);
  return join(OUT_DIR, `xvenue-${kind}-${month}.jsonl`);
}

function write(kind, obj) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(outFile(kind), JSON.stringify(obj) + "\n");
}

/**
 * Пересчёт после любого апдейта любой из бирж.
 *
 * Две независимые стороны сделки:
 *   buyBN  — купить на Binance по ask, продать на HL по bid
 *   buyHL  — купить на HL по ask, продать на Binance по bid
 * Считаем обе: базис бывает любого знака и меняется в течение дня.
 */
function evaluate(coin) {
  const st = book.get(coin);
  const { hl, bn } = st;
  if (!hl || !bn) return;

  const now = Date.now();
  // Свежесть по времени ПОЛУЧЕНИЯ, а не по времени биржи: у бирж часы свои,
  // и сравнивать их между собой — отдельный способ обмануться.
  if (now - venueLastMsg.hl > STALE_MS || now - venueLastMsg.bn > STALE_MS) {
    // Замерший сокет: закрываем всё открытое как недостоверное, не эмитим.
    if (st.open.size) { st.open.clear(); stats.staleSkips++; }
    return;
  }

  const mid = (hl.bid + hl.ask + bn.bid + bn.ask) / 4;
  if (!(mid > 0)) return;

  const sides = [
    { dir: "buyBN", gross: (hl.bid - bn.ask) / mid * 10_000, usd: Math.min(bn.askUsd, hl.bidUsd) },
    { dir: "buyHL", gross: (bn.bid - hl.ask) / mid * 10_000, usd: Math.min(hl.askUsd, bn.bidUsd) },
  ];

  // Перцентили считаем по лучшей из сторон — это и есть «насколько близко было».
  st.samples.push(Math.max(sides[0].gross, sides[1].gross));

  for (const { dir, gross, usd } of sides) {
    const netBp = gross - COST_BP;
    const cur = st.open.get(dir);

    if (netBp > 0) {
      if (!cur) {
        st.open.set(dir, { since: now, peakNetBp: netBp, minUsd: usd, ticks: 1 });
      } else {
        cur.peakNetBp = Math.max(cur.peakNetBp, netBp);
        // Исполнимый объём берём МИНИМАЛЬНЫЙ за жизнь окна: если стакан
        // подсох в середине, влезть на пиковый размер было нельзя.
        cur.minUsd = Math.min(cur.minUsd, usd);
        cur.ticks++;
      }
    } else if (cur) {
      const holdMs = now - cur.since;
      stats.windows++;
      write("windows", {
        t: cur.since, coin, dir,
        peakNetBp: +cur.peakNetBp.toFixed(2),
        grossBp: +(cur.peakNetBp + COST_BP).toFixed(2),
        costBp: COST_BP,
        holdMs,
        usd: +cur.minUsd.toFixed(2),
        ticks: cur.ticks,
        // Сколько денег окно стоило бы при полном исполнении на minUsd.
        pnlUsd: +(cur.minUsd * cur.peakNetBp / 10_000).toFixed(4),
      });
      st.open.delete(dir);
    }
  }
}

// ── Живой снимок ───────────────────────────────────────────────────────────
// Пишем через временный файл + rename: витрина читает этот файл каждые пару
// секунд, и без атомарной подмены она рано или поздно прочитает половину
// записи и покажет ошибку парсинга вместо данных.
const LIVE_FILE = join(OUT_DIR, "live.json");

function writeLive() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const now = Date.now();

  const coins = [];
  for (const [coin, st] of book) {
    const { hl, bn } = st;
    if (!hl || !bn) { coins.push({ coin, ready: false }); continue; }
    const mid = (hl.bid + hl.ask + bn.bid + bn.ask) / 4;
    const buyBN = { dir: "buyBN", gross: (hl.bid - bn.ask) / mid * 10_000, usd: Math.min(bn.askUsd, hl.bidUsd) };
    const buyHL = { dir: "buyHL", gross: (bn.bid - hl.ask) / mid * 10_000, usd: Math.min(hl.askUsd, bn.bidUsd) };
    const best = buyBN.gross >= buyHL.gross ? buyBN : buyHL;
    coins.push({
      coin, ready: true,
      dir: best.dir,
      grossBp: +best.gross.toFixed(2),
      netBp: +(best.gross - COST_BP).toFixed(2),
      usd: +best.usd.toFixed(0),
      hlMid: +((hl.bid + hl.ask) / 2).toFixed(8),
      bnMid: +((bn.bid + bn.ask) / 2).toFixed(8),
      // Возраст каждой ноги отдельно: если встал ОДИН фид, витрина обязана
      // показать какой именно, иначе «расхождение из воздуха» выглядит находкой.
      hlAgeMs: now - hl.t,
      bnAgeMs: now - bn.t,
      // Тихая монета — норма, а не поломка: отсутствие апдейта в стакане
      // значит «цена та же». Поэтому stale здесь про СОЕДИНЕНИЕ, а возраст
      // каждой ноги остаётся справочным числом рядом.
      stale: now - venueLastMsg.hl > STALE_MS || now - venueLastMsg.bn > STALE_MS,
      quietMs: Math.max(now - hl.t, now - bn.t),
      // Окно открыто прямо сейчас — то есть netBp > 0 держится не мгновение.
      openMs: st.open.get(best.dir) ? now - st.open.get(best.dir).since : 0,
    });
  }

  const payload = {
    t: now,
    costBp: COST_BP,
    hlTakerBp: HL_TAKER_BP,
    bnTakerBp: BN_TAKER_BP,
    staleMs: STALE_MS,
    hlFeedAgeMs: venueLastMsg.hl ? now - venueLastMsg.hl : null,
    bnFeedAgeMs: venueLastMsg.bn ? now - venueLastMsg.bn : null,
    uptimeMin: +((now - stats.since) / 60_000).toFixed(1),
    hlMsg: stats.hlMsg,
    bnMsg: stats.bnMsg,
    staleSkips: stats.staleSkips,
    windows: stats.windows,
    coins: coins.sort((a, b) => (b.grossBp ?? -1e9) - (a.grossBp ?? -1e9)),
  };

  const tmp = `${LIVE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, LIVE_FILE);
}

// ── Перцентили без сортировки всего массива каждый раз ─────────────────────
function pct(arr, p) {
  if (!arr.length) return null;
  const i = Math.min(arr.length - 1, Math.floor(arr.length * p));
  return +arr[i].toFixed(2);
}

function flushStats() {
  const t = Date.now();
  for (const [coin, st] of book) {
    if (!st.samples.length) continue;
    const s = st.samples.slice().sort((a, b) => a - b);
    write("stats", {
      t, coin, n: s.length,
      p50: pct(s, 0.5), p90: pct(s, 0.9), p99: pct(s, 0.99),
      max: +s[s.length - 1].toFixed(2),
      costBp: COST_BP,
    });
    st.samples.length = 0;
  }
}

// ── Hyperliquid: подписка bbo отдаёт только лучшую цену, а не весь стакан ───
function connectHL() {
  const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
  let alive = true;

  ws.onopen = () => {
    for (const coin of COINS) {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "bbo", coin } }));
    }
    process.stderr.write(`[xv] HL подключён, ${COINS.length} подписок\n`);
  };

  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(String(e.data)); } catch { return; }
    if (d.channel !== "bbo") {
      if (d.channel === "error") process.stderr.write(`[xv] HL error: ${JSON.stringify(d.data)}\n`);
      return;
    }
    const { coin, bbo } = d.data;
    const st = book.get(coin);
    if (!st || !bbo?.[0] || !bbo?.[1]) return;
    const bid = parseFloat(bbo[0].px), ask = parseFloat(bbo[1].px);
    if (!(bid > 0) || !(ask > bid)) return;
    st.hl = {
      bid, ask,
      bidUsd: bid * parseFloat(bbo[0].sz),
      askUsd: ask * parseFloat(bbo[1].sz),
      t: Date.now(),
    };
    stats.hlMsg++;
    venueLastMsg.hl = st.hl.t;
    evaluate(coin);
  };

  // Переподключение: молчащий сокет здесь хуже упавшего — он рисует
  // расхождения из воздуха. STALE_MS ловит это на уровне данных, reconnect —
  // на уровне соединения.
  const revive = () => { if (alive) { alive = false; setTimeout(connectHL, 3000); } };
  ws.onclose = () => { process.stderr.write("[xv] HL отвалился, переподключаюсь\n"); revive(); };
  ws.onerror = () => revive();
}

// ── Binance USDT-перпы: bookTicker пушит на каждое изменение лучшей цены ────
function connectBN() {
  const streams = COINS.map((c) => `${toBinance(c).toLowerCase()}@bookTicker`).join("/");
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  let alive = true;

  ws.onopen = () => process.stderr.write(`[xv] Binance подключён, ${COINS.length} потоков\n`);

  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(String(e.data)); } catch { return; }
    const x = d.data;
    if (!x?.s) return;
    const coin = BN_TO_HL.get(x.s);
    const st = coin && book.get(coin);
    if (!st) return;
    const bid = parseFloat(x.b), ask = parseFloat(x.a);
    if (!(bid > 0) || !(ask > bid)) return;
    st.bn = {
      bid, ask,
      bidUsd: bid * parseFloat(x.B),
      askUsd: ask * parseFloat(x.A),
      t: Date.now(),
    };
    stats.bnMsg++;
    venueLastMsg.bn = st.bn.t;
    evaluate(coin);
  };

  const revive = () => { if (alive) { alive = false; setTimeout(connectBN, 3000); } };
  ws.onclose = () => { process.stderr.write("[xv] Binance отвалился, переподключаюсь\n"); revive(); };
  ws.onerror = () => revive();
}

// ── Сводка на выход ────────────────────────────────────────────────────────
function summary() {
  const mins = (Date.now() - stats.since) / 60_000;
  console.log(`\n  Замер ${mins.toFixed(1)} мин. Порог = ${COST_BP} бп ` +
    `(2×HL ${HL_TAKER_BP} + 2×BN ${BN_TAKER_BP}).`);
  console.log(`  Апдейтов: HL ${stats.hlMsg}, Binance ${stats.bnMsg}. ` +
    `Пропущено по несвежести: ${stats.staleSkips}.`);
  console.log(`  Окон выше порога: ${stats.windows}\n`);

  // В samples лежит ВАЛОВОЕ расхождение. Сравнивать его надо с COST_BP, а не с
  // нулём: сравнение с нулём один раз уже нарисовало «ВЫШЕ ПОРОГА» у BTC с его
  // 4.8 бп при пороге 19. Шкалу держим валовой, вердикт — относительно порога.
  console.log("  монета     n      p50      p90      p99      max     вердикт (порог " + COST_BP + " бп)");
  const rows = [];
  for (const [coin, st] of book) {
    if (!st.samples.length) { rows.push([coin, 0]); continue; }
    const s = st.samples.slice().sort((a, b) => a - b);
    rows.push([coin, s.length, pct(s, 0.5), pct(s, 0.9), pct(s, 0.99), +s[s.length - 1].toFixed(2)]);
  }
  for (const [coin, n, p50, p90, p99, max] of rows.sort((a, b) => (b[5] ?? -1e9) - (a[5] ?? -1e9))) {
    if (!n) { console.log(`  ${coin.padEnd(9)} нет данных`); continue; }
    const verdict = max > COST_BP
      ? `ПРОБИЛ на ${(max - COST_BP).toFixed(1)} бп`
      : `не дотянул ${(COST_BP - max).toFixed(1)} бп`;
    console.log(
      `  ${coin.padEnd(9)} ${String(n).padStart(5)} ` +
      `${String(p50).padStart(8)} ${String(p90).padStart(8)} ` +
      `${String(p99).padStart(8)} ${String(max).padStart(8)}   ${verdict}`,
    );
  }
  console.log(`\n  Числа — ВАЛОВОЕ расхождение лучшей из двух сторон, в бп,`);
  console.log(`  ДО издержек. Деньги начинаются правее ${COST_BP} бп.\n`);
}

// ── Старт ──────────────────────────────────────────────────────────────────
process.stderr.write(
  `[xv] старт: ${COINS.length} монет, порог ${COST_BP} бп, ` +
  `несвежесть >${STALE_MS} мс → ${OUT_DIR}\n`,
);
connectHL();
connectBN();
setInterval(flushStats, STATS_MS);
setInterval(writeLive, LIVE_MS);

// Порядок важен: flushStats() опустошает samples, поэтому сводка читает их первой.
const finish = () => { summary(); flushStats(); process.exit(0); };

if (RUN_SECONDS > 0) setTimeout(finish, RUN_SECONDS * 1000);
else process.on("SIGINT", finish);
