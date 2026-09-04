// ─────────────────────────────────────────────────
//  OI Collector history — витрина долгосрочной истории open interest
// ─────────────────────────────────────────────────
// Читает JSONL, который пишет tools/oiCollector.mjs (раз в 15 мин снимок всех
// монет HL) — у Hyperliquid нет исторического endpoint'а для OI, поэтому это
// единственный источник «как OI менялся во времени». Файл живёт в data-томе
// (тот же контейнер, что и дашборда): data/oi-collector/oi-YYYY-MM.jsonl.
//
// Формат строки: {"t":<ms>, "n":<кол-во>, "d":{ "BTC":{oi,f,px,v}, ... }}
//   oi = openInterest в монетах (USD = oi*px), f = funding/час, px = markPx,
//   v = dayNtlVlm ($).
//
// Это ТОЛЬКО показ данных. Никакого сигнала/эджа из OI тут нет — на вывод
// «есть ли эдж» нужен месяц+ разных режимов, 2 дня = оверфит.
//
// Два endpoint'а:
//   • /api/oi-collector/overview — последний снимок, все монеты, ΔOI 24ч/1ч.
//   • /api/oi-collector/coin?coin=BTC&hours=72 — ряд по одной монете.

// 🚨 ЭТОТ ФАЙЛ УБИВАЛ БОТА. Чтение месячных файлов целиком (два по ~25МБ одной
// строкой + split + разбор всех снимков) давало +175МБ на ОДИН запрос — поверх
// рабочих ~190МБ это FATAL heap limit. Три правила, которые нельзя откатывать
// «для простоты»:
// 1) overview нужны ТРИ снимка (последний, −24ч, −1ч) — читаем хвост файла,
// а не файл;
// 2) coin нужна ОДНА монета — идём построчно и держим одну строку, а не все
// снимки;
// 3) кэшируем маленький готовый ответ, а не сырой массив снимков: прежний
// кэш держал те же сотни мегабайт живыми ещё 30 секунд после ответа.

import { createReadStream } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const OI_DIR = process.env.OI_COLLECTOR_DIR || join("data", "oi-collector");
const CACHE_TTL_MS = 30_000; // коллектор пишет раз в 15 мин — держать 30с достаточно
const META_TTL_MS = 10 * 60_000; // охват истории меняется не чаще снимка

// Хвост читаем окном и удваиваем, пока не накроем нужную глубину. Старт с 4МБ:
// строка снимка ~15КБ, это ~270 снимков ≈ трое суток при 15-минутном шаге.
const TAIL_START_BYTES = 4 * 1024 * 1024;
const TAIL_MAX_BYTES = 48 * 1024 * 1024;

// Готовый ответ overview (килобайты), не сырые снимки.
let overviewCache = { payload: null, at: 0 };
let metaCache = { value: null, at: 0 };

