// ─────────────────────────────────────────────────────────────────────────────
//  Vol-per-Candle — сколько ДОЛЛАРОВ прошло через свечу и во сколько раз это
//  больше нормы самой монеты.
//
//  ЗАЧЕМ: в UI Hyperliquid гистограмма объёма нарисована в БАЗОВЫХ токенах, а
//  не в долларах. У kSHIB «4.1B» и у BTC «120» — числа несравнимые ни между
//  монетами, ни с собственным прошлым (базовая единица k-монет = 1000 штук).
//  Плюс абсолютный доллар сам по себе ничего не говорит: $1.5M за час — это
//  много или мало? Ответ виден только относительно нормы ЭТОЙ монеты.
//
//  ЧТО СЧИТАЕМ. candleSnapshot отдаёт `v` (объём в базовых токенах) и `n`
//  (число сделок). Отсюда:
//    • notional = v · (h+l+c)/3   — грубый VWAP свечи; сверено с metaAndAssetCtxs,
//      где dayNtlVlm / dayBaseVlm даёт ровно текущую цену.
//    • ×норма = notional / медиана предыдущих BASE свечей. Медиана СКОЛЬЗЯЩАЯ и
//      только по прошлому — без заглядывания вперёд, иначе всплеск сам поднимет
//      свой же знаменатель и спрячется.
//    • $/сделка = notional / n — средний чек. Растущий чек при растущем объёме
//      это другое событие, чем толпа мелких принтов на том же обороте.
//
//  ⚠️ ПОСЛЕДНЯЯ СВЕЧА НЕЗАКРЫТА — она всегда «маленькая» просто потому, что ещё
//  идёт. Помечена «*», в медиану не входит и её ×норма не печатается: сравнивать
//  10 минут с полным часом бессмысленно. Это грабли, на которые легко наступить
//  глазами по таблице.
//
//  ⚠️ Это ОПИСАНИЕ, а не сигнал. «×40 от нормы» говорит, что событие есть, и не
//  говорит ни слова о направлении. Эджа тут не измерено — см. docs/TRADING_RULES.md.
//
//  Запуск: node tools/volPerCandle.mjs --coin kSHIB
//          node tools/volPerCandle.mjs --coin BTC --tf 5m,1h --rows 16
//          node tools/volPerCandle.mjs --coin HYPE --tf 1d --rows 20 --base 30
// ─────────────────────────────────────────────────────────────────────────────

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const API = 'https://api.hyperliquid.xyz/info';

const COIN = arg('coin', 'BTC');
const TFS  = arg('tf', '5m,1h,1d').split(',').map((s) => s.trim()).filter(Boolean);
const ROWS = parseInt(arg('rows', '14'), 10);   // сколько свечей печатать
const BASE = parseInt(arg('base', '96'), 10);   // окно медианы (свечей)

const TF_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

