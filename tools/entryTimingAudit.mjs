// ─────────────────────────────────────────────────────────────────────────────
//  entryTimingAudit — проверка наблюдения оператора (02.09.2026):
//  «если сижу в монете больше 15 минут и цена не пошла в мою сторону,
//   стоп поймаю в любом случае».
//
//  ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОГОН: в журнале есть mfe_pct/mae_pct, но они посчитаны
//  за ВСЮ жизнь сделки, поэтому «высокий MFE → чаще плюс» — тавтология
//  (закрытая в плюс сделка обязана была побывать в плюсе). Чтобы получить
//  правило, применимое ВО ВРЕМЯ сделки, MFE нужно мерить на РАННЕМ отрезке —
//  этого поля нет, его считаем по свечам.
//
//  Что считает:
//    1. ранний MFE/MAE (5/10/15/30 мин от входа) по минуткам Hyperliquid;
//    2. распределение итога сделки в зависимости от раннего MFE;
//    3. контрфакт «тайм-стоп»: закрыть по рынку на N-й минуте, если к этому
//       моменту сделка не дала +X% в свою сторону. Комиссия закрытия — тейкер.
//
//  ⚠️ Контрфакт считается по фактическим свечам, но это НЕ обещание прибыли:
//  правило подобрано на тех же данных, на которых проверяется. Смотреть на
//  устойчивость по сетке порогов, а не на лучшую клетку.
//
//  Запуск: node tools/entryTimingAudit.mjs [--days 17] [--interval 5m]
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const num = (k, d) => { const v = arg(k, null); return v === null ? d : parseFloat(v); };

const DAYS = num("days", 17);
const INTERVAL = arg("interval", "5m");
const IV_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000 }[INTERVAL];
const TAKER_FEE = num("fee", 0.045) / 100;   // комиссия закрытия в контрфакте
const DIR = join("data", "entry-timing");
const API = "https://api.hyperliquid.xyz/info";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── сделки ──────────────────────────────────────────────────────────────────
const all = JSON.parse(readFileSync(join("data", "history_archive.json"), "utf8"));
const since = Date.now() - DAYS * 864e5;
const trades = all.filter((r) =>
  r.mode === "PRODUCTION" && r.strategy_id === "adopt" &&
  r.entry_time > since && r.mfe_pct != null && r.mfe_usd != null);

// нотионал восстанавливается из пары mfe_usd / mfe_pct — размер позиции в журнале не хранится
for (const t of trades) {
  t.notional = t.mfe_pct > 0.01 ? Math.abs(t.mfe_usd) / (t.mfe_pct / 100) : null;
  t.long = t.side === "long";
}
console.error(`сделок в окне ${DAYS} дн: ${trades.length}, монет: ${new Set(trades.map((t) => t.coin)).size}`);

// ── свечи ───────────────────────────────────────────────────────────────────
async function post(body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) { await sleep(2500 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(700 * (i + 1)); }
  }
  return null;
}

async function candles(coin, startMs, endMs) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const f = join(DIR, `${coin}.${INTERVAL}.json.gz`);
  if (existsSync(f)) {
    const rows = JSON.parse(gunzipSync(readFileSync(f)));
    if (rows.length && rows[0][0] <= startMs && rows.at(-1)[0] >= endMs - IV_MS) return rows;
  }
  const out = [];
  let t = startMs;
  while (t < endMs) {
    const r = await post({ type: "candleSnapshot", req: { coin, interval: INTERVAL, startTime: t, endTime: endMs } });
    if (!r?.length) break;
    for (const c of r) out.push([c.t, +c.o, +c.h, +c.l, +c.c]);
    const last = r.at(-1).t;
    if (last <= t) break;
    t = last + IV_MS;
    await sleep(200);
  }
  out.sort((a, b) => a[0] - b[0]);
  writeFileSync(f, gzipSync(JSON.stringify(out)));
  return out;
}

const coins = [...new Set(trades.map((t) => t.coin))];
const data = {};
for (const c of coins) {
  data[c] = await candles(c, since - 2 * 3600_000, Date.now());
  process.stderr.write(`\rсвечи: ${Object.keys(data).length}/${coins.length}   `);
}
process.stderr.write("\r".padEnd(40) + "\r");

// ── ранние MFE/MAE ──────────────────────────────────────────────────────────
const MARKS = [5, 10, 15, 30];
const scored = [];
for (const t of trades) {
  const rows = data[t.coin];
  if (!rows?.length) continue;
  const e = t.entry_price;
  const early = {};
  let ok = true;
  for (const m of MARKS) {
    const till = t.entry_time + m * 60_000;
    const seg = rows.filter((r) => r[0] >= t.entry_time - IV_MS && r[0] <= till);
    if (!seg.length) { ok = false; break; }
    const hi = Math.max(...seg.map((r) => r[2])), lo = Math.min(...seg.map((r) => r[3]));
    // в его сторону — вверх для лонга, вниз для шорта
    early[m] = {
      mfe: t.long ? (hi - e) / e * 100 : (e - lo) / e * 100,
      mae: t.long ? (lo - e) / e * 100 : (e - hi) / e * 100,
      close: seg.at(-1)[4],
    };
  }
  if (!ok) continue;
  scored.push({ ...t, early });
}
console.error(`со свечами: ${scored.length} из ${trades.length}\n`);

// ── 1. итог в зависимости от раннего MFE ────────────────────────────────────
const fm = (v, n = 2) => (v >= 0 ? "+" : "") + v.toFixed(n);
for (const m of MARKS) {
  console.log(`── что дала сделка, если за первые ${m} мин максимум в плюс был: ──`);
  for (const [a, b] of [[-99, 0.25], [0.25, 0.5], [0.5, 1], [1, 99]]) {
    const rs = scored.filter((x) => x.early[m].mfe >= a && x.early[m].mfe < b);
    if (!rs.length) continue;
    const pnl = rs.reduce((s, x) => s + x.realized_pnl, 0);
    const w = rs.filter((x) => x.realized_pnl > 0).length;
    const lbl = b === 99 ? `>${a}%` : `${Math.max(a, 0)}-${b}%`;
    console.log(`   ${lbl.padEnd(10)} n=${String(rs.length).padStart(3)}  WR=${((w / rs.length) * 100).toFixed(0).padStart(3)}%  сумма ${fm(pnl).padStart(7)}  средняя ${fm(pnl / rs.length, 3)}`);
  }
  console.log();
}

// ── 2. контрфакт: тайм-стоп ─────────────────────────────────────────────────
console.log("── контрфакт «выйти по рынку на N-й минуте, если к ней плюс меньше порога» ──");
console.log("   (факт по всем сделкам: " + fm(scored.reduce((s, x) => s + x.realized_pnl, 0)) + ")\n");
console.log("   порог\\N " + MARKS.map((m) => `${m}мин`.padStart(9)).join(""));
for (const thr of [0, 0.25, 0.5, 0.75, 1.0]) {
  const cells = [];
  for (const m of MARKS) {
    let pnl = 0;
    for (const x of scored) {
      if (x.early[m].mfe < thr) {          // правило сработало — закрываем по рынку
        const px = x.early[m].close;
        const gross = (x.long ? px - x.entry_price : x.entry_price - px) / x.entry_price * (x.notional ?? 0);
        pnl += gross - (x.notional ?? 0) * TAKER_FEE;
      } else pnl += x.realized_pnl;        // правило молчит — сделка как была
    }
    cells.push(fm(pnl).padStart(9));
  }
  console.log(`   ${(thr + "%").padEnd(7)}` + cells.join(""));
}
console.log();
