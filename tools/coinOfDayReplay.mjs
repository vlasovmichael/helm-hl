// ─────────────────────────────────────────────────
//  coinOfDayReplay — прогон карточки «Монета дня» назад по истории
// ─────────────────────────────────────────────────
// Зачем (2026-08-14). Карточка пишет пики в coin_of_day_picks с 26.07 и уже
// накопила 13 закрытых: сумма +1.59R, в среднем +0.12R на пик. Выглядит плюсово
// и не значит НИЧЕГО: разброс 0.93R, ошибка среднего 0.26 ⇒ t=0.47. Чтобы этот
// +0.12R отличить от нуля, нужно ~470 пиков. Карточка даёт один в день — это
// пятнадцать месяцев ожидания.
//
// 🔑 Узкое место не в том, что мало ждали, а в том, что правило ЖДЁТ события
// вместо того, чтобы посчитать себя назад по всем монетам за все дни. Прогон
// снимает именно это ограничение: 30 монет × 40 дней вместо одного пика в сутки.
//
// ── Гоняем ЖИВУЮ функцию, а не копию ───────────────────────────────────────
// Импортируется analyzeCoin из src/modules/coinOfDay.js. Переписывать правило
// своими руками нельзя: получится замер моей копии, а торгуешь ты оригинал.
//
// ── Чего не хватает и что из этого следует ─────────────────────────────────
// Исторического OI нет (коллектор пишет форвардно и с дырами), поэтому балл
// notCrowded недоступен и всегда false. Значит потолок score здесь 5, а не 6,
// и живой порог LOG_MIN_SCORE=5 недостижим по построению. Сравниваем по пяти
// доступным баллам и говорим об этом вслух, а не подгоняем порог молча.
//
// volume24hUsd считается честно из свечей (v × close за 96 баров), поэтому
// гейт MIN_VOL_USD и балл volDecay работают как в проде.
//
// ── ПРЕДЗАЯВКА (до первого прогона) ────────────────────────────────────────
//   вход      close бара, на котором сработало правило
//   стоп/цель из levels, которые вернула сама analyzeCoin
//   выход     стоп → −1R · цель → +rr R · иначе через TIME_STOP_MIN → ход/риск
//   если в одном баре задеты и стоп и цель — считаем СТОП (в мою пользу нельзя)
//   дедуп     сработавшая монета молчит 24ч (карточка даёт один пик в день)
//   вердикт   эдж засчитан, только если ДИ среднего R по монетам не задевает
//             ноль И превышает обе нулевые модели
//
// Нулевые модели:
//   coin — тот же момент и та же сторона, но СЛУЧАЙНАЯ монета. Ломает отбор.
//   time — та же монета и сторона, но СЛУЧАЙНЫЙ момент. Ломает тайминг.
// Обе наследуют riskPct и rr настоящего пика: сравнивать надо сделки одной
// геометрии, иначе померим разницу стопов, а не разницу входов.
//
// ⚠️ 40 дней = ОДИН режим рынка. По правилу от 07.08 вывод на одном режиме
// результатом не считается, каким бы n ни был.
//
// usage: NODE_ENV=test node tools/coinOfDayReplay.mjs [--minScore=4] [--seed=1]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

process.env.PUBLIC_WALLET_ADDRESS = "0x0000000000000000000000000000000000000000";
process.env.TELEGRAM_BOT_TOKEN = "";

const { analyzeCoin, COD, JOURNAL_BANNED } = await import("../src/modules/coinOfDay.js");
const { rng } = await import("./baseline.mjs");

const DIR = join("data", "cod", "candles");
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? Number(h.split("=")[1]) : d;
};
const MIN_SCORE = arg("minScore", 4);   // из 5 доступных (шестой балл — OI — недоступен)
const SEED = arg("seed", 1);
const BAR = 900_000;                    // 15m
const H1 = 4;                           // 15m ×4 = 1h
const COOLDOWN_MS = 24 * 3600_000;
const HORIZON_BARS = Math.ceil(COD.TIME_STOP_MIN / 15);

