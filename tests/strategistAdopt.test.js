import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../src/core/logger.js';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
// Дефолты adopt: BE_ARM=1.5, FLOOR=0, TRAIL_ARM=2, GIVE_BACK=30.
// Трейл выключен по умолчанию — здесь включаем явно, чтобы
// проверять именно его механику. Поведение «выключен» — adoptTrailDisabled.test.js.
process.env.ADOPT_TRAIL_ENABLED = 'true';

const {
  analyzeAdopt, resetAdoptState, getAdoptPeakPct,
  getAdoptMaePct, consumeAdoptMfeMae, notePeakPct, clearAdoptState,
} = await import('../src/modules/strategistAdopt.js');
const { _setFileForTest, _resetForTest } = await import('../src/modules/adoptTrailStore.js');

let storeDir;
afterEach(() => {
  resetAdoptState();
  _resetForTest();
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  storeDir = undefined;
});

function short(id = 1) {
  return { id, coin: 'NIL', side: 'short', entry_price: 100 };
}
function long(id = 1) {
  return { id, coin: 'NIL', side: 'long', entry_price: 100 };
}

// ── SHORT ────────────────────────────────────────────────────────────────────

test('adopt SHORT: flat → HOLD', () => {
  resetAdoptState();
  assert.equal(analyzeAdopt(short(), 100).action, 'HOLD');
});

test('adopt SHORT: trail — пик +2% затем откат до +0.5% (give back 1.5 ≥ 0.6) → CLOSE', () => {
  resetAdoptState();
  const p = short();
  assert.equal(analyzeAdopt(p, 98).action, 'HOLD');     // +2% пик, ещё держим
  const r = analyzeAdopt(p, 99.5);                       // +0.5%, отдал 1.5 от пика 2
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_trail_tp');
  assert.ok(r.peakPct >= 2);
});

test('adopt SHORT: BE-храповик — пик +1.6% (<trail), возврат к входу → CLOSE в безубыток', () => {
  resetAdoptState();
  const p = short();
  assert.equal(analyzeAdopt(p, 98.4).action, 'HOLD');   // +1.6% — взвели храповик, не trail
  const r = analyzeAdopt(p, 100);                        // unrealized 0 ≤ floor
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_breakeven_ratchet');
});

test('adopt SHORT: жёсткий стоп НЕ дублируем — цена против входа без арма → HOLD (биржа держит SL)', () => {
  resetAdoptState();
  const p = short();
  // Сразу в минус (для шорта цена выше входа), пик никогда не дошёл до ARM.
  assert.equal(analyzeAdopt(p, 101.5).action, 'HOLD');
});

// ── LONG ─────────────────────────────────────────────────────────────────────

test('adopt LONG: trail — пик +2% затем откат до +0.5% → CLOSE', () => {
  resetAdoptState();
  const p = long();
  assert.equal(analyzeAdopt(p, 102).action, 'HOLD');    // +2% пик
  const r = analyzeAdopt(p, 100.5);                      // +0.5%
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_trail_tp');
});

test('adopt LONG: BE-храповик — пик +1.6%, возврат к входу → CLOSE в безубыток', () => {
  resetAdoptState();
  const p = long();
  assert.equal(analyzeAdopt(p, 101.6).action, 'HOLD');
  const r = analyzeAdopt(p, 100);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_breakeven_ratchet');
});

test('adopt: взведённый BE не сбрасывается на откате, пока позиция не закрыта', () => {
  resetAdoptState();
  const p = long(42);
  assert.equal(analyzeAdopt(p, 101.6).action, 'HOLD'); // arm
  assert.equal(analyzeAdopt(p, 100.5).action, 'HOLD'); // откат ещё выше пола
  const result = analyzeAdopt(p, 100);
  assert.equal(result.action, 'CLOSE');
  assert.equal(result.reason, 'adopt_breakeven_ratchet');
  assert.ok(Math.abs(result.peakPct - 1.6) < 1e-9);
});

