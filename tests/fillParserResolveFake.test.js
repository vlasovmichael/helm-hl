import { test } from 'node:test';
import assert from 'node:assert/strict';

const useFakes = process.env.FILL_PARSER_FAKE_DEPS === '1';
const maybeTest = useFakes ? test : test.skip;
const { resolveAsset } = await import('../src/modules/executor/fill-parser.js');
const { resetUniverse } = await import('./helpers/fill-parser-universe-fake.js');
const { getRuntimeBans, resetRuntimeBans } = await import('./helpers/fill-parser-state-fake.js');
const { getLogEntries, resetLogEntries } = await import('./helpers/fill-parser-logger-fake.js');

maybeTest('resolveAsset reads a case-insensitive asset from the isolated universe fake', () => {
  resetUniverse({ universe: [{ name: 'kSHIB', szDecimals: 3 }], isFresh: true });
  resetRuntimeBans();
  resetLogEntries();

  assert.deepEqual(resolveAsset('KSHIB'), { szDecimals: 3 });
  assert.deepEqual(getRuntimeBans(), []);
  assert.deepEqual(getLogEntries(), []);
});

maybeTest('resolveAsset bans a missing asset only when the isolated universe is fresh', () => {
  resetUniverse({ universe: [
    { name: 'ETH', szDecimals: 4 }, { name: 'BTC', szDecimals: 5 }, { name: 'SOL', szDecimals: 3 },
    { name: 'AVAX', szDecimals: 2 }, { name: 'XRP', szDecimals: 1 }, { name: 'DOG', szDecimals: 0 },
    { name: 'ARB', szDecimals: 4 }, { name: 'OP', szDecimals: 5 }, { name: 'SUI', szDecimals: 3 },
    { name: 'APT', szDecimals: 2 }, { name: 'NEAR', szDecimals: 1 },
  ], isFresh: true });
  resetRuntimeBans();
  resetLogEntries();

  assert.throws(() => resolveAsset('DOGE'), /Asset "DOGE" not found in universe \(11 assets, fresh=true\)/);
  assert.deepEqual(getRuntimeBans(), ['DOGE']);
  assert.deepEqual(getLogEntries(), [
    ['error', '[FillParser] resolveAsset("DOGE") FAILED | universe: 11 assets, fresh: true | sample: [ETH, BTC, SOL, AVAX, XRP, DOG, ARB, OP, SUI, APT] | type of first: object'],
    ['warn', '[FillParser] "DOGE" added to runtime blacklist for 30min (runtime blacklist updated)'],
  ]);
});

maybeTest('resolveAsset reports a stale miss without adding a runtime ban', () => {
  resetUniverse({ universe: [], isFresh: false });
  resetRuntimeBans();
  resetLogEntries();

  assert.throws(() => resolveAsset('DOGE'), /0 assets, fresh=false/);
  assert.deepEqual(getRuntimeBans(), []);
  assert.deepEqual(getLogEntries(), [
    ['error', '[FillParser] resolveAsset("DOGE") FAILED | universe: 0 assets, fresh: false | sample: [] | type of first: undefined'],
    ['warn', '[FillParser] "DOGE" not found but universe is stale/empty — NOT banning'],
  ]);
});
