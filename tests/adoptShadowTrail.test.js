// Теневой трейл adopt — гипотеза adopt-trail-025r (предзаявлена 15.08.2026).
//
// Что проверяем, и почему именно это:
//  - обе модели считаются на ОДНОМ потоке цен (иначе сравнение не парное);
//  - пик обновляется ПОСЛЕ проверки пола — классический off-by-one, при котором
//    трейл не срабатывает никогда, потому что пол пересчитан по текущей цене;
//  - позиция без resting-SL пропускается, а не считается с выдуманным риском;
//  - несработавшая модель «доезжает» до реального выхода;
//  - state не копится (грабля утечки кучи 09.08).

import { test } from 'node:test';
import assert from 'node:assert';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { config } = await import('../src/core/config.js');
config.trading.adoptTrailShadowEnabled = true;
config.trading.adoptShadowTrailR = 0.25;

const {
  trackAdoptShadowTrailTick,
  finalizeAdoptShadowTrail,
  clearAdoptShadowTrail,
  _resetAdoptShadowTrailState,
  _setShadowTrailRecorder,
} = await import('../src/modules/adoptShadowTrail.js');

// Перехватываем запись, чтобы не трогать живую trades.db.
const recorded = [];
_setShadowTrailRecorder((row) => recorded.push(row));

function longPos(id, { sl = 0.98 } = {}) {
  return { id, coin: 'TEST', side: 'long', entry_price: 1, sl_price: sl, size_usd: 100 };
}

test('0.25R держит позицию там, где текущий трейл уже вышел', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = longPos(1); // R = 2% (вход 1, стоп 0.98)

  // Пик +2.0% (= 1R, обе модели взведены), затем откат до +1.5%.
  //   текущий: пол = 2.0 × 0.7 = 1.4% → 1.5% ещё держится... идём глубже.
  //   0.25R:   пол = 2.0 − 0.5 = 1.5% → срабатывает ровно на 1.5%.
  for (const px of [1.005, 1.01, 1.02, 1.015]) trackAdoptShadowTrailTick(pos, px);
  finalizeAdoptShadowTrail(pos, 1.015);

  const row = recorded[0];
  assert.equal(row.strategy_id, 'adopt_trail', 'пишем отдельно от time-cut');
  assert.equal(row.ch_fired, 0, 'текущий трейл на откате до 1.5% ещё не режет');
  assert.equal(row.td_fired, 1, '0.25R режет: пол 1.5% задет');
  assert.ok(Math.abs(row.td_pct - 1.5) < 1e-9, `td_pct=${row.td_pct}`);
});

test('текущий трейл вылетает на мелком пике, 0.25R — нет (механизм ACE)', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = longPos(2, { sl: 0.9 }); // R = 10%: 1R далеко, 0.25R = 2.5пп

  // Пик +3%, откат до +2%. Текущий: arm 2% взведён, пол = 3 × 0.7 = 2.1% → режет.
  // 0.25R: взвод требует пика ≥ 1R = 10%, не взведён → не режет вообще.
  for (const px of [1.01, 1.03, 1.02]) trackAdoptShadowTrailTick(pos, px);
  finalizeAdoptShadowTrail(pos, 1.02);

  const row = recorded[0];
  assert.equal(row.ch_fired, 1, 'текущий трейл срезал мелкий пик');
  assert.equal(row.td_fired, 0, '0.25R не взведён — буфер не зависит от размера пика');
  assert.ok(Math.abs(row.td_pct - 2) < 1e-9, 'несработавшая модель доезжает до факта');
});

test('пик обновляется ПОСЛЕ проверки пола (иначе трейл не сработает никогда)', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = longPos(3);

  // Монотонный рост: ни одна модель не должна сработать ни разу.
  for (const px of [1.01, 1.02, 1.03, 1.05, 1.08]) trackAdoptShadowTrailTick(pos, px);
  finalizeAdoptShadowTrail(pos, 1.08);

  const row = recorded[0];
  assert.equal(row.td_fired, 0, 'на растущей цене выхода быть не может');
  assert.equal(row.ch_fired, 0);
  assert.ok(Math.abs(row.actual_pct - 8) < 1e-9);
});

