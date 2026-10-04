import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
const { parseFillResponse } = await import('../src/modules/executor/fill-parser.js');

const response = (status) => ({ response: { data: { statuses: [status] } } });

test('parseFillResponse distinguishes fill, resting order and exchange error', () => {
  assert.deepEqual(parseFillResponse(response({ filled: { oid: 7, totalSz: '1.25', avgPx: '42.5' } }), 'OPEN'),
    { ok: true, oid: 7, totalSz: 1.25, avgPx: 42.5 });
  assert.deepEqual(parseFillResponse(response({ resting: { oid: 8 } }), 'OPEN'),
    { ok: false, error: 'Order resting (oid=8) instead of filling — IoC order should not rest' });
  assert.deepEqual(parseFillResponse(response({ error: 'margin' }), 'OPEN'), { ok: false, error: 'margin' });
  assert.deepEqual(parseFillResponse(response('rejected'), 'CLOSE'), { ok: false, error: 'rejected' });
  assert.match(parseFillResponse(null, 'OPEN').error, /Empty statuses in OPEN response: null/);
});

test('parseFillResponse rejects every empty or unknown SDK status shape', () => {
  for (const result of [{}, { response: {} }, { response: { data: { statuses: [] } } }]) {
    assert.match(parseFillResponse(result, 'OPEN').error, /Empty statuses in OPEN response/);
  }
  assert.deepEqual(parseFillResponse(response({}), 'CLOSE'), { ok: false, error: 'Unknown status shape: {}' });
  assert.deepEqual(parseFillResponse({ response: { get data() { throw new Error('broken'); } } }, 'OPEN'),
    { ok: false, error: 'Failed to parse OPEN response: broken' });
});
