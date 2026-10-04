import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const [modulePath] = process.argv.slice(2);
const testsByModule = {
  'src/modules/executor/math.js': ['tests/executorMath.test.js', 'tests/calcPaperClose.test.js'],
  'src/modules/executor/sizing.js': ['tests/sizingEquityCap.test.js'],
  'src/modules/executor/fill-parser.js': ['tests/fillParser.test.js'],
  'src/modules/executor/close.js': ['tests/closeRejectionSync.test.js', 'tests/close.test.js'],
  'src/modules/executor/limitClose.js': ['tests/limitClose.test.js'],
  'src/modules/executor/triggers.js': ['tests/triggers.test.js'],
  'src/modules/dailyRisk.js': ['tests/dailyRisk.test.js', 'tests/dailyFeeBudget.test.js'],
  'src/modules/targetTrail.js': ['tests/targetTrail.test.js'],
  'src/modules/positionNanny.js': ['tests/positionNanny.test.js'],
  'src/modules/executor/reconciler.js': ['tests/reconciler.test.js'],
  'src/modules/executor/state.js': ['tests/executorState.test.js'],
};
if (!modulePath) {
  console.error('Usage: npm run mutation -- src/modules/path/to/module.js');
  process.exitCode = 1;
} else {
  const root = process.cwd();
  const absolute = resolve(root, modulePath);
  const normalized = relative(root, absolute);
  if (!normalized.startsWith('src/modules/') || !normalized.endsWith('.js') || !existsSync(absolute)) {
    console.error(`Expected an existing source module below src/modules/: ${modulePath}`);
    process.exitCode = 1;
  } else {
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      'stryker', 'run', '--mutate', normalized,
    ], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        STRYKER_TEST_COMMAND: `NODE_ENV=test node --test ${(testsByModule[normalized] ?? ['tests/*.test.js']).join(' ')}`,
      },
    });
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