test('позиция без resting-SL пропускается, а не считается с выдуманным R', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = { id: 4, coin: 'NOSL', side: 'long', entry_price: 1, sl_price: null, size_usd: 100 };

  for (const px of [1.02, 1.05, 1.01]) trackAdoptShadowTrailTick(pos, px);
  finalizeAdoptShadowTrail(pos, 1.01);

  assert.equal(recorded.length, 0, 'без R модель не определена — строки быть не должно');
});

test('шорт считается зеркально', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = { id: 5, coin: 'S', side: 'short', entry_price: 1, sl_price: 1.02, size_usd: 100 };

  // Для шорта прибыль = падение цены. Пик +2% (цена 0.98), откат до +1.5% (0.985).
  for (const px of [0.995, 0.99, 0.98, 0.985]) trackAdoptShadowTrailTick(pos, px);
  finalizeAdoptShadowTrail(pos, 0.985);

  const row = recorded[0];
  assert.equal(row.side, 'short');
  assert.equal(row.td_fired, 1, '0.25R сработал и на шорте');
  assert.ok(Math.abs(row.actual_pct - 1.5) < 1e-9, 'unrealized% зеркален');
});

test('state не копится: finalize и clear убирают позицию', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;

  const a = longPos(10);
  trackAdoptShadowTrailTick(a, 1.01);
  finalizeAdoptShadowTrail(a, 1.01);
  // Повторный finalize по той же позиции не должен писать вторую строку.
  finalizeAdoptShadowTrail(a, 1.01);
  assert.equal(recorded.length, 1, 'идемпотентно');

  // Позиция без SL помечена skip — её убирает clear, иначе Map растёт вечно.
  const b = { id: 11, coin: 'X', side: 'long', entry_price: 1, sl_price: null, size_usd: 10 };
  trackAdoptShadowTrailTick(b, 1.01);
  clearAdoptShadowTrail(b.id);
  finalizeAdoptShadowTrail(b, 1.01);
  assert.equal(recorded.length, 1, 'после clear финализировать нечего');
});

test('выключенный флаг не пишет ничего', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  config.trading.adoptTrailShadowEnabled = false;

  const pos = longPos(20);
  for (const px of [1.02, 1.05, 1.01]) trackAdoptShadowTrailTick(pos, px);
  finalizeAdoptShadowTrail(pos, 1.01);

  assert.equal(recorded.length, 0);
  config.trading.adoptTrailShadowEnabled = true;
});

test('проценты и денежные результаты считаются от неединичного входа и notional', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = { id: 30, coin: 'SCALE', side: 'long', entry_price: 100, sl_price: 98, size_usd: 250 };

  // Пик +2%, затем ровно пол 0.25R: обе модели записывают наблюдаемые PnL.
  for (const px of [101, 102, 101.5, 101.39, 100]) trackAdoptShadowTrailTick(pos, px);
  finalizeAdoptShadowTrail(pos, 100);

  const row = recorded[0];
  assert.equal(row.actual_pct, 0);
  assert.equal(row.actual_pnl, 0);
  assert.equal(row.td_pct, 1.5);
  assert.equal(row.td_pnl, 3.75);
  assert.ok(Math.abs(row.ch_pct - 1.39) < 1e-9);
  assert.ok(Math.abs(row.ch_pnl - 3.475) < 1e-9);
  assert.ok(row.td_min >= 0 && row.td_min < 1, 'время срабатывания дано в минутах');
  assert.ok(row.ch_min >= 0 && row.ch_min < 1, 'время срабатывания дано в минутах');
});

