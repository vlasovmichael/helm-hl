import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hypothesisState } from '../tools/runWhileOpen.mjs';

const registry = {
  hypotheses: [
    { id: 'a', status: 'OPEN' },
    { id: 'b', status: 'CLOSED', resultStatus: 'REJECTED' },
  ],
};

test('runWhileOpen: OPEN, CLOSED и отсутствующая гипотеза различаются', () => {
  assert.equal(hypothesisState(registry, 'a'), 'open');
  assert.equal(hypothesisState(registry, 'b'), 'closed');
  assert.equal(hypothesisState(registry, 'zzz'), 'unknown');
});

// Бот и TUI — не сборщики; всё остальное в compose обязано гаснуть вместе со своей гипотезой.
const NOT_COLLECTORS = new Set(['hl-paper-scanner', 'tui']);

test('compose: каждый сборщик идёт через runWhileOpen и не поднимается после выхода', () => {
  const yml = readFileSync('docker-compose.yml', 'utf8');
  const services = yml.split(/^networks:/m)[0].split(/^ {2}(?=[a-z][\w-]*:\s*$)/m).slice(1);
  for (const block of services) {
    const name = block.slice(0, block.indexOf(':'));
    if (NOT_COLLECTORS.has(name)) continue;
    assert.match(block, /command: node tools\/runWhileOpen\.mjs /, `${name}: command не через runWhileOpen`);
    assert.match(block, /HYPOTHESIS_ID: \S+/, `${name}: нет HYPOTHESIS_ID`);
    assert.match(block, /restart: on-failure/, `${name}: нужен restart: on-failure`);
  }
});
