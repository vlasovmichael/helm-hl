// ─────────────────────────────────────────────────────────────────────────────
//  Диагностика FVG-будильника: что он видит в базе свечей ПРЯМО СЕЙЧАС.
//
//  🚨 Пуши отсюда НЕ уходят. Будильник живёт в src/modules/fvgAlerts.js внутри
//  процесса бота — только там пуш кормит колокольчик, бейдж и тост дашборда.
//  Этот скрипт нужен, чтобы посмотреть глазами: какие зоны ждут ретеста и какие
//  сетапы сработали бы на заданном окне свежести.
//
//  Сети не касается: читает ту же candles.db, что наполняет форвард-крон.
//  Поэтому «свежесть» здесь ограничена последней свечой в базе.
//
//  Запуск: node scripts/fvgWatch.mjs [--fresh 96] [--read-days 20]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { findLiveSetups, findPendingZones } from '../tools/fvgZones.mjs';
import { PARAMS } from '../tools/fvgRule.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const FRESH_BARS = parseInt(arg('fresh', '1'), 10);
const READ_DAYS = parseInt(arg('read-days', '20'), 10);
const DB_PATH = process.env.FVG_DB || 'candles.db';

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const rows = db.prepare('SELECT coin,t,o,h,l,c FROM candles WHERE t >= ? ORDER BY coin,t')
  .all(Date.now() - READ_DAYS * 86400_000);
db.close();

const byCoin = new Map();
for (const r of rows) { let a = byCoin.get(r.coin); if (!a) byCoin.set(r.coin, (a = [])); a.push(r); }

const fmt = (v) => (v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
let setups = 0, pending = 0;
let lastBar = 0;

for (const [coin, bars] of byCoin) {
  lastBar = Math.max(lastBar, bars[bars.length - 1]?.t ?? 0);
  try {
    for (const z of findPendingZones(coin, bars)) {
      pending++;
      console.log(`[ждёт]  ${coin} ${z.side} зона ${fmt(z.zBot)}…${fmt(z.zTop)} · вход ${fmt(z.entry)}`);
    }
  } catch { /* монета не ломает обход */ }
  try {
    for (const s of findLiveSetups(coin, bars, { freshBars: FRESH_BARS })) {
      setups++;
      console.log(
        `[сетап] ${coin} ${s.side} зона ${s.zoneWidthPct.toFixed(2)}% · вход ${fmt(s.entry)} · ` +
        `стоп ${fmt(s.stop)} (${s.stopDistPct.toFixed(2)}%) · цель ${fmt(s.tgt)} = ${PARAMS.rr}R`,
      );
    }
  } catch { /* монета не ломает обход */ }
}

console.log(
  `\n[диагностика] монет ${byCoin.size} · зон в ожидании ${pending} · ` +
  `сетапов на окне ${FRESH_BARS} бар(а) ${setups}\n` +
  `последняя свеча в базе: ${lastBar ? new Date(lastBar).toISOString() : '—'}`,
);
