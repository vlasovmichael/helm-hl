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
// «есть ли эдж» нужен месяц+ разных режимов, 2 дня = оверфит (2026-07-14).
//
// Два endpoint'а:
//   • /api/oi-collector/overview — последний снимок, все монеты, ΔOI 24ч/1ч.
//   • /api/oi-collector/coin?coin=BTC&hours=72 — ряд по одной монете.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const OI_DIR = join("data", "oi-collector");
const CACHE_TTL_MS = 30_000; // коллектор пишет раз в 15 мин — держать 30с достаточно

// Парсенный кэш файла(ов): { rows:[{t,d}], loadedAt }
let cache = { rows: null, loadedAt: 0 };

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7); // YYYY-MM
}

// Загружает текущий + предыдущий месячные файлы (перекрытие на границе месяца
// нужно для корректной Δ24ч в первые сутки нового месяца). Отсутствие файла —
// не ошибка (просто ещё нет истории). Результат отсортирован по t.
async function loadRows() {
  const now = Date.now();
  if (cache.rows && now - cache.loadedAt < CACHE_TTL_MS) return cache.rows;

  const months = [monthKey(now - 32 * 864e5), monthKey(now)];
  const uniq = [...new Set(months)];
  const rows = [];
  for (const m of uniq) {
    let text;
    try {
      text = await readFile(join(OI_DIR, `oi-${m}.jsonl`), "utf8");
    } catch {
      continue; // файла за этот месяц нет
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.t === "number" && o.d) rows.push({ t: o.t, d: o.d });
      } catch {
        /* битая строка — пропускаем */
      }
    }
  }
  rows.sort((a, b) => a.t - b.t);
  cache = { rows, loadedAt: now };
  return rows;
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

// GET /api/oi-collector/overview
// Последний снимок по всем монетам + ΔOI за 24ч и 1ч (в % от токенов OI) и
// Δ цены за 24ч. Сортировку/фильтр делает фронт — тут отдаём всё как есть.
export async function handleOiOverview(_req, res) {
  const rows = await loadRows();
  if (!rows.length) {
    res.json({ ok: false, reason: "no-data", coins: [], span: null });
    return;
  }
  const last = rows[rows.length - 1];
  const first = rows[0];
  // Допуск: снимок каждые 15 мин, берём ближайший в пределах ±45 мин от цели.
  const TOL = 45 * 60_000;
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
  res.json({
    ok: true,
    coins,
    span: { firstT: first.t, lastT: last.t, count: rows.length },
    has24h: !!s24,
    has1h: !!s1h,
  });
}

// GET /api/oi-collector/coin?coin=BTC&hours=72
// Ряд по одной монете, даунсэмпл до ~180 точек (график/таблица не тонут).
export async function handleOiCoin(req, res) {
  const coin = String(req.query.coin || "").trim();
  if (!coin) {
    res.status(400).json({ ok: false, reason: "no-coin" });
    return;
  }
  const hours = Math.min(Math.max(Number(req.query.hours) || 72, 1), 24 * 40);
  const rows = await loadRows();
  const cutoff = Date.now() - hours * 3600_000;

  const raw = [];
  for (const r of rows) {
    if (r.t < cutoff) continue;
    const c = r.d[coin];
    if (!c) continue;
    const oi = num(c.oi);
    const px = num(c.px);
    if (oi == null || px == null) continue;
    raw.push({ t: r.t, px, oi, oiUsd: oi * px, f: num(c.f), v: num(c.v) });
  }
  if (!raw.length) {
    res.json({ ok: false, reason: "no-coin-data", coin, points: [] });
    return;
  }
  // Даунсэмпл равномерно, но всегда сохраняем последнюю точку.
  const MAX = 180;
  let points = raw;
  if (raw.length > MAX) {
    const step = raw.length / MAX;
    points = [];
    for (let i = 0; i < MAX; i++) points.push(raw[Math.floor(i * step)]);
    if (points[points.length - 1] !== raw[raw.length - 1]) points.push(raw[raw.length - 1]);
  }
  res.json({ ok: true, coin, hours, points, rawCount: raw.length });
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
