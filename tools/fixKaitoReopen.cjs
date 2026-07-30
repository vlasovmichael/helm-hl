#!/usr/bin/env node
// Разовая правка history: KAITO 30.07.2026, «закрыл руками → перезашёл».
//
// Что случилось. В 11:25:59 UTC оператор закрыл шорт 28 @1.0637 руками (+$1.7556)
// за секунду до того, как бот послал свой трейл-close. Биржа отвергла
// reduce-only ордер бота («would increase position»), бот только залогировал
// ERROR — DB-строка осталась OPEN со СТАРЫМ entry $1.1264. Через 41с оператор
// перезашёл шортом 29 @1.0371; для liveMatchesPosition (монета+сторона) это
// «та же поза», поэтому строка жила дальше. В 11:34 трейл закрыл уже ЧУЖУЮ
// позу и посчитал PnL против входа 1.1264 → в history легли фиктивные +$1.9418
// вместо реальных −$0.5977, а прибыльная ручная нога (+$1.7168) не легла вовсе.
//
// Код починен двумя гардами (isPositionGoneRejection в executor/close.js,
// isReopenedPosition/classifyEntryDrift в app/integrity.js). Здесь — только
// разбор уже записанного мусора.
//
// Цифры — из HL fills (истина), oid'ы для сверки:
//   Open  Short 28 @1.1264  10:45:33.126  fee 0.019931  oid 506110374598
//   Close Short 28 @1.0637  11:25:59.595  pnl +1.7556  fee 0.018822  oid 506130373971 (рука)
//   Open  Short 29 @1.0371  11:26:40.697  fee 0.019007  oid 506130657923
//   Close Short 29 @1.0566  11:34:31.496  pnl −0.5655  fee 0.013237  oid 506133939767 (бот)
//
// Запуск (идемпотентно, повторный вызов ничего не делает):
//   ssh oracle 'docker exec -i hl-paper-scanner node -' < tools/fixKaitoReopen.cjs

const DB_PATH = process.env.TRADES_DB || '/app/data/trades.db';
const db = require('better-sqlite3')(DB_PATH);

const TARGET_ID = 1117;
const MANUAL_CLOSED_AT = 1785410759595;   // 11:25:59.595Z — ключ идемпотентности

// ── Нога 1: ручной round-trip 10:45:33 → 11:25:59 (бот НЕ закрывал) ──
const leg1 = {
  coin: 'KAITO', side: 'short', mode: 'PRODUCTION', strategy_id: 'adopt',
  entry_price: 1.1264, close_price: 1.0637,
  realized_pnl: 1.7556 - (0.019931 + 0.018822),   // контракт БД: net = gross − комса обеих ног
  fee_paid: 0.019931 + 0.018822,
  entry_time: 1785408333126, closed_at: MANUAL_CLOSED_AT,
  hold_seconds: Math.round((MANUAL_CLOSED_AT - 1785408333126) / 1000),
  reason: 'manual_close', entry_hour_utc: 10,
};

// ── Нога 2 (=строка 1117): то, что БОТ реально закрыл трейлом ──
const leg2 = {
  entry_price: 1.0371, close_price: 1.0566,
  realized_pnl: -0.5655 - (0.019007 + 0.013237),
  fee_paid: 0.019007 + 0.013237,
  entry_time: 1785410800697, closed_at: 1785411271496,
  hold_seconds: Math.round((1785411271496 - 1785410800697) / 1000),
  entry_hour_utc: 11,
};

const old = db.prepare('SELECT * FROM history WHERE id=?').get(TARGET_ID);
if (!old) {
  console.log(`строки #${TARGET_ID} нет (уже заархивирована?) — правка не применена`);
  process.exit(0);
}
if (old.coin !== 'KAITO' || old.side !== 'short') {
  throw new Error(`#${TARGET_ID} — это ${old.coin} ${old.side}, не KAITO short. Стоп.`);
}
if (Math.abs(old.entry_price - leg2.entry_price) < 1e-9) {
  console.log('правка уже применена (entry #1117 = 1.0371) — ничего не делаю');
  process.exit(0);
}
const dup = db.prepare('SELECT id FROM history WHERE coin=? AND closed_at=?')
  .get('KAITO', MANUAL_CLOSED_AT);
