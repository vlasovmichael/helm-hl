// ─────────────────────────────────────────────────────────────────────────────
//  dukascopyCandles — минутные свечи СПОТА с публичного datafeed Dukascopy.
//
//  Зачем не Yahoo: там по золоту и индексам только фьючерсы (GC=F, NQ=F), а у
//  канала стопы по 10-15$ — базис фьючерса того же порядка и надёжно не
//  вычитается. Dukascopy отдаёт спот брокерского качества по тем же символам,
//  которыми торгует канал.
//
//  Формат: /datafeed/<SYM>/<YYYY>/<MM-1>/<DD>/<HH>h_ticks.bi5  ⚠️ месяц 0-based.
//  Внутри LZMA-alone, записи по 20 байт BE: ms-от-часа, ask, bid, askVol, bidVol.
//  Цены целые, делятся на 10^digits. Пустой файл = рынок закрыт (выходные).
//
//  Свеча строится по BID, средний спред пишется шестым полем: у золота он
//  доходит до $1 при стопе $13, и в аудите это реальная издержка, не мелочь.
//
//  Фид троттлит (~10 c/файл, при частых запросах 429), поэтому качаем только
//  нужные часы и кэшируем: <SYM>.1m.json = { hours: [...], bars: [[ms,o,h,l,c,spread]] }.
//
//  CLI: node tools/dukascopyCandles.mjs XAUUSD 2026-07-05 2026-09-03
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const DIR = join("data", "tg-signals", "candles");
const DIGITS = { XAUUSD: 3, BTCUSD: 1, USATECHIDXUSD: 3, USA500IDXUSD: 3 };
const CONC = 3;              // выше — фид начинает отвечать 429
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// node:zlib не умеет LZMA-alone, в котором лежит bi5 — распаковываем системным xz.
const unlzma = (buf) => new Promise((res) => {
  const p = execFile("xz", ["--format=lzma", "-dc"], { encoding: "buffer", maxBuffer: 64 << 20 },
    (err, stdout) => res(err && !stdout?.length ? null : stdout));
  p.stdin.on("error", () => {});
  p.stdin.end(buf);
});

async function fetchHour(sym, t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, "0");
  const url = `https://datafeed.dukascopy.com/datafeed/${sym}/${d.getUTCFullYear()}/${p(d.getUTCMonth())}/${p(d.getUTCDate())}/${p(d.getUTCHours())}h_ticks.bi5`;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
      if (res.status === 404) return [];                       // часа нет — как выходной
      if (!res.ok) { await sleep((res.status === 429 ? 4000 : 800) * (i + 1)); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return [];
      const raw = await unlzma(buf);
      if (!raw) return [];
      const k = 10 ** (DIGITS[sym] ?? 5), out = [];
      for (let o = 0; o + 20 <= raw.length; o += 20) {
        out.push([t + raw.readUInt32BE(o), raw.readUInt32BE(o + 4) / k, raw.readUInt32BE(o + 8) / k]);
      }
      return out;
    } catch { await sleep(1000 * (i + 1)); }
  }
  return null;                                                 // не отдался — час помечаем непокрытым
}

function load(sym) {
  const f = join(DIR, `${sym}.1m.json`);
  if (!existsSync(f)) return { hours: new Set(), bars: new Map() };
  const raw = JSON.parse(readFileSync(f, "utf8"));
  return { hours: new Set(raw.hours), bars: new Map(raw.bars.map((b) => [b[0], b])) };
}

function save(sym, st) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${sym}.1m.json`), JSON.stringify({
    hours: [...st.hours].sort((a, b) => a - b),
    bars: [...st.bars.values()].sort((a, b) => a[0] - b[0]),
  }));
}

/** Догружает недостающие часы и возвращает отсортированный массив свечей. */
export async function ensureHours(sym, hoursWanted, onProgress) {
  const st = load(sym);
  const todo = [...new Set(hoursWanted)].filter((h) => !st.hours.has(h)).sort((a, b) => a - b);
  const dg = DIGITS[sym] ?? 5;
  for (let i = 0; i < todo.length; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    const res = await Promise.all(batch.map((t) => fetchHour(sym, t)));
    res.forEach((ticks, j) => {
      if (ticks === null) return;
      st.hours.add(batch[j]);
      for (const [ts, ask, bid] of ticks) {
        const m = ts - (ts % 60_000);
        const b = st.bars.get(m);
        if (!b) st.bars.set(m, [m, bid, bid, bid, bid, ask - bid, 1]);
        else { b[2] = Math.max(b[2], bid); b[3] = Math.min(b[3], bid); b[4] = bid; b[5] += ask - bid; b[6]++; }
      }
    });
    if (i % (CONC * 20) === 0) { save(sym, st); onProgress?.(i + batch.length, todo.length, st.bars.size); }
    await sleep(120);
  }
  for (const b of st.bars.values()) if (b.length === 7) { b[5] = +(b[5] / b[6]).toFixed(dg); b.length = 6; }
  save(sym, st);
  return [...st.bars.values()].sort((a, b) => a[0] - b[0]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sym = process.argv[2] || "XAUUSD";
  const from = Date.parse((process.argv[3] || "2026-07-05") + "T00:00:00Z");
  const to = Date.parse((process.argv[4] || new Date().toISOString().slice(0, 10)) + "T23:00:00Z");
  const hours = [];
  for (let t = from; t <= to; t += 3600_000) hours.push(t);
  const rows = await ensureHours(sym, hours, (d, n, bars) =>
    process.stderr.write(`\r${sym}: ${d}/${n} часов · ${bars} минут   `));
  console.error(`\n${sym}: ${rows.length} свечей, ${new Date(rows[0][0]).toISOString()} … ${new Date(rows.at(-1)[0]).toISOString()}`);
}