test('adopt: пик и BE переживают рестарт через adoptTrailStore', () => {
  storeDir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
  _setFileForTest(join(storeDir, 'trail.json'));
  const p = { ...short(77), mode: 'PRODUCTION' };

  assert.equal(analyzeAdopt(p, 98.4).action, 'HOLD'); // +1.6%, arm + persist
  assert.ok(Math.abs(getAdoptPeakPct(p.id) - 1.6) < 1e-9);

  // Имитируем новый процесс: оперативные карты пусты, файл остаётся.
  resetAdoptState();
  assert.ok(Math.abs(getAdoptPeakPct(p.id) - 1.6) < 1e-9);
  const result = analyzeAdopt(p, 100);
  assert.equal(result.action, 'CLOSE');
  assert.equal(result.reason, 'adopt_breakeven_ratchet');
});

test('adopt: внешний пик монотонен, не принимает мусор и персистит только по явному флагу', () => {
  storeDir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
  _setFileForTest(join(storeDir, 'trail.json'));
  assert.equal(notePeakPct(null, 2), false);
  assert.equal(notePeakPct(5, NaN), false);
  assert.equal(notePeakPct(5, 0), false);
  assert.equal(notePeakPct(5, 2), true);
  assert.equal(notePeakPct(5, 2), false);
  assert.equal(notePeakPct(5, 1), false);
  assert.equal(notePeakPct(5, 3, { persist: true }), true);
  assert.equal(getAdoptPeakPct(5), 3);
  assert.equal(notePeakPct(5, 4, { persist: true }), true);
  assert.equal(getAdoptPeakPct(5), 4);
});

test('adopt: MFE/MAE отражают пик и просадку, пустая позиция возвращает null', () => {
  resetAdoptState();
  const p = long(66);
  assert.deepEqual(consumeAdoptMfeMae(null), { mfePct: null, maePct: null });
  assert.deepEqual(consumeAdoptMfeMae(p.id), { mfePct: null, maePct: null });
  analyzeAdopt(p, 102);
  analyzeAdopt(p, 99);
  const values = consumeAdoptMfeMae(p.id);
  assert.ok(Math.abs(values.mfePct - 2) < 1e-9);
  assert.ok(Math.abs(values.maePct + 1) < 1e-9);
  assert.ok(Math.abs(getAdoptMaePct(p.id) + 1) < 1e-9);
});

test('adopt: clearAdoptState стирает оперативное и персистированное состояние', () => {
  storeDir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
  _setFileForTest(join(storeDir, 'trail.json'));
  const p = { ...long(88), mode: 'PRODUCTION' };
  analyzeAdopt(p, 102);
  clearAdoptState(p.id);
  resetAdoptState();
  assert.equal(getAdoptPeakPct(p.id), 0);
  assert.deepEqual(consumeAdoptMfeMae(p.id), { mfePct: null, maePct: null });
});

test('adopt: из сохранённого состояния восстанавливаются только корректные peak, MAE и BE', () => {
  storeDir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
  const file = join(storeDir, 'trail.json');
  writeFileSync(file, JSON.stringify({ version: 1, trail: {
    1: { peak: 3, trough: -2, beArmed: true, updatedAt: Date.now() },
  } }));
  _setFileForTest(file);
  assert.equal(getAdoptPeakPct(1), 3);
  assert.equal(getAdoptMaePct(1), -2);
  const result = analyzeAdopt(short(1), 100);
  assert.equal(result.reason, 'adopt_breakeven_ratchet');
});

test('adopt LONG: жёсткий стоп НЕ дублируем — цена против входа без арма → HOLD', () => {
  resetAdoptState();
  const p = long();
  assert.equal(analyzeAdopt(p, 98.5).action, 'HOLD');
});

// ── Защита от мусора ──────────────────────────────────────────────────────────

test('adopt: невалидная цена → HOLD', () => {
  resetAdoptState();
  assert.equal(analyzeAdopt(short(), 0).action, 'HOLD');
  assert.equal(analyzeAdopt(short(), NaN).action, 'HOLD');
  assert.equal(getAdoptPeakPct(1), 0, 'невалидный тик не становится MFE');
});

test('adopt: границы BE — взвод ровно на ARM и закрытие ровно на FLOOR', () => {
  const p = long(91);
  assert.equal(analyzeAdopt(p, 101.5).action, 'HOLD');
  const result = analyzeAdopt(p, 100);
  assert.deepEqual(result, {
    action: 'CLOSE', coin: 'NIL', price: 100,
    reason: 'adopt_breakeven_ratchet', peakPct: 1.5,
  });
});