// ── загрузка ──
function load() {
  const out = new Map();
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".15m.json.gz"))) {
    const p = JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString());
    if (!p.rows || p.rows.length < 400) continue;
    if (JOURNAL_BANNED.has(p.coin)) continue;  // карточка их не показывает
    out.set(p.coin, p.rows);
  }
  return out;
}

const c15obj = (r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], vol: r[5] });

/** 15m → 1h, объём суммируем (нужен для volDecay/оборота). */
function toH1(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const b = Math.floor(r[0] / (BAR * H1)) * (BAR * H1);
    if (!cur || cur.time !== b) { if (cur) out.push(cur); cur = { time: b, open: r[1], high: r[2], low: r[3], close: r[4], vol: r[5] }; }
    else { cur.high = Math.max(cur.high, r[2]); cur.low = Math.min(cur.low, r[3]); cur.close = r[4]; cur.vol += r[5]; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Проходит вперёд от бара i и возвращает результат в R. */
function simulate(rows, i, side, entry, stop, target, riskPct) {
  const isShort = side === "SHORT";
  const rr = Math.abs(target - entry) / Math.abs(stop - entry);
  const end = Math.min(rows.length - 1, i + HORIZON_BARS);
  for (let k = i + 1; k <= end; k++) {
    const hi = rows[k][2], lo = rows[k][3];
    const hitStop = isShort ? hi >= stop : lo <= stop;
    const hitTgt = isShort ? lo <= target : hi >= target;
    if (hitStop) return { r: -1, how: "stop" };      // при двойном касании — стоп
    if (hitTgt) return { r: rr, how: "target" };
  }
  const px = rows[end][4];
  const movePct = isShort ? ((entry - px) / entry) * 100 : ((px - entry) / entry) * 100;
  return { r: movePct / riskPct, how: "timeout" };
}

// ── поиск пиков ──
const data = load();
console.log(`монет: ${data.size}, порог score ≥${MIN_SCORE} из 5 (балл notCrowded недоступен — нет истории OI)`);

const h1Map = new Map();
for (const [coin, rows] of data) h1Map.set(coin, toH1(rows));

const picks = [];
for (const [coin, rows] of data) {
  const h1 = h1Map.get(coin);
  let mutedUntil = 0;
  // Стартуем, когда набралось 72 часа истории; шаг — 1 час.
  for (let i = 72 * H1; i < rows.length - HORIZON_BARS; i += H1) {
    const t = rows[i][0];
    if (t < mutedUntil) continue;
    const price = rows[i][4];
    const c1h = h1.filter((b) => b.time <= t).slice(-72);
    if (c1h.length < 26) continue;
    const c15 = rows.slice(Math.max(0, i - 96), i + 1).map(c15obj);
    const vol24 = c15.slice(-96).reduce((s, c) => s + c.vol * c.close, 0);
    if (vol24 < COD.MIN_VOL_USD) continue;

    let a = null;
    try {
      a = analyzeCoin({ coin, price, oiUsd: null, fundingRate: null, volume24hUsd: vol24, c1h, c15 });
    } catch { continue; }
    if (!a || !a.levels) continue;
    if (a.score < MIN_SCORE) continue;
    const L = a.levels;
    if (!(L.rr >= COD.MIN_RR) || !(L.riskPct > 0)) continue;

    picks.push({ coin, i, t, side: a.side, score: a.score, entry: price, stop: L.stop, target: L.target, riskPct: L.riskPct, rr: L.rr });
    mutedUntil = t + COOLDOWN_MS;
  }
}
console.log(`пиков найдено: ${picks.length}`);
if (!picks.length) { console.log("нечего мерить"); process.exit(0); }

// ── настоящие сделки ──
for (const p of picks) Object.assign(p, simulate(data.get(p.coin), p.i, p.side, p.entry, p.stop, p.target, p.riskPct));

// ── нулевые модели ──
const rnd = rng(SEED);
const coins = [...data.keys()];
function nullCoin(p) {
  for (let tries = 0; tries < 20; tries++) {
    const c = coins[Math.floor(rnd() * coins.length)];
    if (c === p.coin) continue;
    const rows = data.get(c);
    const j = rows.findIndex((r) => r[0] >= p.t);
    if (j < 1 || j >= rows.length - HORIZON_BARS) continue;
    const e = rows[j][4];
    const st = p.side === "SHORT" ? e * (1 + p.riskPct / 100) : e * (1 - p.riskPct / 100);
    const tg = p.side === "SHORT" ? e * (1 - (p.riskPct * p.rr) / 100) : e * (1 + (p.riskPct * p.rr) / 100);
    return simulate(rows, j, p.side, e, st, tg, p.riskPct);
  }
  return null;
}
function nullTime(p) {
  const rows = data.get(p.coin);
  for (let tries = 0; tries < 20; tries++) {
    const j = 72 * H1 + Math.floor(rnd() * (rows.length - 72 * H1 - HORIZON_BARS - 1));
    if (j < 1) continue;
    const e = rows[j][4];
    const st = p.side === "SHORT" ? e * (1 + p.riskPct / 100) : e * (1 - p.riskPct / 100);
    const tg = p.side === "SHORT" ? e * (1 - (p.riskPct * p.rr) / 100) : e * (1 + (p.riskPct * p.rr) / 100);
    return simulate(rows, j, p.side, e, st, tg, p.riskPct);
  }
  return null;
}

// ── статистика: ДИ по МОНЕТАМ (пики внутри монеты не независимы) ──
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function byCoinCI(pairs) {  // [{coin, r}]
  const g = new Map();
  for (const { coin, r } of pairs) { if (!g.has(coin)) g.set(coin, []); g.get(coin).push(r); }
  const per = [...g.values()].filter((v) => v.length >= 2).map(mean);
  if (per.length < 2) return null;
  const m = mean(per), se = sd(per) / Math.sqrt(per.length);
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, coins: per.length };
}
const fmt = (c) => c ? `${c.m >= 0 ? "+" : ""}${c.m.toFixed(3)}R  [${c.lo.toFixed(3)} … ${c.hi.toFixed(3)}]  монет ${c.coins}` : "мало данных";

const real = picks.map((p) => ({ coin: p.coin, r: p.r }));
const nc = [], nt = [];
for (const p of picks) {
  const a = nullCoin(p); if (a) nc.push({ coin: p.coin, r: a.r });
  const b = nullTime(p); if (b) nt.push({ coin: p.coin, r: b.r });
}

console.log("\n─── РЕЗУЛЬТАТ (среднее R на пик, ДИ по монетам) ───");
console.log("настоящие пики  ", fmt(byCoinCI(real)));
console.log("нулевая «монета»", fmt(byCoinCI(nc)));
console.log("нулевая «время» ", fmt(byCoinCI(nt)));

const how = {};
for (const p of picks) how[p.how] = (how[p.how] || 0) + 1;
console.log("\nисходы:", JSON.stringify(how), "| сумма R:", picks.reduce((s, p) => s + p.r, 0).toFixed(1));
const sides = {};
for (const p of picks) { const k = p.side; (sides[k] = sides[k] || []).push(p.r); }
for (const [k, v] of Object.entries(sides)) console.log(`  ${k}: n=${v.length} среднее ${mean(v).toFixed(3)}R`);

const R = byCoinCI(real), C = byCoinCI(nc), T = byCoinCI(nt);
console.log("\n─── ВЕРДИКТ (по правилу, объявленному до прогона) ───");
if (!R) console.log("данных не хватает");
else {
  const beatsZero = R.lo > 0;
  const beatsNull = C && T && R.lo > C.m && R.lo > T.m;
  console.log(`  ДИ не задевает ноль: ${beatsZero ? "ДА" : "НЕТ"}`);
  console.log(`  превышает обе нулевые: ${beatsNull ? "ДА" : "НЕТ"}`);
  console.log(`  ⇒ эдж ${beatsZero && beatsNull ? "ЗАСЧИТАН (на ОДНОМ режиме — не результат)" : "НЕ засчитан"}`);
}
