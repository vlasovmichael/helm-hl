// ─────────────────────────────────────────────────
//  crossVenueCollector — межбиржевой спред копится только вперёд
// ─────────────────────────────────────────────────
// Зачем (2026-08-14). Вопрос: существует ли окно «купи на одной бирже дешевле,
// продай на другой дороже» размером больше издержек — и живёт ли оно достаточно
// долго, чтобы бот успел в него влезть.
//
// ── Три площадки, две пары ─────────────────────────────────────────────────
// HL ↔ KRAKEN — торговая пара. Binance из Европы недоступен, Kraken подключён.
// HL ↔ BINANCE — КОНТРОЛЬ, торговать там нельзя. Нужен потому, что Binance это
//   площадка, где формируется цена, и без неё нечем отличить «на Kraken реально
//   другая цена» от «у Kraken тонкий стакан и широкий спред». Если расхождение
//   HL↔Kraken систематически больше, чем HL↔Binance, — это премия за неликвид
//   Kraken, а не арбитраж. Данные бесплатные, подписка ничего не стоит.
//
// ── Почему форвардно, а не бэктестом ───────────────────────────────────────
// Та же стена, что у bookCollector: Hyperliquid НЕ отдаёт исторический стакан.
// Свечи есть, но 1m close — это мид на несинхронной сетке, а не bid/ask. Если
// посчитать «HL close минус Kraken close» за год, получится расхождение мидов
// в моменты, которые на двух биржах даже не совпадают по времени, и красивая
// эквити на спреде, которого нельзя было коснуться. Поэтому: пишем с сегодня.
//
// ── Модель издержек: комиссии — только ПОЛОВИНА счёта ──────────────────────
// Чтобы забрать расхождение, нужны ЧЕТЫРЕ тейкерских исполнения:
//   2 × HL taker (4.5 бп) + 2 × Kraken taker ≈ 19 бп при тейкере 5 бп.
//
// 🚨 ИСПРАВЛЕНО 14.08 ПО ДАННЫМ БУМАЖНОГО БОТА. Порога в 19 бп НЕ хватает, и
// первые три сделки это показали: KAITO вошёл при 19.7 бп, расхождение к
// исполнению НЕ изменилось — и всё равно вышел −37 бп. Причина в том, что
// спреды пересекаются ДВАЖДЫ, а метрика вычитала их один раз.
//
// Считаем честно через расхождение МИДОВ (D) и спреды площадок (sA, sB):
//   вход:  покупаем по ask одной, продаём по bid другой  → платим (sA+sB)/2
//   выход: продаём по bid одной,  выкупаем по ask другой → платим (sA+sB)/2
//   итог:  прибыль = (D_вход − D_выход) − (sA + sB) − комиссии
//
// То, что коллектор мерил раньше как «валовое расхождение», это уже
// G = D − (sA+sB)/2, то есть спреды входа в нём учтены. Спреды ВЫХОДА не были
// учтены нигде. Отсюда рабочий порог:
//   G > комиссии + (sA + sB) / 2
//
// Разница не косметическая. У Kraken спреды на альтах огромные: ACE 49 бп,
// KAITO 15 бп. Порог по ACE получается не 19, а ~47 бп — при том что максимум
// расхождения за всё наблюдение был 38 бп. То есть значительная часть «окон»
// была не окнами, а шириной чужого стакана.
//
// Поэтому порог здесь ДИНАМИЧЕСКИЙ: считается на каждом тике по текущим
// спредам. costBp пары остался как комиссионная часть.
//
// 🚨 КОМИССИЯ KRAKEN — ПАРАМЕТР, И ЕЁ НАДО ПРОВЕРИТЬ В КАБИНЕТЕ. У Kraken две
// сетки: PF-контракты по умолчанию идут по 0.05% (5 бп), но для розничных
// клиентов существует сетка Consumer с 0.25% (25 бп). Разница решает вопрос
// целиком: при 25 бп порог становится 59 бп, а самое большое расхождение за всё
// наблюдение было 37.9 бп — то есть не пробивало НИ РАЗУ. Ставится через
// XV_KR_TAKER_BP без пересборки.
//
// Модель предполагает выход при gap≈0. Если расхождение не схлопывается, это
// уже не арбитраж, а базисная позиция — другой зверь, здесь не меряется.
//
// ── Главный источник ЛОЖНЫХ находок: замерший сокет ────────────────────────
// Если один сокет молча встал, вторая биржа продолжает ехать, и «расхождение»
// растёт линейно до любых величин. Это выглядит как жирный арбитраж и им не
// является. Отсюда STALE_MS. ВАЖНО, где проверять свежесть: на уровне
// СОЕДИНЕНИЯ, а не монеты — подробности в комментарии к venueLastMsg.
//
// ── Второй источник: gap без размера и без времени ─────────────────────────
// 30 бп на $40 стакана — не деньги. 30 бп, прожившие 40 мс, — недостижимы
// физически (round-trip до бирж из Европы ~220 мс, замер 14.08).
// Поэтому каждая строка несёт usd (исполнимый объём) и holdMs (сколько окно
// прожило). Анализ обязан фильтровать по обоим, иначе смотрит на мираж.
//
// ── Почему у Kraken именно book, а не ticker ───────────────────────────────
// Фид ticker у Kraken троттлится: замер 14.08 дал медиану 633 мс между
// сообщениями, максимум 2 с, и 4 смены цены за 20 секунд по BTC. Окна живут
// 0-580 мс — таким фидом их не увидеть в принципе. Фид book событийный:
// 6603 дельты за 20 с, медиана интервала 0 мс. Поэтому здесь L2 с дельтами и
// своим поддержанием лучшей цены, хотя это заметно больше кода.
//
// Ордеров не ставит, ключей не читает, к торговому пути не подключается.
// WS не тратит REST-бюджет веса (на котором проект горел 19.07 и 31.07).
//
// Запуск:
//   node tools/crossVenueCollector.mjs                 # копить бесконечно
//   node tools/crossVenueCollector.mjs --seconds 120   # разведка, сводка в конце

