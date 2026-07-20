// Тесты Setup Scanner score 0–4 (радар-конвергенция): пороги + warm + ранжирование.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { scoreSetupRow, scoreAndRank } = await import('../src/modules/setupScannerScore.js');

// Полностью «готовая» строка (все окна набрали историю), 0 попаданий.
function baseRow(over = {}) {
  return {
    coin: 'X',
    fundingApy: 10,
    premium: 0,
    fundingPersist: { ageHours: 48, fractionExtreme: 0, samples: 48, avgApy: 10 },
    oi7d: { ageHours: 168, deltaOi: 0, deltaPx: 0 },
    volRegime: { ageHours: 720, ratio: 1 },
    vol24hUsd: 1e6,
    ...over,
  };
}

test('нейтральная строка → score 0, dir по знаку funding', () => {
  const s = scoreSetupRow(baseRow());
  assert.equal(s.score, 0);
  assert.equal(s.dir, 'SHORT'); // funding +10 → толпа в лонге → фейд SHORT
});

test('funding: |avg 48h| ≥50% бьёт; направление фейда', () => {
  const long = scoreSetupRow(baseRow({ fundingPersist: { ageHours: 48, avgApy: -201 } }));
  assert.equal(long.hits.funding, true);
  assert.equal(long.dir, 'LONG'); // funding − → толпа в шорте → LONG
  const short = scoreSetupRow(baseRow({ fundingPersist: { ageHours: 48, avgApy: 160 } }));
  assert.equal(short.hits.funding, true);
  assert.equal(short.dir, 'SHORT');
  const below = scoreSetupRow(baseRow({ fundingPersist: { ageHours: 48, avgApy: 49 } }));
  assert.equal(below.hits.funding, false);
});

test('OI ramp: рост ≥+50% при |Δцены|≤7%; ход цены гасит', () => {
  const hit = scoreSetupRow(baseRow({ oi7d: { ageHours: 168, deltaOi: 0.6, deltaPx: 0.03 } }));
  assert.equal(hit.hits.oiRamp, true);
  const priced = scoreSetupRow(baseRow({ oi7d: { ageHours: 168, deltaOi: 0.6, deltaPx: 0.20 } }));
  assert.equal(priced.hits.oiRamp, false); // цена уехала → не сжатие
  const weak = scoreSetupRow(baseRow({ oi7d: { ageHours: 168, deltaOi: 0.3, deltaPx: 0.0 } }));
  assert.equal(weak.hits.oiRamp, false);
});

test('basis: |premium|≥0.10% бьёт (готов всегда)', () => {
  assert.equal(scoreSetupRow(baseRow({ premium: -0.059 })).hits.basis, true);
  assert.equal(scoreSetupRow(baseRow({ premium: 0.0005 })).hits.basis, false);
});

test('vol: 24ч/норма ≥1.5× бьёт', () => {
  assert.equal(scoreSetupRow(baseRow({ volRegime: { ageHours: 720, ratio: 1.6 } })).hits.vol, true);
  assert.equal(scoreSetupRow(baseRow({ volRegime: { ageHours: 720, ratio: 1.49 } })).hits.vol, false);
});

test('warm: окно ещё копит (etaHours) → не hit, не miss, в score не идёт', () => {
  const s = scoreSetupRow(baseRow({
    fundingPersist: { ageHours: 10, etaHours: 38 },
    oi7d: { ageHours: 10, etaHours: 158 },
    volRegime: { ageHours: 10, etaHours: 710 },
    premium: -0.5,
  }));
  assert.equal(s.warm.funding, true);
  assert.equal(s.warm.oiRamp, true);
  assert.equal(s.warm.vol, true);
  assert.equal(s.hits.funding, false);
  assert.equal(s.score, 1); // только basis (готов всегда)
});

test('score = сумма 4 признаков; 3/4 как ACE', () => {
  const s = scoreSetupRow(baseRow({
    fundingPersist: { ageHours: 48, avgApy: -211 },
    premium: -0.059,
    volRegime: { ageHours: 720, ratio: 12 },
    oi7d: { ageHours: 168, deltaOi: 3.4, deltaPx: 0.93 }, // px уехал → miss
  }));
  assert.equal(s.score, 3);
  assert.equal(s.hits.oiRamp, false);
  assert.equal(s.dir, 'LONG');
});

test('scoreAndRank: сортировка score ↓, при равенстве объём ↓', () => {
  const ranked = scoreAndRank([
    baseRow({ coin: 'LOWVLM', premium: -0.5, vol24hUsd: 1e6 }), // score 1
    baseRow({ coin: 'HIVLM', premium: -0.5, vol24hUsd: 9e6 }),  // score 1
    baseRow({ coin: 'TOP', premium: -0.5, volRegime: { ageHours: 720, ratio: 12 }, fundingPersist: { ageHours: 48, avgApy: -211 } }), // score 3
  ]);
  assert.equal(ranked[0].coin, 'TOP');
  assert.equal(ranked[1].coin, 'HIVLM');
  assert.equal(ranked[2].coin, 'LOWVLM');
});
