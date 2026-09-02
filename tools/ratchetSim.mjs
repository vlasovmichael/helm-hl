// ─────────────────────────────────────────────────────────────────────────────
//  ratchetSim — стоит ли возвращать храповик (перенос стопа в безубыток).
//
//  Храповик выключен с 23.08.2026 (ADOPT_BE_ARM_PCT=999) решением оператора, см.
//  project-restart-2026-08-23. Вопрос «вернуть ли» нельзя решить вкусом: он
//  меняет распределение исходов в обе стороны — спасает сделки, которые были в
//  плюсе и развернулись, и режет те, что сходили в минус и всё равно дошли до
//  цели.
//
//  Как считаем: берём РЕАЛЬНЫЕ входы (adopt), кладём на них план няньки
//  (стоп и цель на одинаковой дистанции, ADOPT_TP_RR=1) и прогоняем по
//  5-минуткам HL два режима — с храповиком и без. Ручные закрытия оператора при
//  этом игнорируются: вопрос именно про правило бота, а не про то, как оператор
//  вмешался.
//
//  ⚠️ Что сравнение НЕ ловит: реальные ручные выходы (медиана 1.13% при цели
//  4.3%). Если оператор продолжит закрывать руками в четверти пути, храповик до
//  многих сделок просто не доживёт.
//
//  Запуск: node tools/ratchetSim.mjs [--days 17] [--stop 4.66] [--rr 1]
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const num = (k, d) => { const v = arg(k, null); return v === null ? d : parseFloat(v); };

const DAYS = num("days", 17);
const STOP_PCT = num("stop", 4.66);   // медиана реальных стопов adopt
const RR = num("rr", 1);
const FEE_R = num("fee", 0);          // комиссия учитывается отдельно, здесь чистая геометрия
const DIR = join("data", "entry-timing");
const ARMS = [0.3, 0.5, 0.7, 1.0];

const archive = JSON.parse(readFileSync(join("data", "history_archive.json"), "utf8"));
const since = Date.now() - DAYS * 864e5;
const trades = archive.filter((r) =>
  r.mode === "PRODUCTION" && r.strategy_id === "adopt" &&
  r.entry_time > since && r.entry_price > 0);

const candles = {};
if (existsSync(DIR)) {
  for (const f of readdirSync(DIR)) {
    const m = f.match(/^(.+)\.5m\.json\.gz$/);
    if (m) candles[m[1]] = JSON.parse(gunzipSync(readFileSync(join(DIR, f))));
  }
}

/**
 * Один прогон сделки по плану няньки.
 * armR — на скольких R переносим стоп в безубыток; null = храповика нет.
 */
function simulate(t, armR) {
  const rows = candles[t.coin];
  if (!rows?.length) return null;
  const long = t.side === "long";
  const e = t.entry_price;
  const risk = e * (STOP_PCT / 100);
  const stop0 = long ? e - risk : e + risk;
  const target = long ? e + risk * RR : e - risk * RR;
  const armPx = armR == null ? null : (long ? e + risk * armR : e - risk * armR);

  let stop = stop0, armed = false;
  for (const [ts, , hi, lo] of rows) {
    if (ts < t.entry_time) continue;
    if (ts > t.entry_time + 72 * 3600_000) break;          // горизонт трое суток
    const hitStop = long ? lo <= stop : hi >= stop;
    const hitTarget = long ? hi >= target : lo <= target;
    const hitArm = armPx != null && (long ? hi >= armPx : lo <= armPx);
    // Пессимизм: в одном баре сначала считаем стоп, потом цель.
    if (hitStop) return armed ? 0 - FEE_R : -1 - FEE_R;
    if (hitTarget) return RR - FEE_R;
    if (hitArm && !armed) { armed = true; stop = e; }
  }
  return null;                                              // не разрешилась в горизонте
}

const fm = (v, n = 2) => (v >= 0 ? "+" : "") + v.toFixed(n);
const modes = [["без храповика", null], ...ARMS.map((a) => [`храповик на ${a}R`, a])];

console.log(`\n═══ храповик: ${trades.length} реальных входов adopt за ${DAYS} дней ═══`);
console.log(`план няньки: стоп ${STOP_PCT}% · цель ${(STOP_PCT * RR).toFixed(2)}% (RR=${RR}) · 5m-свечи · стоп раньше цели в спорном баре\n`);
console.log("  режим                n   цель   безубыток   стоп    сумма R   средний R");

const resolved = [];
for (const [label, armR] of modes) {
  const rs = trades.map((t) => simulate(t, armR)).filter((r) => r != null);
  if (!rs.length) continue;
  const tp = rs.filter((r) => r > 0).length;
  const be = rs.filter((r) => r === 0).length;
  const sl = rs.filter((r) => r < 0).length;
  const sum = rs.reduce((a, b) => a + b, 0);
  resolved.push([label, rs]);
  console.log(`  ${label.padEnd(18)} ${String(rs.length).padStart(3)}  ${String(tp).padStart(5)}  ${String(be).padStart(9)}  ${String(sl).padStart(5)}  ${fm(sum, 1).padStart(9)}  ${fm(sum / rs.length, 3).padStart(10)}`);
}

// сравнение с фактом: что оператор реально получил на этих же входах
const factR = trades
  .filter((t) => t.realized_pnl != null && t.mfe_usd != null && t.mfe_pct > 0.01)
  .map((t) => {
    const notional = Math.abs(t.mfe_usd) / (t.mfe_pct / 100);
    return t.realized_pnl / (notional * (STOP_PCT / 100));    // PnL в долях риска
  });
if (factR.length) {
  const sum = factR.reduce((a, b) => a + b, 0);
  console.log(`\n  ФАКТ (как закрыл оператор)  ${String(factR.length).padStart(3)}${" ".repeat(28)}${fm(sum, 1).padStart(9)}  ${fm(sum / factR.length, 3).padStart(10)}`);
}
console.log();
