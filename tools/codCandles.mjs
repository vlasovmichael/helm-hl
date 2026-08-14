// ─────────────────────────────────────────────────
//  codCandles — свечи С ОБЪЁМОМ под прогон «Монеты дня»
// ─────────────────────────────────────────────────
// Зачем отдельный кэш. data/borrowed/candles хранит [t,o,h,l,c] — объём выброшен,
// потому что нянька его не спрашивала. А у «Монеты дня» два балла из шести
// (volDecay и notCrowded) считаются по объёму, и без него score не дотянет до
// порога 5 НИКОГДА. Прогон на таком кэше померил бы не то правило.
//
// Поэтому свой каталог: data/cod/candles, формат [t,o,h,l,c,v].
//
// ⚠️ Запускать РУКАМИ и НЕ с хоста живого бота: candleSnapshot делит весовой пул
// с торговлей (инцидент 19.07 — голодание пула, бот ослеп).
//
// usage: node tools/codCandles.mjs [days] [interval]

import { gzipSync, gunzipSync } from "node:zlib";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const DIR = join("data", "cod", "candles");
const CHUNK = 5000;
const PAUSE_MS = 150;
const IV_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

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
      if (res.status === 429) { await sleep(2500 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(700 * (i + 1)); }
  }
  return null;
}

export function codPath(coin, interval) {
  return join(DIR, `${coin.replace(/[^A-Za-z0-9_-]/g, "_")}.${interval}.json.gz`);
}

export function loadCod(coin, interval) {
  const p = codPath(coin, interval);
  if (!existsSync(p)) return null;
  return JSON.parse(gunzipSync(readFileSync(p)).toString());
}

async function fetchCoin(coin, interval, startMs, endMs) {
  const step = IV_MS[interval];
  const rows = [];
  let cursor = startMs;
  for (let guard = 0; guard < 100 && cursor < endMs; guard++) {
    const stop = Math.min(endMs, cursor + CHUNK * step);
    const r = await post({ type: "candleSnapshot", req: { coin, interval, startTime: cursor, endTime: stop } });
    await sleep(PAUSE_MS);
    if (!Array.isArray(r) || r.length === 0) { cursor = stop; continue; }
    // v — базовый объём (в монетах), не в долларах. Долларовый считаем как v*close.
    for (const c of r) rows.push([c.t, +c.o, +c.h, +c.l, +c.c, +(c.v ?? 0)]);
    const last = r[r.length - 1].t;
    cursor = last <= cursor ? stop : last + step;
  }
  rows.sort((a, b) => a[0] - b[0]);
  const dedup = [];
  for (const r of rows) if (!dedup.length || dedup[dedup.length - 1][0] !== r[0]) dedup.push(r);
  return dedup;
}

async function main() {
  const days = parseInt(process.argv[2] || "40", 10);
  const interval = process.argv[3] || "15m";
  const end = Date.now();
  const start = end - days * 864e5;

  const meta = await post({ type: "metaAndAssetCtxs" });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  // Порог фетча НАМЕРЕННО низкий и это не мелочь. Фильтровать историю по
  // СЕГОДНЯШНЕМУ обороту — значит выкинуть монеты, которые были ликвидны месяц
  // назад и затихли, то есть отобрать выживших. Гейт MIN_VOL_USD всё равно
  // применяется поштучно на каждом баре, честно из объёма свечей.
  const minVol = Number(process.env.COD_FETCH_MIN_VOL || 300_000);
  const coins = universe
    .map((u, i) => ({ coin: u.name, vol: Number(ctxs[i]?.dayNtlVlm) || 0, delisted: u.isDelisted }))
    .filter((x) => !x.delisted && x.vol >= minVol)
    .map((x) => x.coin);

  console.log(`монет с оборотом ≥$3M: ${coins.length}, окно ${days}д, интервал ${interval}`);
  mkdirSync(DIR, { recursive: true });
  let i = 0, ok = 0;
  for (const coin of coins) {
    i++;
    const cached = loadCod(coin, interval);
    if (cached && cached.start <= start && cached.end >= end - 3600_000) {
      process.stdout.write(`\r[${i}/${coins.length}] ${coin.padEnd(10)} из кэша    `);
      ok++;
      continue;
    }
    try {
      const rows = await fetchCoin(coin, interval, start, end);
      if (rows.length) {
        writeFileSync(codPath(coin, interval),
          gzipSync(Buffer.from(JSON.stringify({ coin, interval, start, end, rows })), { level: 9 }));
        ok++;
      }
      process.stdout.write(`\r[${i}/${coins.length}] ${coin.padEnd(10)} ${String(rows.length).padStart(5)} свечей   `);
    } catch (err) {
      console.log(`\n${coin}: ${err.message}`);
    }
  }
  console.log(`\nготово: ${ok}/${coins.length}`);
}

if (process.argv[1]?.endsWith("codCandles.mjs")) await main();