test('adopt: trail закрывает после разрешённой отдачи и сообщает её долю', () => {
  const p = long(92);
  assert.equal(analyzeAdopt(p, 110).action, 'HOLD');
  // 30% от пика 10% = 3%; отдаём 4 пп, чтобы не зависеть от IEEE-округления на границе.
  const result = analyzeAdopt(p, 106);
  assert.equal(result.action, 'CLOSE');
  assert.equal(result.reason, 'adopt_trail_tp');
  assert.equal(result.peakPct, 10);
  assert.ok(Math.abs(result.giveBackPct - 40) < 1e-9);
});

test('adopt: production персистит peak, MAE и взвод, paper-позиция файл не создаёт', () => {
  storeDir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
  const file = join(storeDir, 'trail.json');
  _setFileForTest(file);
  const production = { ...long(93), mode: 'PRODUCTION' };
  analyzeAdopt(production, 102);
  analyzeAdopt(production, 99);
  const saved = JSON.parse(readFileSync(file, 'utf8')).trail['93'];
  assert.deepEqual(
    { peak: saved.peak, trough: saved.trough, beArmed: saved.beArmed },
    { peak: 2, trough: -1, beArmed: true },
  );

  _resetForTest();
  resetAdoptState();
  const paperFile = join(storeDir, 'paper.json');
  _setFileForTest(paperFile);
  analyzeAdopt(long(94), 102);
  analyzeAdopt(long(94), 99);
  assert.equal(getAdoptPeakPct(94), 2);
  assert.equal(getAdoptMaePct(94), -1);
  assert.equal(existsSync(paperFile), false);
});

test('adopt: clear снимает взвод, MFE/MAE и записанное состояние', () => {
  storeDir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
  const file = join(storeDir, 'trail.json');
  _setFileForTest(file);
  const p = { ...long(95), mode: 'PRODUCTION' };
  analyzeAdopt(p, 102);
  analyzeAdopt(p, 99);
  clearAdoptState(p.id);
  assert.deepEqual(consumeAdoptMfeMae(p.id), { mfePct: null, maePct: null });
  assert.equal(analyzeAdopt(p, 100).action, 'HOLD', 'старый BE-взвод не живёт после close');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).trail['95'], undefined);
});

test('adopt: некорректные сохранённые значения не восстанавливают защиту', () => {
  storeDir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
  const file = join(storeDir, 'trail.json');
  writeFileSync(file, JSON.stringify({ version: 1, trail: {
    zeroPeak: { peak: 0, trough: 0, beArmed: false, updatedAt: Date.now() },
    textPeak: { peak: '2', trough: 'bad', beArmed: false, updatedAt: Date.now() },
    badId: { peak: 5, trough: -5, beArmed: true, updatedAt: Date.now() },
  } }));
  _setFileForTest(file);
  assert.equal(getAdoptPeakPct(0), 0);
  assert.equal(getAdoptMaePct(0), 0);
  assert.equal(analyzeAdopt(long(0), 100).action, 'HOLD');
});

test('adopt: внешний peak сохраняется только по явному persist и на точном пороге', () => {
  storeDir = mkdtempSync(join(tmpdir(), 'adopt-trail-'));
  const file = join(storeDir, 'trail.json');
  _setFileForTest(file);
  assert.equal(notePeakPct(96, 1.5), true);
  assert.equal(existsSync(file), false);
  assert.equal(notePeakPct(96, 1.6, { persist: true }), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).trail['96'].peak, 1.6);
});

test('adopt: trail и BE публикуют причину закрытия с предыдущим осмотром', () => {
  const messages = [];
  const originalInfo = logger.info;
  const originalWarn = logger.warn;
  logger.info = (message) => messages.push(message);
  logger.warn = (message) => messages.push(message);
  try {
    const trail = long(97);
    analyzeAdopt(trail, 110);
    analyzeAdopt(trail, 106);
    const be = long(98);
    analyzeAdopt(be, 101.5);
    analyzeAdopt(be, 100);
  } finally {
    logger.info = originalInfo;
    logger.warn = originalWarn;
  }
  assert.match(messages[0], /TRAIL CLOSE #NIL: peak \+10\.00% → now \+6\.00%/);
  assert.match(messages[1], /пред\.осмотр=0\.0%.*пауза=/);
  assert.match(messages[2], /BREAKEVEN RATCHET #NIL: peak \+1\.50% → now \+0\.00% ≤ floor 0/);
});
