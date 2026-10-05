import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const [modulePath] = process.argv.slice(2);
const testsByModule = {
  'src/modules/executor/math.js': ['tests/executorMath.test.js', 'tests/calcPaperClose.test.js'],
  'src/modules/executor/sizing.js': ['tests/sizingEquityCap.test.js'],
  'src/modules/executor/fill-parser.js': ['tests/fillParser.test.js', 'tests/fillParserResolveFake.test.js'],
  'src/modules/executor/close.js': ['tests/closeRejectionSync.test.js', 'tests/closeFake.test.js'],
  'src/modules/executor/limitClose.js': ['tests/limitCloseFake.test.js'],
  'src/modules/executor/triggers.js': ['tests/triggersFake.test.js'],
  'src/modules/dailyRisk.js': ['tests/dailyRisk.test.js', 'tests/dailyFeeBudget.test.js', 'tests/dailyRiskRefresh.test.js'],
  'src/modules/targetTrail.js': ['tests/targetTrail.test.js'],
  'src/modules/positionNanny.js': ['tests/positionNanny.test.js'],
  'src/modules/executor/reconciler.js': ['tests/reconcilerFake.test.js'],
  'src/modules/executor/state.js': ['tests/executorState.test.js'],
  'src/modules/tpGrid.js': ['tests/tpGrid.test.js'],
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
      STRYKER_TEST_COMMAND: `NODE_ENV=test FILL_PARSER_FAKE_DEPS=1 TRIGGERS_FAKE_DEPS=1 DAILY_RISK_FAKE_DEPS=1 LIMIT_CLOSE_FAKE_DEPS=1 RECONCILER_FAKE_DEPS=1 CLOSE_FAKE_DEPS=1 node ${normalized === 'src/modules/executor/fill-parser.js' ? '--experimental-loader ./tests/helpers/fill-parser-loader.mjs ' : normalized === 'src/modules/executor/triggers.js' ? '--experimental-loader ./tests/helpers/triggers-loader.mjs ' : normalized === 'src/modules/dailyRisk.js' ? '--experimental-loader ./tests/helpers/daily-risk-loader.mjs ' : normalized === 'src/modules/executor/limitClose.js' ? '--experimental-loader ./tests/helpers/limit-close-loader.mjs ' : normalized === 'src/modules/executor/reconciler.js' ? '--experimental-loader ./tests/helpers/reconciler-loader.mjs ' : normalized === 'src/modules/executor/close.js' ? '--experimental-loader ./tests/helpers/close-loader.mjs ' : ''}--test ${(testsByModule[normalized] ?? ['tests/*.test.js']).join(' ')}`,
      },
    });
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
