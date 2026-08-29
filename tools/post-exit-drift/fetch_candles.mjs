import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { readFileSync } from 'fs';
const rts = JSON.parse(readFileSync('rts.json'));
const coins = [...new Set(rts.map(r => r.coin))];
const INTERVAL = process.argv[2] || '15m';
const BAR_MS = { '15m': 900e3, '1h': 3600e3 }[INTERVAL];
const OUT = `candles_${INTERVAL}`;
if (!existsSync(OUT)) mkdirSync(OUT);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function info(body) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1000 * (a + 1)); }
  }
  return null;
}

// окно: от самого раннего входа − сутки до сейчас
const start = Math.min(...rts.map(r => r.entry_time)) - 86400e3;
const end = Date.now();
let done = 0;
for (const coin of coins) {
  const rows = [];
  let cursor = start;
  while (cursor < end) {
    const r = await info({ type: 'candleSnapshot', req: { coin, interval: INTERVAL, startTime: cursor, endTime: end } });
    await sleep(250);
    if (!Array.isArray(r) || !r.length) break;
    for (const c of r) rows.push([c.t, +c.o, +c.h, +c.l, +c.c]);
    const last = r[r.length - 1].t;
    if (last <= cursor) break;
    cursor = last + BAR_MS;
    if (r.length < 4999) break;
  }
  writeFileSync(`${OUT}/${coin}.json`, JSON.stringify(rows));
  done++;
  if (done % 20 === 0) console.error(`${done}/${coins.length}`);
}
console.error('готово', done);
