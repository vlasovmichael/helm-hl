import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const { config } = await import('../src/core/config.js');
const { isNannyOn, managedStrategies } = await import('../src/modules/paperNannyGate.js');
const original = { ...config.trading };

beforeEach(() => Object.assign(config.trading, original));
after(() => Object.assign(config.trading, original));

test('paper nanny gate: tg и ручной paper используют независимые флаги', () => {
  config.trading.tgSignalEnabled = true;
  config.trading.manualPaperAdoptEnabled = false;
  assert.equal(isNannyOn('tg_signal'), true);
  assert.equal(isNannyOn('manual_paper'), false);
  assert.equal(isNannyOn('unknown'), false);
  assert.deepEqual(managedStrategies(), ['tg_signal']);
});

test('paper nanny gate: оба выключены и оба включены', () => {
  config.trading.tgSignalEnabled = false;
  config.trading.manualPaperAdoptEnabled = false;
  assert.deepEqual(managedStrategies(), []);
  config.trading.tgSignalEnabled = true;
  config.trading.manualPaperAdoptEnabled = true;
  assert.equal(isNannyOn('manual_paper'), true);
  assert.deepEqual(managedStrategies(), ['manual_paper', 'tg_signal']);
});
