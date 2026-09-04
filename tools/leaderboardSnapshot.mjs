// ─────────────────────────────────────────────────
//  leaderboardSnapshot — недельный архив публичного лидерборда Hyperliquid
// ─────────────────────────────────────────────────
// HL отдаёт открытым GET'ом срез по ~41k адресов: PnL/ROI/объём за day/week/
// month/allTime. Срез ТЕКУЩИЙ — история не отдаётся никак. Поэтому единственный
// способ получить честный форвардный тест «сохраняется ли преимущество» —
// копить снимки самим.
//
// Это НЕ торговый путь и НЕ /info: обычный GET на stats-data, весового бюджета
// HL-пула не касается. Fail-soft во всём.
//
// Схема хранения — компактная: полный JSON 33МБ, gzip 3.7МБ, а нам из строки
// нужен только адрес + 4 окна. Пишем массивами чисел → кратно меньше на диске,
// что важно при недельном ритме на Oracle.
//
// 🚨 Снимком кормится ЖИВОЙ предзаявленный тест «Гении Уолл-стрит»: снять сбор
// как «данные под закрытый вопрос» — значит молча оборвать форвард.
//
// Пишем ТОЛЬКО адреса из замороженного списка (выбранные + контроль + широкий),
// ~370 строк вместо 41k. Список заморожен и меняться не может, поэтому метрика
// та же (дельта allTime pnl/vlm по адресу).
// ⛔ Если фильтр не сработал (файла заморозки нет) — пишем всё: потерять
// наблюдение хуже, чем занять диск.

import { gzipSync, gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const FREEZE_FILE = join("docs", "winners-preregistration.json");

/** Адреса замороженного теста — единственные, чьи строки кому-то нужны. */
function watchedAddresses() {
  try {
    const f = JSON.parse(readFileSync(FREEZE_FILE, "utf8"));
    const set = new Set([
      ...(f.selected ?? []).map((s) => s.address),
      ...(f.wide ?? []),
      ...(f.control ?? []),
    ].filter(Boolean).map((a) => a.toLowerCase()));
    return set.size ? set : null;
  } catch {
    return null; // заморозки нет — фильтровать не по чему, пишем всё
  }
}

const URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
export const SNAPSHOT_DIR = join("data", "leaderboard");
const FETCH_TIMEOUT_MS = 120_000; // 33МБ по сети — не быстро
// Ритм ежедневный, а решение по тесту 10.11.2026 — 60 файлов срезали бы начало
// ряда до даты решения. Держим с запасом: при ~40 КБ на снимок это копейки.
const KEEP_SNAPSHOTS = 400;

const WINDOWS = ["day", "week", "month", "allTime"];

/** Строка снимка: [addr, accountValue, ...(pnl,roi,vlm) × 4 окна] = 14 элементов. */
function packRow(r) {
  const out = [r.ethAddress, +r.accountValue];
  for (const w of WINDOWS) {
    const e = r.windowPerformances?.find((x) => x[0] === w);
    out.push(e ? +e[1].pnl : 0, e ? +e[1].roi : 0, e ? +e[1].vlm : 0);
  }
  return out;
}

export function unpackRow(a) {
  const o = { addr: a[0], accountValue: a[1] };
  WINDOWS.forEach((w, i) => {
    o[w] = { pnl: a[2 + i * 3], roi: a[3 + i * 3], vlm: a[4 + i * 3] };
  });
  return o;
}

/**
 * Тянет лидерборд и кладёт снимок. Идемпотентен по дате: повторный вызов в тот
 * же день перезаписывает файл, а не плодит дубли.
 * @returns {Promise<{ok: boolean, file?: string, rows?: number, bytes?: number, reason?: string}>}
 */
export async function captureSnapshot(now = new Date()) {
  let rows;
  try {
    const ctl = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = await fetch(URL, { signal: ctl });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const json = await res.json();
    rows = json?.leaderboardRows;
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: "empty-payload" };
  } catch (err) {
    return { ok: false, reason: `fetch: ${String(err?.message || err)}` };
  }

  // Мёртвые строки (никогда не торговали) в анализе не участвуют и только жрут
  // диск. Фильтр механический, по обороту — НЕ по результату: отбор по PnL
  // сломал бы любой последующий тест на персистентность.
  const watched = watchedAddresses();
  const packed = rows
    .map(packRow)
    .filter((a) => a[13] > 0) // allTime.vlm > 0
    .filter((a) => !watched || watched.has(String(a[0]).toLowerCase()));

  const date = now.toISOString().slice(0, 10);
  const file = join(SNAPSHOT_DIR, `${date}.json.gz`);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const buf = gzipSync(
    Buffer.from(JSON.stringify({ v: 1, capturedAt: now.getTime(), windows: WINDOWS, rows: packed })),
    { level: 9 },
  );
  writeFileSync(file, buf);
  pruneOld();
  return { ok: true, file, rows: packed.length, bytes: buf.length, filtered: Boolean(watched) };
}

function pruneOld() {
  try {
    const files = listSnapshotFiles();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_SNAPSHOTS))) {
      unlinkSync(join(SNAPSHOT_DIR, f));
    }
  } catch {
    /* ретеншен — не повод падать */
  }
}

/** Имена снимков, по возрастанию даты. */
export function listSnapshotFiles() {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  return readdirSync(SNAPSHOT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))
    .sort();
}

/** Метаданные снимков без распаковки — для витрины «сколько накоплено». */
export function listSnapshots() {
  return listSnapshotFiles().map((f) => ({
    date: f.slice(0, 10),
    bytes: statSync(join(SNAPSHOT_DIR, f)).size,
  }));
}

export function readSnapshot(fileOrDate) {
  const f = fileOrDate.endsWith(".gz") ? fileOrDate : `${fileOrDate}.json.gz`;
  const raw = JSON.parse(gunzipSync(readFileSync(join(SNAPSHOT_DIR, f))).toString());
  return { capturedAt: raw.capturedAt, rows: raw.rows.map(unpackRow) };
}

// CLI: node tools/leaderboardSnapshot.mjs
if (process.argv[1]?.endsWith("leaderboardSnapshot.mjs")) {
  const r = await captureSnapshot();
  console.log(
    r.ok
      ? `saved ${r.file} — ${r.rows} rows${r.filtered ? " (только адреса замороженного теста)" : " (БЕЗ фильтра: файл заморозки не прочитан)"}, ${(r.bytes / 1e3).toFixed(1)} KB`
      : `FAILED: ${r.reason}`,
  );
  process.exit(r.ok ? 0 : 1);
}