if (dup) throw new Error(`ручная нога уже есть (id=${dup.id}) — проверь состояние вручную`);

const tx = db.transaction(() => {
  // Ногу 1 вставляем, унаследовав entry-фичи: они снимались на входе 10:45 и
  // принадлежат ЕЙ, а не перезаходу.
  const info = db.prepare(`INSERT INTO history
    (coin, entry_price, close_price, realized_pnl, fee_paid, mode, closed_at, reason,
     strategy_id, side, entry_spike_pct, entry_trend_15m_pct, entry_trend_1h_pct,
     entry_funding_rate, entry_volume_24h_usd, entry_oi_usd, entry_hour_utc,
     hold_seconds, entry_time, entry_oi_delta_2m, entry_oi_delta_5m, entry_oi_delta_15m)
    VALUES (@coin,@entry_price,@close_price,@realized_pnl,@fee_paid,@mode,@closed_at,@reason,
     @strategy_id,@side,@entry_spike_pct,@entry_trend_15m_pct,@entry_trend_1h_pct,
     @entry_funding_rate,@entry_volume_24h_usd,@entry_oi_usd,@entry_hour_utc,
     @hold_seconds,@entry_time,@entry_oi_delta_2m,@entry_oi_delta_5m,@entry_oi_delta_15m)`).run({
    ...leg1,
    entry_spike_pct: old.entry_spike_pct, entry_trend_15m_pct: old.entry_trend_15m_pct,
    entry_trend_1h_pct: old.entry_trend_1h_pct, entry_funding_rate: old.entry_funding_rate,
    entry_volume_24h_usd: old.entry_volume_24h_usd, entry_oi_usd: old.entry_oi_usd,
    entry_oi_delta_2m: old.entry_oi_delta_2m, entry_oi_delta_5m: old.entry_oi_delta_5m,
    entry_oi_delta_15m: old.entry_oi_delta_15m,
  });

  // 1117 переписываем на реальную ногу бота. MFE/MAE обнуляем: они мерились от
  // чужого входа 1.1264 (пик +8.80% — артефакт), пересчитать из сохранённого нельзя.
  db.prepare(`UPDATE history SET
      entry_price=@entry_price, close_price=@close_price, realized_pnl=@realized_pnl,
      fee_paid=@fee_paid, entry_time=@entry_time, closed_at=@closed_at,
      hold_seconds=@hold_seconds, entry_hour_utc=@entry_hour_utc,
      mfe_usd=NULL, mae_usd=NULL, mfe_pct=NULL, mae_pct=NULL,
      entry_spike_pct=NULL, entry_trend_15m_pct=NULL, entry_trend_1h_pct=NULL,
      entry_funding_rate=NULL, entry_volume_24h_usd=NULL, entry_oi_usd=NULL,
      entry_oi_delta_2m=NULL, entry_oi_delta_5m=NULL, entry_oi_delta_15m=NULL
    WHERE id=@id`).run({ ...leg2, id: TARGET_ID });

  return info.lastInsertRowid;
});

console.log('вставлена ручная нога id =', tx());
for (const r of db.prepare(`SELECT id,entry_price,close_price,realized_pnl,fee_paid,reason,hold_seconds,
    datetime(entry_time/1000,'unixepoch') e, datetime(closed_at/1000,'unixepoch') c
  FROM history WHERE coin='KAITO' ORDER BY closed_at`).all()) {
  console.log(`#${r.id} ${r.e}→${r.c} entry=${r.entry_price} close=${r.close_price} ` +
    `net=${r.realized_pnl.toFixed(4)} fee=${r.fee_paid.toFixed(6)} ${r.reason} hold=${r.hold_seconds}s`);
}
const s = db.prepare(`SELECT SUM(realized_pnl) p, SUM(fee_paid) f FROM history
  WHERE coin='KAITO' AND closed_at>=1785398400000`).get();
console.log(`ИТОГ KAITO 30.07 (history): net ${s.p.toFixed(4)}, комиссий ${s.f.toFixed(4)}`);
