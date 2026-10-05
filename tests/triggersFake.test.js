import { test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.TRIGGERS_FAKE_DEPS === '1';
const maybeTest = enabled ? test : test.skip;
const { placeExitTrigger } = await import('../src/modules/executor/triggers.js');
const exchange = await import('./helpers/triggers-exchange-fake.js');
const retry = await import('./helpers/triggers-retry-fake.js');

function reset(response) { exchange.resetTriggerFake(); retry.resetRetryCalls(); exchange.setTriggerResponse(response); }
const result = (status) => ({ response: { data: { statuses: [status] } } });

maybeTest('placeExitTrigger submits rounded opposite-side trigger and returns resting oid', async () => {
  reset(result({ resting: { oid: 42 } }));
  assert.equal(await placeExitTrigger('ETH', 1.2345, 123.4567, 'sl', 3, 'short'), 42);
  assert.deepEqual(exchange.calls, [{ coin: 'ETH', isBuy: true, sz: 1.2345, px: 123.46, tpsl: 'sl' }]);
  assert.deepEqual(retry.calls, [{ label: 'exit-sl-ETH', maxRetries: 2, baseDelayMs: 1000 }]);
  reset(result({ resting: { oid: 43 } }));
  assert.equal(await placeExitTrigger('BTC', 2, 100, 'tp', 2, 'long'), 43);
  assert.equal(exchange.calls[0].isBuy, false);
  reset(result({ resting: { oid: 44 } }));
  await placeExitTrigger('SOL', 1, 20, 'sl', 2);
  assert.equal(exchange.calls[0].isBuy, true);
});

maybeTest('placeExitTrigger rejects every exchange error shape', async () => {
  for (const [response, message] of [
    [null, { message: 'empty statuses: null' }],
    [{ response: null }, { message: 'empty statuses: {"response":null}' }],
    [{ response: { data: null } }, { message: 'empty statuses: {"response":{"data":null}}' }],
    [{ response: { data: { statuses: null } } }, { message: 'empty statuses: {"response":{"data":{"statuses":null}}}' }],
    [result('rejected'), { message: 'rejected' }],
    [result({ error: 'bad trigger' }), { message: 'bad trigger' }],
    [result({}), { message: 'unexpected status: {}' }],
  ]) {
    reset(response);
    await assert.rejects(placeExitTrigger('ETH', 1, 100, 'sl', 2), message);
  }
});
