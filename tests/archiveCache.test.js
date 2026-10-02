import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PUBLIC_WALLET_ADDRESS ||= '0x0000000000000000000000000000000000000000';
const { getArchivedHistorySince } = await import('../src/core/database.js');

test('архив: правка вернувшихся строк не портит кэш, новый файл перечитывается', () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'archive-'));
  mkdirSync(join(dir, 'data'));
  const file = join(dir, 'data', 'history_archive.json');
  try {
    process.chdir(dir);
    writeFileSync(file, JSON.stringify([{ id: 1, closed_at: 10, pnl: 1 }, { id: 2, closed_at: 20, pnl: 2 }]));

    const first = getArchivedHistorySince(15);
    assert.deepEqual(first.map((r) => r.id), [2]);
    first[0].pnl = 999;
    assert.equal(getArchivedHistorySince(0)[1].pnl, 2, 'кэш не должен видеть чужую правку');

    writeFileSync(file, JSON.stringify([{ id: 3, closed_at: 30, pnl: 3, extra: 'новый размер' }]));
    assert.deepEqual(getArchivedHistorySince(0).map((r) => r.id), [3]);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