import { appendFileSync, mkdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
// Пакет ws, а не глобальный WebSocket: глобальный появился только в Node 21, а
// образ проекта собран на Node 20 — локально (Node 22) файл работал, в
// контейнере падал с ReferenceError на старте.
import WebSocket from "ws";
import { PaperBot } from "./xvenuePaper.mjs";

const OUT_DIR = join("data", "xvenue");

// Монеты: те, которыми ты реально торгуешь (список из bookCollector) плюс
// крупняк как контроль. CASHCAT выброшен — его нет ни на Binance, ни на Kraken.
const COINS = (process.env.XV_COINS ||
  "BTC,ETH,SOL,HYPE,ACE,HMSTR,KAITO,MANTA,PUMP,DYDX,JTO,XPL,AERO,RESOLV"
).split(",").map((c) => c.trim()).filter(Boolean);

// Комиссии тейкером в базисных пунктах, ОДНА нога.
const HL_TAKER_BP = Number(process.env.XV_HL_TAKER_BP || 4.5);
const BN_TAKER_BP = Number(process.env.XV_BN_TAKER_BP || 5.0);
const KR_TAKER_BP = Number(process.env.XV_KR_TAKER_BP || 5.0);

const STALE_MS = Number(process.env.XV_STALE_MS || 1500);
const STATS_MS = Number(process.env.XV_STATS_MS || 5 * 60_000);
// Живой снимок для витрины на /lab. Дашборд читает файл, а НЕ держит свои
// сокеты к биржам: три процесса с одинаковыми подписками — это утроенный
// трафик ради одной и той же цифры, плюс второй источник правды.
const LIVE_MS = Number(process.env.XV_LIVE_MS || 2_000);
// ── Бумажный бот ───────────────────────────────────────────────────────────
// Отвечает на вопрос «а если депо $100 и бот ждёт расхождений» — но честно:
// ордера исполняются по цене ПОСЛЕ задержки, а не по той, что бот увидел.
// Считает рядом наивную версию (исполнение по цене обнаружения), и разница
// между ними — это и есть то, что съедает идею. Ордеров не ставит.
const PAPER_ON = String(process.env.XV_PAPER || "true") !== "false";
const paper = PAPER_ON
  ? new PaperBot({
    equity: Number(process.env.XV_PAPER_EQUITY || 100),
    latencyMs: Number(process.env.XV_PAPER_LATENCY_MS || 220),
    takers: { hl: HL_TAKER_BP, kr: KR_TAKER_BP, bn: BN_TAKER_BP },
    onTrade: (rec) => write("paper", rec),
  })
  : null;

const RUN_SECONDS = (() => {
  const i = process.argv.indexOf("--seconds");
  return i > -1 ? Number(process.argv[i + 1]) : 0;
})();

// ── Соответствие тикеров ───────────────────────────────────────────────────
// HL пишет пачечные монеты как kPEPE (= 1000 PEPE), Binance как 1000PEPE —
// множитель одинаковый, поэтому цены сравнимы напрямую, менять надо только имя.
// См. память про kcoin naming: строчная k у HL.
const unK = (coin) =>
  (coin.startsWith("k") && coin.length > 1 && coin[1] === coin[1].toUpperCase()
    ? `1000${coin.slice(1)}`
    : coin);

const bnSymbol = (coin) => `${unK(coin)}USDT`;
// Kraken зовёт биткоин XBT — историческое наследие, а не отдельный актив.
const krSymbol = (coin) => `PF_${unK(coin) === "BTC" ? "XBT" : unK(coin)}USD`;

// Какие монеты реально есть на каждой площадке — заполняется на старте,
// подписываемся только на существующее (иначе Kraken молча игнорирует, а
// Binance роняет всё соединение на несуществующем потоке).
const listed = { bn: new Set(), kr: new Set() };

async function discoverListings() {
  try {
    const bn = await (await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo")).json();
    const set = new Set(bn.symbols.filter((s) => s.status === "TRADING").map((s) => s.symbol));
    for (const c of COINS) if (set.has(bnSymbol(c))) listed.bn.add(c);
  } catch (err) {
    process.stderr.write(`[xv] список Binance не получен: ${err.message}\n`);
  }
  try {
    const kf = await (await fetch("https://futures.kraken.com/derivatives/api/v3/instruments")).json();
    const set = new Set((kf.instruments || []).filter((i) => i.tradeable).map((i) => i.symbol));
    for (const c of COINS) if (set.has(krSymbol(c))) listed.kr.add(c);
  } catch (err) {
    process.stderr.write(`[xv] список Kraken не получен: ${err.message}\n`);
  }
}

// ── Пары ───────────────────────────────────────────────────────────────────
// tradeable отличает «здесь можно торговать» от «это опорная точка».
// Без флага контрольная пара рано или поздно попадёт в вывод как возможность.
const PAIRS = [
  { key: "hl-kr", a: "hl", b: "kr", label: "HL ↔ Kraken", tradeable: true,
    costBp: 2 * HL_TAKER_BP + 2 * KR_TAKER_BP },
  { key: "hl-bn", a: "hl", b: "bn", label: "HL ↔ Binance (контроль)", tradeable: false,
    costBp: 2 * HL_TAKER_BP + 2 * BN_TAKER_BP },
];

/** Лучшая цена по каждой площадке + открытые окна и выборки по каждой паре. */
const book = new Map(
  COINS.map((c) => [c, {
    hl: null, bn: null, kr: null, // { bid, ask, bidUsd, askUsd, t }
    open: new Map(),              // "<pairKey>|<dir>" -> { since, peakNetBp, minUsd, ticks }
    samples: new Map(PAIRS.map((p) => [p.key, []])),
  }]),
);

// ── Учёт ───────────────────────────────────────────────────────────────────
const stats = { windows: 0, msg: { hl: 0, bn: 0, kr: 0 }, staleSkips: 0, since: Date.now() };

// ── Свежесть проверяется на уровне СОЕДИНЕНИЯ, а не монеты ─────────────────
// Первая версия гарда смотрела на возраст котировки по каждой монете и при
// 1.5с тишины переставала считать. Витрина сразу показала, чем это кончается:
// ночью половина списка (DYDX, HMSTR, JTO, MANTA, RESOLV) висела как «фид
// молчит». А это не мёртвый фид — это тихая монета: в стакане отсутствие
// апдейта означает «цена та же», а не «данных нет».
//
// Цена ошибки не косметическая: из замера выбрасывались ровно те неликвидные
// альты, ради которых всё и затевалось, то есть выборка смещалась к крупняку.
const venueLastMsg = { hl: 0, bn: 0, kr: 0 };

function outFile(kind) {
  const month = new Date().toISOString().slice(0, 7);
  return join(OUT_DIR, `xvenue-${kind}-${month}.jsonl`);
}

function write(kind, obj) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(outFile(kind), JSON.stringify(obj) + "\n");
}

/**
 * Пересчёт пары после любого апдейта любой из её площадок.
 *
 * Две независимые стороны сделки:
 *   buyB — купить на B по ask, продать на A по bid
 *   buyA — купить на A по ask, продать на B по bid
 * Считаем обе: базис бывает любого знака и меняется в течение дня.
 */
function evaluate(coin, pair) {
  const st = book.get(coin);
  const A = st[pair.a], B = st[pair.b];
  if (!A || !B) return;

  const now = Date.now();
  if (now - venueLastMsg[pair.a] > STALE_MS || now - venueLastMsg[pair.b] > STALE_MS) {
    // Замерший сокет: закрываем открытое по этой паре как недостоверное.
    let touched = false;
    for (const k of [...st.open.keys()]) {
      if (k.startsWith(`${pair.key}|`)) { st.open.delete(k); touched = true; }
    }
    if (touched) stats.staleSkips++;
    return;
  }

  const mid = (A.bid + A.ask + B.bid + B.ask) / 4;
  if (!(mid > 0)) return;

  // Спреды выхода: их пересекать придётся второй раз, когда будем закрываться.
  // Половина суммы — потому что G уже включает половину (спреды входа).
  const spreadA = (A.ask - A.bid) / mid * 10_000;
  const spreadB = (B.ask - B.bid) / mid * 10_000;
  const thresholdBp = pair.costBp + (spreadA + spreadB) / 2;

  const sides = [
    { dir: "buyB", gross: (A.bid - B.ask) / mid * 10_000, usd: Math.min(B.askUsd, A.bidUsd) },
    { dir: "buyA", gross: (B.bid - A.ask) / mid * 10_000, usd: Math.min(A.askUsd, B.bidUsd) },
  ];

  // Перцентили считаем по лучшей из сторон — это и есть «насколько близко было».
  st.samples.get(pair.key).push(Math.max(sides[0].gross, sides[1].gross));

  // Бумажный бот работает ТОЛЬКО по торговой паре: гонять его по контрольной
  // значило бы копить эквити на бирже, куда доступа нет.
  if (paper && pair.tradeable) {
    paper.onTick(coin, pair.key, { a: A, b: B, venues: [pair.a, pair.b] }, thresholdBp);
  }

  for (const { dir, gross, usd } of sides) {
    const netBp = gross - thresholdBp;
    const slot = `${pair.key}|${dir}`;
    const cur = st.open.get(slot);

    if (netBp > 0) {
      if (!cur) {
        st.open.set(slot, { since: now, peakNetBp: netBp, minUsd: usd, ticks: 1, thresholdBp });
      } else {
        cur.peakNetBp = Math.max(cur.peakNetBp, netBp);
        // Исполнимый объём берём МИНИМАЛЬНЫЙ за жизнь окна: если стакан
        // подсох в середине, влезть на пиковый размер было нельзя.
        cur.minUsd = Math.min(cur.minUsd, usd);
        cur.thresholdBp = Math.max(cur.thresholdBp, thresholdBp);
        cur.ticks++;
      }
    } else if (cur) {
      stats.windows++;
      write("windows", {
        t: cur.since, coin,
        pair: pair.key,
        tradeable: pair.tradeable,
        dir,
        peakNetBp: +cur.peakNetBp.toFixed(2),
        grossBp: +(cur.peakNetBp + cur.thresholdBp).toFixed(2),
        costBp: pair.costBp,
        // Порог на момент входа: комиссии + половина суммы спредов. Пишем его
        // в строку, иначе задним числом не восстановить, почему окно засчиталось.
        thresholdBp: +cur.thresholdBp.toFixed(2),
        spreadsBp: +(spreadA + spreadB).toFixed(2),
        holdMs: now - cur.since,
        usd: +cur.minUsd.toFixed(2),
        ticks: cur.ticks,
        pnlUsd: +(cur.minUsd * cur.peakNetBp / 10_000).toFixed(4),
      });
      st.open.delete(slot);
    }
  }
}

/** Апдейт площадки: сохранить котировку и пересчитать все пары с её участием. */
function onQuote(venue, coin, quote) {
  const st = book.get(coin);
  if (!st) return;
  st[venue] = quote;
  stats.msg[venue]++;
  venueLastMsg[venue] = quote.t;
  for (const p of PAIRS) if (p.a === venue || p.b === venue) evaluate(coin, p);
}

// ── Живой снимок ───────────────────────────────────────────────────────────
// Пишем через временный файл + rename: витрина читает этот файл каждые пару
// секунд, и без атомарной подмены она рано или поздно прочитает половину
// записи и покажет ошибку парсинга вместо данных.
const LIVE_FILE = join(OUT_DIR, "live.json");

function writeLive() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const now = Date.now();

  const pairs = PAIRS.map((p) => {
    const coins = [];
    for (const [coin, st] of book) {
      const A = st[p.a], B = st[p.b];
      if (!A || !B) { coins.push({ coin, ready: false }); continue; }
      const mid = (A.bid + A.ask + B.bid + B.ask) / 4;
      const buyB = { dir: "buyB", gross: (A.bid - B.ask) / mid * 10_000, usd: Math.min(B.askUsd, A.bidUsd) };
      const buyA = { dir: "buyA", gross: (B.bid - A.ask) / mid * 10_000, usd: Math.min(A.askUsd, B.bidUsd) };
      const best = buyB.gross >= buyA.gross ? buyB : buyA;
      const open = st.open.get(`${p.key}|${best.dir}`);
      coins.push({
        coin, ready: true,
        dir: best.dir,
        grossBp: +best.gross.toFixed(2),
        netBp: +(best.gross - p.costBp).toFixed(2),
        usd: +best.usd.toFixed(0),
        // Спред каждой площадки отдельно: если расхождение целиком объясняется
        // широким спредом одной из них, это не окно, а плата за неликвид.
        aSpreadBp: +((A.ask - A.bid) / mid * 10_000).toFixed(2),
        bSpreadBp: +((B.ask - B.bid) / mid * 10_000).toFixed(2),
        // Тихая монета — норма, а не поломка. stale здесь про СОЕДИНЕНИЕ.
        quietMs: Math.max(now - A.t, now - B.t),
        stale: now - venueLastMsg[p.a] > STALE_MS || now - venueLastMsg[p.b] > STALE_MS,
        openMs: open ? now - open.since : 0,
      });
    }
    return {
      key: p.key, label: p.label, tradeable: p.tradeable, costBp: p.costBp,
      coins: coins.sort((x, y) => (y.grossBp ?? -1e9) - (x.grossBp ?? -1e9)),
    };
  });

  const payload = {
    t: now,
    takers: { hl: HL_TAKER_BP, bn: BN_TAKER_BP, kr: KR_TAKER_BP },
    staleMs: STALE_MS,
    uptimeMin: +((now - stats.since) / 60_000).toFixed(1),
    msg: stats.msg,
    feedAgeMs: {
      hl: venueLastMsg.hl ? now - venueLastMsg.hl : null,
      bn: venueLastMsg.bn ? now - venueLastMsg.bn : null,
      kr: venueLastMsg.kr ? now - venueLastMsg.kr : null,
    },
    listed: { kr: [...listed.kr], bn: [...listed.bn] },
    paper: paper ? paper.snapshot() : null,
    staleSkips: stats.staleSkips,
    windows: stats.windows,
    pairs,
  };

  const tmp = `${LIVE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, LIVE_FILE);
}

// ── Перцентили ─────────────────────────────────────────────────────────────
function pct(sorted, p) {
  if (!sorted.length) return null;
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
}

function flushStats() {
  const t = Date.now();
  for (const [coin, st] of book) {
    for (const p of PAIRS) {
      const arr = st.samples.get(p.key);
      if (!arr.length) continue;
      const s = arr.slice().sort((a, b) => a - b);
      write("stats", {
        t, coin, pair: p.key, tradeable: p.tradeable, n: s.length,
        p50: pct(s, 0.5), p90: pct(s, 0.9), p99: pct(s, 0.99),
        max: +s[s.length - 1].toFixed(2),
        costBp: p.costBp,
      });
      arr.length = 0;
    }
  }
}

// ── Hyperliquid: подписка bbo отдаёт только лучшую цену ────────────────────
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
    if (!bbo?.[0] || !bbo?.[1]) return;
    const bid = parseFloat(bbo[0].px), ask = parseFloat(bbo[1].px);
    if (!(bid > 0) || !(ask > bid)) return;
    onQuote("hl", coin, {
      bid, ask,
      bidUsd: bid * parseFloat(bbo[0].sz),
      askUsd: ask * parseFloat(bbo[1].sz),
      t: Date.now(),
    });
  };

  // Молчащий сокет здесь хуже упавшего — он рисует расхождения из воздуха.
  // STALE_MS ловит это на уровне данных, reconnect — на уровне соединения.
  const revive = () => { if (alive) { alive = false; setTimeout(connectHL, 3000); } };
  ws.onclose = () => { process.stderr.write("[xv] HL отвалился, переподключаюсь\n"); revive(); };
  ws.onerror = () => revive();
}

// ── Binance (контроль): bookTicker пушит на каждое изменение лучшей цены ────
function connectBN() {
  const coins = [...listed.bn];
  if (!coins.length) { process.stderr.write("[xv] Binance: нечего слушать\n"); return; }
  const streams = coins.map((c) => `${bnSymbol(c).toLowerCase()}@bookTicker`).join("/");
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  let alive = true;
  const bySymbol = new Map(coins.map((c) => [bnSymbol(c), c]));

  ws.onopen = () => process.stderr.write(`[xv] Binance подключён, ${coins.length} потоков\n`);

  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(String(e.data)); } catch { return; }
    const x = d.data;
    if (!x?.s) return;
    const coin = bySymbol.get(x.s);
    if (!coin) return;
    const bid = parseFloat(x.b), ask = parseFloat(x.a);
    if (!(bid > 0) || !(ask > bid)) return;
    onQuote("bn", coin, {
      bid, ask,
      bidUsd: bid * parseFloat(x.B),
      askUsd: ask * parseFloat(x.A),
      t: Date.now(),
    });
  };

  const revive = () => { if (alive) { alive = false; setTimeout(connectBN, 3000); } };
  ws.onclose = () => { process.stderr.write("[xv] Binance отвалился, переподключаюсь\n"); revive(); };
  ws.onerror = () => revive();
}

// ── Kraken Futures: L2 с дельтами ──────────────────────────────────────────
// Почему не ticker — см. шапку файла (троттлинг 633 мс убивает весь замер).
// Полный стакан держим в Map, лучшую цену кэшируем и пересчитываем только
// когда сносят сам верхний уровень: пересортировывать тысячу уровней на каждой
// из 6600 дельт в секунду — верный способ упереться в CPU на ровном месте.
function connectKR() {
  const coins = [...listed.kr];
  if (!coins.length) { process.stderr.write("[xv] Kraken: нечего слушать\n"); return; }
  const ws = new WebSocket("wss://futures.kraken.com/ws/v1");
  let alive = true;
  const byProduct = new Map(coins.map((c) => [krSymbol(c), c]));
  const books = new Map(); // product -> { bids: Map, asks: Map, bestBid, bestAsk }

  const best = (m, side) => {
    let out = side === "bid" ? -Infinity : Infinity;
    for (const px of m.keys()) {
      if (side === "bid") { if (px > out) out = px; }
      else if (px < out) out = px;
    }
    return Number.isFinite(out) ? out : null;
  };

  const publish = (product) => {
    const b = books.get(product);
    const coin = byProduct.get(product);
    if (!b || !coin || b.bestBid == null || b.bestAsk == null) return;
    if (!(b.bestBid > 0) || !(b.bestAsk > b.bestBid)) return;
    onQuote("kr", coin, {
      bid: b.bestBid, ask: b.bestAsk,
      bidUsd: b.bestBid * (b.bids.get(b.bestBid) || 0),
      askUsd: b.bestAsk * (b.asks.get(b.bestAsk) || 0),
      t: Date.now(),
    });
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ event: "subscribe", feed: "book", product_ids: coins.map(krSymbol) }));
    process.stderr.write(`[xv] Kraken подключён, ${coins.length} стаканов\n`);
  };

  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(String(e.data)); } catch { return; }

    if (d.event === "error" || d.event === "alert") {
      process.stderr.write(`[xv] Kraken: ${JSON.stringify(d).slice(0, 200)}\n`);
      return;
    }

    if (d.feed === "book_snapshot") {
      const bids = new Map(), asks = new Map();
      for (const x of d.bids || []) bids.set(x.price, x.qty);
      for (const x of d.asks || []) asks.set(x.price, x.qty);
      books.set(d.product_id, { bids, asks, bestBid: best(bids, "bid"), bestAsk: best(asks, "ask") });
      publish(d.product_id);
      return;
    }

    if (d.feed !== "book") return;
    const b = books.get(d.product_id);
    if (!b) return; // дельта до снимка — пропускаем, снимок придёт следом

    const isBid = d.side === "buy";
    const m = isBid ? b.bids : b.asks;
    if (d.qty === 0) {
      m.delete(d.price);
      // Снесли верхний уровень — только здесь нужен полный пересчёт.
      if (isBid && d.price === b.bestBid) b.bestBid = best(m, "bid");
      if (!isBid && d.price === b.bestAsk) b.bestAsk = best(m, "ask");
    } else {
      m.set(d.price, d.qty);
      if (isBid && (b.bestBid == null || d.price > b.bestBid)) b.bestBid = d.price;
      if (!isBid && (b.bestAsk == null || d.price < b.bestAsk)) b.bestAsk = d.price;
    }
    publish(d.product_id);
  };

  const revive = () => { if (alive) { alive = false; setTimeout(connectKR, 3000); } };
  ws.onclose = () => { process.stderr.write("[xv] Kraken отвалился, переподключаюсь\n"); revive(); };
  ws.onerror = () => revive();
}

// ── Сводка на выход ────────────────────────────────────────────────────────
function summary() {
  const mins = (Date.now() - stats.since) / 60_000;
  console.log(`\n  Замер ${mins.toFixed(1)} мин.`);
  console.log(`  Апдейтов: HL ${stats.msg.hl}, Kraken ${stats.msg.kr}, Binance ${stats.msg.bn}. ` +
    `Пропущено по несвежести: ${stats.staleSkips}. Окон выше порога: ${stats.windows}`);

  for (const p of PAIRS) {
    console.log(`\n  ── ${p.label} · порог ${p.costBp} бп ` +
      `${p.tradeable ? "" : "· ТОРГОВАТЬ НЕЛЬЗЯ, опорная точка"}`);
    console.log("  монета     n      p50      p90      p99      max     вердикт");
    const rows = [];
    for (const [coin, st] of book) {
      const arr = st.samples.get(p.key);
      if (arr.length) rows.push([coin, arr.slice().sort((a, b) => a - b)]);
    }
    if (!rows.length) { console.log("  (нет данных)"); continue; }
    for (const [coin, s] of rows.sort((a, b) => b[1][b[1].length - 1] - a[1][a[1].length - 1])) {
      const max = s[s.length - 1];
      const verdict = max > p.costBp
        ? `ПРОБИЛ на ${(max - p.costBp).toFixed(1)} бп`
        : `не дотянул ${(p.costBp - max).toFixed(1)} бп`;
      console.log(
        `  ${coin.padEnd(9)} ${String(s.length).padStart(5)} ` +
        `${String(pct(s, 0.5)).padStart(8)} ${String(pct(s, 0.9)).padStart(8)} ` +
        `${String(pct(s, 0.99)).padStart(8)} ${String(+max.toFixed(2)).padStart(8)}   ${verdict}`,
      );
    }
  }
  console.log("\n  Числа — ВАЛОВОЕ расхождение лучшей из двух сторон, в бп, ДО издержек.\n");

  if (paper) {
    const s = paper.snapshot();
    console.log(`  ── Бумажный бот: депо $${s.startEquity} → $${s.equity} (${s.pnl >= 0 ? "+" : ""}${s.pnl})`);
    console.log(`     отправлено ордеров ${s.sent}, исполнено ${s.filled}, закрыто сделок ${s.closed}`);
    console.log(`     РЕАЛЬНО: ${s.real >= 0 ? "+" : ""}$${s.real}`);
    console.log(`     наивный счёт (вход по цене обнаружения): ${s.naive >= 0 ? "+" : ""}$${s.naive}`);
    console.log(`     съела задержка ${paper.latencyMs} мс: $${s.slippage}`);
    if (s.closed) {
      console.log("\n     время         монета   увидел  исполнил   реально   наивно");
      for (const t of s.recent) {
        console.log(
          `     ${new Date(t.t).toISOString().slice(11, 19)}   ${t.coin.padEnd(7)} ` +
          `${(t.seenGrossBp + "бп").padStart(8)} ${(t.filledGrossBp + "бп").padStart(9)} ` +
          `${("$" + t.real).padStart(9)} ${("$" + t.naive).padStart(8)}`,
        );
      }
    }
    console.log();
  }
}

// ── Старт ──────────────────────────────────────────────────────────────────
await discoverListings();
process.stderr.write(
  `[xv] старт: ${COINS.length} монет · Kraken ${listed.kr.size} · Binance ${listed.bn.size} · ` +
  `порог HL↔Kraken ${PAIRS[0].costBp} бп → ${OUT_DIR}\n`,
);
const missing = COINS.filter((c) => !listed.kr.has(c));
if (missing.length) process.stderr.write(`[xv] нет на Kraken: ${missing.join(", ")}\n`);

connectHL();
connectKR();
connectBN();
setInterval(flushStats, STATS_MS);
setInterval(writeLive, LIVE_MS);

// Порядок важен: flushStats() опустошает samples, поэтому сводка читает их первой.
const finish = () => { summary(); flushStats(); process.exit(0); };

if (RUN_SECONDS > 0) setTimeout(finish, RUN_SECONDS * 1000);
else process.on("SIGINT", finish);
