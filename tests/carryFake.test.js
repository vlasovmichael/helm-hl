import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
globalThis.__carryHlInfo = async (request, options) => {
  calls.push({ request, options });
  if (globalThis.__carryOverride) return globalThis.__carryOverride(request, options);
  if (request.type === 'userFees') return { userCrossRate: '0.0005', userAddRate: 'bad', userSpotCrossRate: null, userSpotAddRate: '0.0002' };
  if (request.type === 'fundingHistory') {
    if (request.coin === 'BTC') return [{ fundingRate: '0.00001' }, { fundingRate: 'bad' }];
    if (request.coin === 'ETH') throw new Error('unavailable');
    return [];
  }
  if (request.type === 'metaAndAssetCtxs') return [{ universe: [{ name: 'BTC' }, { name: 'ETH' }] }, [{ funding: '0.00002', markPx: '100' }, { funding: 'bad', markPx: '0' }]];
  if (request.type === 'spotMetaAndAssetCtxs') return [{ universe: [{ name: '@144' }, { name: '@155' }] }, [{ midPx: '100.5', dayNtlVlm: '12' }, { markPx: '100', dayNtlVlm: '3' }]];
  throw new Error(`unexpected ${request.type}`);
};

const { getCarry } = await import('../src/modules/carry.js');

test('getCarry собирает HL-ответы, нормализует fees и кэширует карточку', async () => {
  const at = 2_000_000_000_000;
  const first = await getCarry(at);
  assert.equal(first.at, at);
  assert.equal(first.avgHours, 168);
  assert.deepEqual(first.fees, { perpTaker: 5, perpMaker: 1.5, spotTaker: 7, spotMaker: 2, source: 'account' });
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].coin, 'BTC');
  assert.equal(first.rows[0].hours, 1);
  assert.equal(first.rows[0].dailyBp, null);
  assert.equal(first.rows[0].spotVolUsd, 12);
  const count = calls.length;
  assert.strictEqual(await getCarry(at + 1), first);
  assert.equal(calls.length, count);
});

test('истёкшие кэши обновляются, а ошибка fees даёт безопасные дефолты', async () => {
  const original = globalThis.__carryHlInfo;
  globalThis.__carryHlInfo = async (request, options) => {
    if (request.type === 'userFees') throw new Error('fees down');
    return original(request, options);
  };
  const at = 2_000_000_000_000 + 31 * 60_000;
  const result = await getCarry(at);
  assert.deepEqual(result.fees, { perpTaker: 4.5, perpMaker: 1.5, spotTaker: 7, spotMaker: 4, source: 'default' });
  assert.ok(calls.some(({ request }) => request.type === 'fundingHistory' && request.startTime === at - 168 * 3_600_000));
  assert.ok(calls.some(({ options }) => options?.label === 'carry' && options.priority === 'low'));
  globalThis.__carryHlInfo = original;
});

test('неполный ответ биржи даёт пустую карточку, а не исключение', async () => {
  const original = globalThis.__carryHlInfo;
  globalThis.__carryHlInfo = async (request, options) => {
    if (request.type === 'metaAndAssetCtxs' || request.type === 'spotMetaAndAssetCtxs') return null;
    if (request.type === 'userFees') return null;
    if (request.type === 'fundingHistory') return null;
    return original(request, options);
  };
  const result = await getCarry(2_000_000_000_000 + 62 * 60_000);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.fees, { perpTaker: 4.5, perpMaker: 1.5, spotTaker: 7, spotMaker: 4, source: 'account' });
  globalThis.__carryHlInfo = original;
});
