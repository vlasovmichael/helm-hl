import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
const { parseFillResponse } = await import('../src/modules/executor/fill-parser.js');

const response = (status) => ({ response: { data: { statuses: [status] } } });

test('parseFillResponse distinguishes fill, resting order and exchange error', () => {
  assert.deepEqual(parseFillResponse(response({ filled: { oid: 7, totalSz: '1.25', avgPx: '42.5' } }), 'OPEN'),
    { ok: true, oid: 7, totalSz: 1.25, avgPx: 42.5 });
  assert.match(parseFillResponse(response({ resting: { oid: 8 } }), 'OPEN').error, /resting/);
  assert.deepEqual(parseFillResponse(response({ error: 'margin' }), 'OPEN'), { ok: false, error: 'margin' });
  assert.deepEqual(parseFillResponse(response('rejected'), 'CLOSE'), { ok: false, error: 'rejected' });
  assert.equal(parseFillResponse(null, 'OPEN').ok, false);
});
