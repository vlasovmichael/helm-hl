// ─────────────────────────────────────────────────────────────────────────────
//  fundingSpreadCollector — ФОРВАРД фандинг-спреда HL против Kraken Futures.
//
//  Предзаявка hl-kraken-funding-forward-2026-09 от 11.09.2026: правило, вселенная
//  и пороги заморожены ДО первого наблюдения, смотреть результат нельзя до 100
//  закрытых пар или 11.06.2027. Здесь только сбор, ордеров ноль.
//
//  Записываем ровно то, что потом НЕ восстановить: котировки и спреды обеих
//  площадок. Ставки фандинга и цены обе биржи отдают историей — их берём при
//  оценке, а не отсюда. Ретроспективу похоронила подмена спреда константой.
//
//  Запуск: node tools/fundingSpreadCollector.mjs (свой контейнер, как liq-wick)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

// 🚨 Вселенная заморожена предзаявкой: оборот перпа Kraken >= $1M/сут.
// Добавлять монеты по ходу форварда запрещено — это подкрутка отбора.
const UNIVERSE = Object.freeze([
  'AAVE', 'ADA', 'ARB', 'AVAX', 'BNB', 'BTC', 'CRV', 'DOGE', 'DOT', 'ENA',
  'ETH', 'FARTCOIN', 'HYPE', 'INJ', 'LINK', 'LTC', 'NEAR', 'ONDO', 'PUMP',
  'SOL', 'SUI', 'TAO', 'TRUMP', 'UNI', 'WLD', 'XLM', 'XMR', 'XRP', 'ZEC',
]);

const HL_API = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info';
const KR_API = 'https://futures.kraken.com/derivatives/api/v3/tickers';
const DIR = path.join('data', 'funding-spread');
const FILE = path.join(DIR, 'snapshots.jsonl');
const POLL_MS = 60_000;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hl() {
  const r = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  if (!r.ok) throw new Error(`HL http ${r.status}`);
  const [meta, ctxs] = await r.json();
  const out = {};
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c || !UNIVERSE.includes(u.name)) return;
    const mid = Number(c.midPx ?? c.markPx);
    // impactPxs — цены исполнения заметного объёма: ближе к реальным издержкам,
    // чем вершина стакана.
    const imp = Array.isArray(c.impactPxs) ? c.impactPxs.map(Number) : null;
    out[u.name] = { f: Number(c.funding), mid, bid: imp?.[0] ?? null, ask: imp?.[1] ?? null };
  });
  return out;
}

async function kraken() {
  const r = await fetch(KR_API);
  if (!r.ok) throw new Error(`Kraken http ${r.status}`);
  const { tickers } = await r.json();
  const out = {};
  for (const t of tickers) {
    if (!/^PF_/.test(t.symbol) || t.suspended) continue;
    let coin = t.symbol.replace(/^PF_/, '').replace(/USD$/, '');
    if (coin === 'XBT') coin = 'BTC';
    if (!UNIVERSE.includes(coin)) continue;
    const mark = Number(t.markPrice);
    // Kraken публикует ставку в долларах на контракт; относительная = /цену.
    out[coin] = {
      f: mark > 0 ? Number(t.fundingRate) / mark : null,
      mid: mark,
      bid: Number(t.bid),
      ask: Number(t.ask),
    };
  }
  return out;
}

async function snapshot() {
  const [a, b] = await Promise.allSettled([hl(), kraken()]);
  if (a.status !== 'fulfilled' || b.status !== 'fulfilled') {
    log(`снимок пропущен: ${a.reason?.message || ''} ${b.reason?.message || ''}`.trim());
    return;
  }
  const rec = { t: Date.now(), hl: a.value, kr: b.value };
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(FILE, `${JSON.stringify(rec)}\n`);
  log(`снимок: HL ${Object.keys(rec.hl).length} монет, Kraken ${Object.keys(rec.kr).length}`);
}

// Снимок в начале каждого часа: фандинг на обеих площадках почасовой.
let lastHour = -1;
for (;;) {
  const h = Math.floor(Date.now() / 3_600_000);
  if (h !== lastHour) {
    lastHour = h;
    try { await snapshot(); } catch (err) { log(`ошибка: ${err.message}`); }
  }
  await sleep(POLL_MS);
}
