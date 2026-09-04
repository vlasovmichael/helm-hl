// ─────────────────────────────────────────────────
//  borrowedEntriesCandles — минутные свечи под прогон чужих входов
// ─────────────────────────────────────────────────
// Кэш на диске: повторный прогон правил выхода не должен дёргать сеть. Один
// файл на монету, компактно (implicit-время не годится — у HL бывают дыры,
// поэтому храним [t,o,h,l,c] массивами).
//
// ⚠️ Руками, не с хоста живого бота: candleSnapshot делит весовой пул с торговлей.

import { gzipSync, gunzipSync } from "node:zlib";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const DIR = join("data", "borrowed", "candles");
const CHUNK = 5000; // потолок ответа HL
const PAUSE_MS = 200;

// HL хранит ~5000 свечей на интервал, дальше история просто отсутствует:
// 1m → 3.5 дня · 5m → 17.4 дня · 15m → 52 дня · 1h → 60 дней.
// 5m — компромисс: правила няньки срабатывают на движениях 1.5-2%, на 15m такой
// тайминг размазывается, а 1m даёт слишком короткое окно для набора сделок.
export const INTERVAL = process.env.BORROWED_INTERVAL || "5m";
const IV_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
const MIN_MS = IV_MS[INTERVAL] || 300_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        await sleep(2500 * (i + 1));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(700 * (i + 1));
    }
  }
  return null;
}

export function candlePath(coin) {
  return join(DIR, `${coin.replace(/[^A-Za-z0-9_-]/g, "_")}.${INTERVAL}.json.gz`);
}

export function loadCandles(coin) {
  const p = candlePath(coin);
  if (!existsSync(p)) return null;
  return JSON.parse(gunzipSync(readFileSync(p)).toString());
}

/** Тянет 1m свечи [startMs, endMs] чанками и кладёт в кэш. */
export async function ensureCandles(coin, startMs, endMs) {
  const cached = loadCandles(coin);
  if (cached && cached.start <= startMs && cached.end >= endMs) return cached;

  const from = Math.min(startMs, cached?.start ?? startMs);
  const to = Math.max(endMs, cached?.end ?? endMs);
  const rows = [];
  let cursor = from;
  for (let guard = 0; guard < 200 && cursor < to; guard++) {
    const stop = Math.min(to, cursor + CHUNK * MIN_MS);
    const r = await post({ type: "candleSnapshot", req: { coin, interval: INTERVAL, startTime: cursor, endTime: stop } });
    await sleep(PAUSE_MS);
    if (!Array.isArray(r) || r.length === 0) {
      cursor = stop; // дыра в данных — шагаем дальше, а не встаём
      continue;
    }
    for (const c of r) rows.push([c.t, +c.o, +c.h, +c.l, +c.c]);
    const last = r[r.length - 1].t;
    cursor = last <= cursor ? stop : last + MIN_MS;
  }

  rows.sort((a, b) => a[0] - b[0]);
  const dedup = [];
  for (const r of rows) if (!dedup.length || dedup[dedup.length - 1][0] !== r[0]) dedup.push(r);

  const payload = { coin, interval: INTERVAL, start: from, end: to, rows: dedup };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(candlePath(coin), gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
  return payload;
}

async function main() {
  const tripsFile = process.argv[2];
  const horizonH = parseInt(process.argv[3] || "72", 10);
  if (!tripsFile) {
    console.error("usage: node tools/borrowedEntriesCandles.mjs <trips.json> [horizonHours]");
    process.exit(1);
  }
  const { trips } = JSON.parse(readFileSync(tripsFile));

  // ATR(1h,14) считается по барам ДО входа — нужно ~16 часов предыстории, иначе
  // atrPctAtEntry вернёт null и стоп у всех свалится на фолбэк 5%, превратив
  // замер ATR-стопа в замер фиксированного. Берём сутки с запасом.
  const PREROLL_MS = 24 * 3600_000;

  const need = new Map();
  for (const t of trips) {
    const from = t.entryTime - PREROLL_MS;
    const to = Math.min(Date.now(), Math.max(t.exitTime, t.entryTime + horizonH * 3600_000) + MIN_MS);
    const cur = need.get(t.coin) || { from, to, n: 0 };
    cur.from = Math.min(cur.from, from);
    cur.to = Math.max(cur.to, to);
    cur.n++;
    need.set(t.coin, cur);
  }

  const coins = [...need.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`монет: ${coins.length}, круговых: ${trips.length}`);
  let i = 0;
  for (const [coin, w] of coins) {
    i++;
    const days = ((w.to - w.from) / 864e5).toFixed(1);
    try {
      const c = await ensureCandles(coin, w.from, w.to);
      process.stdout.write(`\r[${i}/${coins.length}] ${coin.padEnd(10)} ${days}д → ${String(c.rows.length).padStart(6)} свечей   `);
    } catch (err) {
      console.log(`\n${coin}: ошибка ${err.message}`);
    }
  }
  console.log("\nготово");
}

if (process.argv[1]?.endsWith("borrowedEntriesCandles.mjs")) await main();