/** Месячные файлы коллектора по возрастанию. Пусто — истории ещё нет. */
async function monthFiles() {
  let names;
  try {
    names = await readdir(OI_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^oi-\d{4}-\d{2}\.jsonl$/.test(n))
    .sort()
    .map((n) => join(OI_DIR, n));
}

/** Быстрый отбор по времени БЕЗ разбора строки: t стоит первым полем. */
export function lineTime(line) {
  const m = /^\{"t":(\d+)/.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * Последние `bytes` байт файла, разбитые на ПОЛНЫЕ строки.
 * Первую строку среза выбрасываем, если резали не от начала файла — она
 * почти наверняка обрезана посередине.
 */
async function readTailLines(path, bytes) {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const start = size - len;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return { lines, wholeFile: start === 0 };
  } finally {
    await fh.close();
  }
}

/**
 * Снимки не старше sinceMs — читая с конца файла и наращивая окно, пока не
 * упрёмся в границу или в начало файла.
 *
 * @returns {{rows: Array<{t:number,d:object}>, reachedBefore: boolean}}
 *   reachedBefore=true — граница sinceMs накрыта этим файлом, предыдущие
 *   месяцы можно не трогать.
 */
async function snapshotsFromTail(path, sinceMs) {
  let bytes = TAIL_START_BYTES;
  for (;;) {
    const { lines, wholeFile } = await readTailLines(path, bytes);
    const rows = [];
    let reachedBefore = false;
    for (const line of lines) {
      const t = lineTime(line);
      if (t == null) continue;
      if (t < sinceMs) { reachedBefore = true; continue; }
      try {
        const o = JSON.parse(line);
        if (o?.d) rows.push({ t, d: o.d });
      } catch { /* битая строка — пропускаем */ }
    }
    // reachedBefore = граница действительно видна в этом файле. Исчерпанный
    // файл её не заменяет: 1-го числа текущий месяц весь свежий, и снимок
    // «сутки назад» лежит в предыдущем — за ним надо идти.
    if (reachedBefore || wholeFile || bytes >= TAIL_MAX_BYTES) {
      return { rows, reachedBefore };
    }
    bytes = Math.min(bytes * 2, TAIL_MAX_BYTES);
  }
}

/** Снимки за последние N мс по всем нужным месячным файлам, по возрастанию t. */
export async function snapshotsSince(sinceMs) {
  const files = await monthFiles();
  let rows = [];
  for (let i = files.length - 1; i >= 0; i--) {
    const got = await snapshotsFromTail(files[i], sinceMs);
    rows = got.rows.concat(rows);
    if (got.reachedBefore) break;
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/**
 * Охват истории для подписи витрины: сколько всего снимков и с какого времени.
 * Считаем переводы строк потоком — память O(1), файл не материализуется.
 */
async function historyMeta() {
  const now = Date.now();
  if (metaCache.value && now - metaCache.at < META_TTL_MS) return metaCache.value;

  const files = await monthFiles();
  let count = 0;
  let firstT = null;
  for (const path of files) {
    await new Promise((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => {
        for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) count += 1;
        if (firstT == null) firstT = lineTime(chunk.subarray(0, 64).toString("utf8"));
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }
  const value = { count, firstT };
  metaCache = { value, at: now };
  return value;
}

// Ближайший снимок к целевому времени (в пределах допуска), иначе null.
function snapshotNear(rows, targetT, tolMs) {
  let best = null;
  let bestDiff = Infinity;
  for (const r of rows) {
    const diff = Math.abs(r.t - targetT);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best && bestDiff <= tolMs ? best : null;
}

const pctChange = (cur, prev) =>
  prev != null && prev !== 0 && cur != null ? ((cur - prev) / prev) * 100 : null;

// Допуск: снимок каждые 15 мин, берём ближайший в пределах ±45 мин от цели.
const TOL = 45 * 60_000;
// Глубина чтения: 24ч назад плюс допуск плюс запас на паузы коллектора.
const LOOKBACK_MS = 24 * 3600_000 + TOL + 3 * 3600_000;

/** Чистая сборка ответа overview (для тестов): снимки → строки таблицы. */
export function buildOverview(rows, meta) {
  const last = rows[rows.length - 1];
  const s24 = snapshotNear(rows, last.t - 24 * 3600_000, TOL);
  const s1h = snapshotNear(rows, last.t - 3600_000, TOL);

  const coins = [];
  for (const [coin, c] of Object.entries(last.d)) {
    const oi = num(c.oi);
    const px = num(c.px);
    if (oi == null || px == null) continue;
    const p24 = s24?.d?.[coin];
    const p1 = s1h?.d?.[coin];
    coins.push({
      coin,
      oi,
      oiUsd: oi * px,
      px,
      f: num(c.f),
      v: num(c.v),
      dOi24hPct: p24 ? pctChange(oi, num(p24.oi)) : null,
      dOi1hPct: p1 ? pctChange(oi, num(p1.oi)) : null,
      dPx24hPct: p24 ? pctChange(px, num(p24.px)) : null,
    });
  }
  coins.sort((a, b) => b.oiUsd - a.oiUsd);
  return {
    ok: true,
    coins,
    // firstT/count — по всей истории (метаданные), а не по прочитанному хвосту:
    // подпись витрины обещает охват, и врать ей нельзя.
    span: { firstT: meta.firstT ?? rows[0].t, lastT: last.t, count: meta.count || rows.length },
    has24h: !!s24,
    has1h: !!s1h,
  };
}

// GET /api/oi-collector/overview
// Последний снимок по всем монетам + ΔOI за 24ч и 1ч (в % от токенов OI) и
// Δ цены за 24ч. Сортировку/фильтр делает фронт — тут отдаём всё как есть.
export async function handleOiOverview(_req, res) {
  const now = Date.now();
  if (overviewCache.payload && now - overviewCache.at < CACHE_TTL_MS) {
    res.json(overviewCache.payload);
    return;
  }

  const rows = await snapshotsSince(now - LOOKBACK_MS);
  if (!rows.length) {
    res.json({ ok: false, reason: "no-data", coins: [], span: null });
    return;
  }
  const payload = buildOverview(rows, await historyMeta());
  overviewCache = { payload, at: now };
  res.json(payload);
}

/** Равномерный даунсэмпл с обязательным сохранением последней точки. */
export function downsample(raw, max) {
  if (raw.length <= max) return raw;
  const step = raw.length / max;
  const points = [];
  for (let i = 0; i < max; i++) points.push(raw[Math.floor(i * step)]);
  if (points[points.length - 1] !== raw[raw.length - 1]) points.push(raw[raw.length - 1]);
  return points;
}

// GET /api/oi-collector/coin?coin=BTC&hours=72
// Ряд по одной монете, даунсэмпл до ~180 точек (график/таблица не тонут).
//
// Идём построчно: в памяти живёт одна строка (~15КБ) и итоговый ряд по одной
// монете. Раньше здесь материализовалась вся история по всем монетам ради
// четырёх чисел на снимок.
export async function handleOiCoin(req, res) {
  const coin = String(req.query.coin || "").trim();
  if (!coin) {
    res.status(400).json({ ok: false, reason: "no-coin" });
    return;
  }
  const hours = Math.min(Math.max(Number(req.query.hours) || 72, 1), 24 * 40);
  const cutoff = Date.now() - hours * 3600_000;

  const raw = [];
  for (const path of await monthFiles()) {
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
      const t = lineTime(line);
      // Отсев по времени до JSON.parse: разбирать 15КБ ради выброса — дорого.
      if (t == null || t < cutoff) continue;
      let c;
      try {
        c = JSON.parse(line)?.d?.[coin];
      } catch {
        continue; // битая строка
      }
      if (!c) continue;
      const oi = num(c.oi);
      const px = num(c.px);
      if (oi == null || px == null) continue;
      raw.push({ t, px, oi, oiUsd: oi * px, f: num(c.f), v: num(c.v) });
    }
  }
  if (!raw.length) {
    res.json({ ok: false, reason: "no-coin-data", coin, points: [] });
    return;
  }
  raw.sort((a, b) => a.t - b.t);
  const points = downsample(raw, 180);
  res.json({ ok: true, coin, hours, points, rawCount: raw.length });
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Только для тестов: сбросить кэши между кейсами. */
export function _resetOiCaches() {
  overviewCache = { payload: null, at: 0 };
  metaCache = { value: null, at: 0 };
}