async function post(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * HL candleSnapshot требует ТОЧНОЕ имя из universe — у k-монет со строчной k
 * (kSHIB, а не KSHIB), иначе 500. Резолвим сами, без импорта src/core/universe.js:
 * скрипт автономный, ему не нужны конфиг и БД бота.
 */
async function resolveCoin(input) {
  const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' });
  const idx = meta.universe.findIndex((a) => a.name.toUpperCase() === input.toUpperCase());
  if (idx < 0) throw new Error(`монета "${input}" не найдена в universe HL`);
  return { name: meta.universe[idx].name, ctx: ctxs[idx] };
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const fmtUsd = (v) => {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
};

const fmtTime = (ts, tf) => {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  const date = `${p(d.getDate())}.${p(d.getMonth() + 1)}`;
  return tf === '1d' ? `${date}   ` : `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Полоска для ×нормы: 1× ≈ пусто, дальше логарифмически, чтобы ×90 не рвало экран. */
const bar = (ratio) => {
  if (!(ratio > 0)) return '';
  const n = Math.max(0, Math.min(20, Math.round(Math.log2(ratio) * 3)));
  return '█'.repeat(n);
};

async function report(coin, tf) {
  const step = TF_MS[tf];
  if (!step) { console.log(`\n⚠️  неизвестный таймфрейм "${tf}" (есть: ${Object.keys(TF_MS).join(', ')})`); return; }

  const need = ROWS + BASE + 2;
  const now = Date.now();
  const candles = await post({
    type: 'candleSnapshot',
    req: { coin, interval: tf, startTime: now - need * step, endTime: now },
  });
  if (candles.length < 3) { console.log(`\n⚠️  ${tf}: свечей почти нет (${candles.length})`); return; }

  const rows = candles.map((c) => {
    const vwap = (Number(c.h) + Number(c.l) + Number(c.c)) / 3;
    const trades = Number(c.n) || 0;
    const ntl = Number(c.v) * vwap;
    return {
      t: c.t,
      close: Number(c.c),
      chg: (Number(c.c) / Number(c.o) - 1) * 100,
      ntl,
      trades,
      perTrade: trades ? ntl / trades : 0,
      open: c.T > now,                      // свеча ещё идёт
    };
  });

  // Скользящая медиана только по ПРОШЛЫМ закрытым свечам — без заглядывания вперёд.
  for (let i = 0; i < rows.length; i++) {
    const prev = rows.slice(Math.max(0, i - BASE), i).filter((r) => !r.open).map((r) => r.ntl);
    rows[i].med = prev.length >= 10 ? median(prev) : 0;
    rows[i].ratio = rows[i].med > 0 && !rows[i].open ? rows[i].ntl / rows[i].med : 0;
  }

  const shown = rows.slice(-ROWS);
  const lastClosed = [...rows].reverse().find((r) => !r.open);

  console.log(`\n═══ ${coin} · ${tf} · медиана по ${BASE} свечам ═══`);
  console.log('время         close        Δ%   $ объём    ×норма  сделок  $/сделка');
  for (const r of shown) {
    const px = r.close < 0.01 ? r.close.toFixed(6) : r.close.toPrecision(6);
    const ratio = (r.open ? '—' : `${r.ratio.toFixed(1)}×`).padStart(6);
    const mark = r.open ? '*' : ' ';
    console.log(
      `${fmtTime(r.t, tf)}${mark} ${px.padStart(10)} ${r.chg.toFixed(2).padStart(7)}  ` +
      `${fmtUsd(r.ntl).padStart(8)}  ${ratio}  ${String(r.trades).padStart(6)}  ` +
      `${fmtUsd(r.perTrade).padStart(7)}  ${bar(r.open ? 0 : r.ratio)}`,
    );
  }
  if (rows.some((r) => r.open)) console.log('* — свеча ещё идёт, ×норма не считается');

  if (lastClosed?.med) {
    const verdict = lastClosed.ratio >= 5 ? 'событие' : lastClosed.ratio >= 2 ? 'оживление' : 'фон';
    console.log(
      `итог ${tf}: последняя закрытая ${fmtUsd(lastClosed.ntl)} при норме ` +
      `${fmtUsd(lastClosed.med)} → ${lastClosed.ratio.toFixed(1)}× (${verdict})`,
    );
  }
}

let name, ctx;
try {
  ({ name, ctx } = await resolveCoin(COIN));
} catch (e) {
  console.error(`\n⚠️  ${e.message}\n   Запуск: node tools/volPerCandle.mjs --coin kSHIB [--tf 5m,1h,1d] [--rows 14] [--base 96]\n`);
  process.exit(1);
}
const oiUsd = Number(ctx.openInterest) * Number(ctx.markPx);
const dayChg = (Number(ctx.markPx) / Number(ctx.prevDayPx) - 1) * 100;

console.log(`\n${name}  ${Number(ctx.markPx)}  (${dayChg >= 0 ? '+' : ''}${dayChg.toFixed(2)}% за сутки)`);
console.log(
  `оборот 24ч ${fmtUsd(Number(ctx.dayNtlVlm))} · OI ${fmtUsd(oiUsd)} · ` +
  `оборот/OI ${(Number(ctx.dayNtlVlm) / oiUsd).toFixed(1)}× · ` +
  `funding ${(Number(ctx.funding) * 100).toFixed(4)}%/час`,
);

for (const tf of TFS) await report(name, tf);
console.log('');
