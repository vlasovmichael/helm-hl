#!/usr/bin/env node
// ─────────────────────────────────────────────────
//  OI collector — снапшот OI/funding/цены/объёма по всем монетам HL
// ─────────────────────────────────────────────────
// Зачем: у Hyperliquid НЕТ исторического endpoint'а для open interest — только
// текущий снимок. Цена и funding добираются задним числом (candleSnapshot /
// fundingHistory), а OI — нет: не записал сейчас → потеряно навсегда. Этот скрипт
// раз в N минут (cron) снимает metaAndAssetCtxs и дописывает ОДНУ строку JSONL в
// месячный файл. Полностью изолирован от торгового бота: свой процесс (docker
// exec), свой файл, только читает публичный /info. Упасть/зависнуть тихо — cron
// вызовет заново через интервал.
//
// Формат строки: {"t":<ms>, "n":<кол-во монет>, "d":{ "BTC":{oi,f,px,v}, ... }}
//   oi = openInterest в монетах (USD = oi*px), f = funding, px = markPx, v = dayNtlVlm ($)

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT_DIR = process.env.OI_OUT_DIR || '/app/data/oi-collector';
const INFO_URL = 'https://api.hyperliquid.xyz/info';
const TIMEOUT_MS = 15_000;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let meta;
  try {
    const resp = await fetch(INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    meta = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  const universe = meta?.[0]?.universe;
  const ctxs = meta?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs) || universe.length !== ctxs.length) {
    throw new Error(`unexpected shape: universe=${universe?.length} ctxs=${ctxs?.length}`);
  }

  const d = {};
  let n = 0;
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i]?.name;
    const c = ctxs[i];
    if (!name || !c) continue;
    const oi = num(c.openInterest);
    const px = num(c.markPx) ?? num(c.oraclePx) ?? num(c.midPx);
    if (oi == null || px == null) continue; // без OI/цены строка бесполезна
    d[name] = { oi, f: num(c.funding), px, v: num(c.dayNtlVlm) };
    n++;
  }

  const now = Date.now();
  const month = new Date(now).toISOString().slice(0, 7); // YYYY-MM
  const file = `${OUT_DIR}/oi-${month}.jsonl`;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ t: now, n, d }) + '\n');
  process.stdout.write(`[oi-collect] ${new Date(now).toISOString()} — ${n} монет → ${file}\n`);
}

main().catch((err) => {
  process.stderr.write(`[oi-collect] FAIL: ${err.message}\n`);
  process.exit(1);
});
