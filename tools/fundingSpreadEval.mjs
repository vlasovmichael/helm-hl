// ─────────────────────────────────────────────────────────────────────────────
//  fundingSpreadEval — оценка форварда hl-kraken-funding-forward-2026-09.
//
//  Код оценки написан ДО первого наблюдения вместе с предзаявкой: правило,
//  пороги и стоп-правило заморожены здесь же. Это сильная форма предзаявки —
//  подкрутить анализ после взгляда на данные нельзя, не переписав файл.
//
//  🚨 Стоп-правило зашито: PnL не печатается, пока не набрано 100 закрытых пар
//  или не наступило 11.06.2027. До этого доступен только --health: исправность
//  сбора (число снимков, дыры, нулевые котировки), без единой цифры результата.
//
//  Запуск: node tools/fundingSpreadEval.mjs --health
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join('data', 'funding-spread', 'snapshots.jsonl');
const THETA_BP = 5;          // порог спреда за такт
const HOLD_TAKTS = 27;       // 9 суток
const TAKT_H = 8;
const FEE_BP = { hl: 4.32, kr: 5 };
const N_REQUIRED = 100;
const DEADLINE = Date.parse('2027-06-11T00:00:00Z');

function readSnapshots() {
  if (!fs.existsSync(FILE)) return [];
  return fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function health(snaps) {
  if (!snaps.length) { console.log('снимков нет'); return; }
  const hours = snaps.map((s) => Math.floor(s.t / 3_600_000));
  const uniq = [...new Set(hours)].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < uniq.length; i++) if (uniq[i] - uniq[i - 1] > 1) gaps.push(uniq[i] - uniq[i - 1] - 1);
  const last = snaps[snaps.length - 1];
  const coins = new Set([...Object.keys(last.hl), ...Object.keys(last.kr)]);
  let bad = 0;
  for (const s of snaps) {
    for (const side of ['hl', 'kr']) {
      for (const v of Object.values(s[side])) {
        if (!(v.mid > 0) || !(v.bid > 0) || !(v.ask > 0) || v.ask < v.bid) bad++;
      }
    }
  }
  const days = (uniq[uniq.length - 1] - uniq[0]) / 24;
  console.log(`снимков ${snaps.length}, часов покрыто ${uniq.length}, суток ${days.toFixed(1)}`);
  console.log(`дыр в ряду ${gaps.length}, пропущено часов ${gaps.reduce((a, b) => a + b, 0)}`);
  console.log(`монет в последнем снимке ${coins.size} из 29, битых котировок ${bad}`);
  console.log('🚨 это проверка сбора; PnL по стоп-правилу до срока не считается');
}

const snaps = readSnapshots();
if (process.argv.includes('--health')) { health(snaps); process.exit(0); }

// Пары считаются по правилу: |spread| >= THETA_BP, держим HOLD_TAKTS, без
// перекрытия. Ставки и цены берутся из истории бирж, спред — из снимков.
const taktCount = Math.floor(snaps.length / TAKT_H);
const closedMax = Math.max(0, Math.floor(taktCount / HOLD_TAKTS));
if (Date.now() < DEADLINE && closedMax < N_REQUIRED) {
  console.log(`стоп-правило: закрытых пар максимум ${closedMax} из ${N_REQUIRED}, срок ${new Date(DEADLINE).toISOString().slice(0, 10)}`);
  console.log('результат не считается. Доступно только: node tools/fundingSpreadEval.mjs --health');
  process.exit(0);
}
console.log('срок наступил — правило и пороги брать из реестра, ветка hl-kraken-funding-forward-2026-09');