test('short без side по умолчанию и невалидный тик не создают ложную строку', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = { id: 31, coin: 'DEFAULT', entry_price: 100, sl_price: 102, size_usd: 100 };

  trackAdoptShadowTrailTick(pos, NaN);
  trackAdoptShadowTrailTick(pos, 98);
  finalizeAdoptShadowTrail(pos, 99);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].side, 'short');
  assert.equal(recorded[0].actual_pct, 1);
});

test('ошибка записи не вылетает из закрытия и очищенное состояние начинается заново', () => {
  _resetAdoptShadowTrailState();
  const pos = longPos(32);
  _setShadowTrailRecorder(() => { throw new Error('disk full'); });
  trackAdoptShadowTrailTick(pos, 1.02);
  assert.doesNotThrow(() => finalizeAdoptShadowTrail(pos, 1.01));

  _setShadowTrailRecorder((row) => recorded.push(row));
  recorded.length = 0;
  trackAdoptShadowTrailTick(pos, 1.01);
  clearAdoptShadowTrail(pos.id);
  trackAdoptShadowTrailTick(pos, 1.02);
  finalizeAdoptShadowTrail(pos, 1.02);
  assert.equal(recorded.length, 1, 'после clear нет следа старого пика');
  assert.equal(recorded[0].td_fired, 0);
});

test('выключенный трекер и невалидная цена не оставляют состояние для следующего finalize', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = longPos(33);

  config.trading.adoptTrailShadowEnabled = false;
  trackAdoptShadowTrailTick(pos, 1.02);
  config.trading.adoptTrailShadowEnabled = true;
  finalizeAdoptShadowTrail(pos, 1.01);
  assert.equal(recorded.length, 0);

  trackAdoptShadowTrailTick(pos, NaN);
  finalizeAdoptShadowTrail(pos, 1.01);
  assert.equal(recorded.length, 0);
});

test('сработавшая модель не переписывает цену выхода, а ровный пол текущего трейла включителен', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = { id: 34, coin: 'EDGE', side: 'long', entry_price: 100, sl_price: 98, size_usd: 100 };
  const oldGiveBack = config.trading.adoptTrailGiveBackPct;
  config.trading.adoptTrailGiveBackPct = 50;
  try {
    for (const px of [102, 101.5, 101, 100]) trackAdoptShadowTrailTick(pos, px);
    finalizeAdoptShadowTrail(pos, 100);
  } finally {
    config.trading.adoptTrailGiveBackPct = oldGiveBack;
  }

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].ch_fired, 1);
  assert.equal(recorded[0].ch_pct, 1, 'граница пола входит в условие');
  assert.equal(recorded[0].td_fired, 1);
  assert.equal(recorded[0].td_pct, 1.5, 'первое срабатывание R не перезаписывается худшим тиком');
});

test('reset действительно забывает пик предыдущей позиции', () => {
  recorded.length = 0;
  const pos = longPos(35);
  trackAdoptShadowTrailTick(pos, 1.02);
  _resetAdoptShadowTrailState();
  trackAdoptShadowTrailTick(pos, 1.01);
  finalizeAdoptShadowTrail(pos, 1.01);
  assert.equal(recorded[0].td_fired, 0);
  assert.equal(recorded[0].ch_fired, 0);
});

test('0.25R не режет откат выше пола и сохраняет ненулевой фактический PnL', () => {
  _resetAdoptShadowTrailState();
  recorded.length = 0;
  const pos = { id: 36, coin: 'BUFFER', side: 'long', entry_price: 100, sl_price: 98, size_usd: 250 };
  trackAdoptShadowTrailTick(pos, 102);   // peak 2%, R-floor 1.5%
  trackAdoptShadowTrailTick(pos, 101.8); // выше R-пола и выше current-пола 1.4%
  finalizeAdoptShadowTrail(pos, 101.8);

  assert.equal(recorded[0].td_fired, 0);
  assert.equal(recorded[0].ch_fired, 0);
  assert.ok(Math.abs(recorded[0].actual_pct - 1.8) < 1e-9);
  assert.ok(Math.abs(recorded[0].actual_pnl - 4.5) < 1e-9);
});
