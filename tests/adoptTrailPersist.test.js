// Пик adopt-трейла переживает рестарт.
//
// Why (09.08.2026): у Hunter пик и взвод BE лежат на диске с 20.06, а у няньки
// жили только в памяти. Рестарт (а их было два за неделю: cgroup OOM 02.08 и
// heap limit 09.08) обнулял peak в 0 — трейл переставал видеть уже достигнутый
// максимум, BE-храповик оказывался невзведённым, и поза, бывшая в плюсе, могла
// уехать в минус до биржевого стопа. Жёсткий SL это переживает, мягкий выход —
// нет. Здесь проверяется, что теперь переживает и он.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.ADOPT_BE_ARM_PCT = '1.5';
process.env.ADOPT_TRAIL_ARM_PCT = '2';
process.env.ADOPT_TRAIL_GIVE_BACK_PCT = '30';

const store = await import('../src/modules/adoptTrailStore.js');
const { analyzeAdopt, resetAdoptState, getAdoptPeakPct, clearAdoptState } =
  await import('../src/modules/strategistAdopt.js');

const dir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
const FILE = join(dir, 'adopt_trail.json');

function freshStore() {
  store._setFileForTest(FILE);
  resetAdoptState();
}

// SHORT со входом 100: цена 97 = +3% в нашу пользу.
const POS = { id: 42, coin: 'SOL', side: 'short', entry_price: 100, mode: 'PRODUCTION' };

test('пик PROD-позы уходит на диск и поднимается обратно', () => {
  freshStore();

  analyzeAdopt(POS, 97);                       // +3% → выше PERSIST_FROM (1.5)
  assert.ok(getAdoptPeakPct(42) >= 2.9);

  const persisted = store.getAdoptTrailAll()['42'];
  assert.ok(persisted, 'пик должен быть записан');
  assert.ok(persisted.peak >= 2.9);
  assert.equal(persisted.beArmed, true);

  // Имитация рестарта: память чистая, файл на месте.
  resetAdoptState();
  store._setFileForTest(FILE);
  assert.ok(getAdoptPeakPct(42) >= 2.9, 'после рестарта пик должен восстановиться');
});

test('до рестарта было бы 0 — тот самый провал', () => {
  freshStore();
  analyzeAdopt(POS, 97);
  // Стираем и память, и диск — эмуляция старого поведения (персиста не было).
  resetAdoptState();
  store._resetForTest();
  store._setFileForTest(join(dir, 'empty.json'));
  assert.equal(getAdoptPeakPct(42), 0);
});

test('трейл после рестарта закрывает по откату от ВОССТАНОВЛЕННОГО пика', () => {
  freshStore();
  analyzeAdopt(POS, 96);                       // пик +4%
  resetAdoptState();
  store._setFileForTest(FILE);

  // Откат до +2.5%: отдали 1.5 из 4 = 37% ≥ 30% → закрытие.
  const sig = analyzeAdopt(POS, 97.5);
  assert.equal(sig.action, 'CLOSE');
  assert.equal(sig.reason, 'adopt_trail_tp');
  assert.ok(sig.peakPct >= 3.9, 'пик должен быть тот, что с диска, а не с нуля');
});

test('бумажный двойник на диск не пишет', () => {
  freshStore();
  analyzeAdopt({ ...POS, id: 77, mode: 'PAPER' }, 97);
  assert.equal(store.getAdoptTrailAll()['77'], undefined);
});

test('закрытие позиции снимает персист — орфан не доживёт до TTL', () => {
  freshStore();
  analyzeAdopt(POS, 97);
  assert.ok(store.getAdoptTrailAll()['42']);
  clearAdoptState(42);
  assert.equal(store.getAdoptTrailAll()['42'], undefined);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
