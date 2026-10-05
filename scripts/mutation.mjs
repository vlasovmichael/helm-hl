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
  'src/modules/strategistAdopt.js': ['tests/strategistAdopt.test.js'],
  'src/modules/adoptTrailStore.js': ['tests/adoptTrailStore.test.js'],
  'src/modules/adoptPeakTruth.js': ['tests/adoptPeakTruth.test.js'],
  'src/modules/adoptShadowTrail.js': ['tests/adoptShadowTrail.test.js'],
  'src/modules/paperEntry.js': ['tests/paperEntry.test.js'],
  'src/modules/ledger.js': ['tests/ledger.test.js'],
  'src/core/accountState.js': ['tests/accountState.test.js'],
  'src/core/fillFeed.js': ['tests/fillFeed.test.js'],
  'src/core/healthRegistry.js': ['tests/healthRegistry.test.js'],
  'src/core/oiHistory.js': ['tests/oiHistory.test.js'],
  'src/core/liqEvents.js': ['tests/liqEvents.test.js'],
  'src/core/priceHistory.js': ['tests/priceHistory.test.js', 'tests/priceHistoryWarmStart.test.js'],
  'src/modules/carry.js': ['tests/carry.test.js'],
  'src/modules/chartCoach.js': ['tests/chartCoach.test.js'],
  'src/modules/dayDesk.js': ['tests/dayDesk.test.js'],
  'src/modules/execCosts.js': ['tests/execCosts.test.js'],
  'src/modules/fadeHotSignal.js': ['tests/fadeHotSignal.test.js'],
  'src/modules/forwards.js': ['tests/forwards.test.js'],
  'src/modules/levelReads.js': ['tests/levelReads.test.js'],
  'src/modules/tgSignals.js': ['tests/tgSignals.test.js'],
  'src/modules/tradeGuards.js': ['tests/tradeGuards.test.js'],
  'src/modules/tradeJournal.js': ['tests/tradeJournal.test.js'],
  'src/modules/trendFollowAtr.js': ['tests/trendFollowAtr.test.js'],
  'src/modules/userFills.js': ['tests/userFills.test.js'],
  'src/modules/wallet.js': ['tests/wallet.test.js'],
  'src/modules/winnersPositions.js': ['tests/winnersPositions.test.js'],
};
if (!modulePath) {
  console.error('Usage: npm run mutation -- src/modules/path/to/module.js');
  process.exitCode = 1;
} else {
  const root = process.cwd();
  const absolute = resolve(root, modulePath);
  const normalized = relative(root, absolute);
  if (!(normalized.startsWith('src/modules/') || normalized.startsWith('src/core/')) || !normalized.endsWith('.js') || !existsSync(absolute)) {
    console.error(`Expected an existing source module below src/modules/ or src/core/: ${modulePath}`);
    process.exitCode = 1;
  } else {
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      'stryker', 'run', '--mutate', normalized,
    ], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
      STRYKER_TEST_COMMAND: `NODE_ENV=test PUBLIC_WALLET_ADDRESS=0x0000000000000000000000000000000000000000 PAPER_ENTRY_FAKE_DEPS=1 LEDGER_FAKE_DEPS=1 FILL_PARSER_FAKE_DEPS=1 TRIGGERS_FAKE_DEPS=1 DAILY_RISK_FAKE_DEPS=1 LIMIT_CLOSE_FAKE_DEPS=1 RECONCILER_FAKE_DEPS=1 CLOSE_FAKE_DEPS=1 node ${normalized === 'src/modules/executor/fill-parser.js' ? '--experimental-loader ./tests/helpers/fill-parser-loader.mjs ' : normalized === 'src/modules/executor/triggers.js' ? '--experimental-loader ./tests/helpers/triggers-loader.mjs ' : normalized === 'src/modules/dailyRisk.js' ? '--experimental-loader ./tests/helpers/daily-risk-loader.mjs ' : normalized === 'src/modules/executor/limitClose.js' ? '--experimental-loader ./tests/helpers/limit-close-loader.mjs ' : normalized === 'src/modules/executor/reconciler.js' ? '--experimental-loader ./tests/helpers/reconciler-loader.mjs ' : normalized === 'src/modules/executor/close.js' ? '--experimental-loader ./tests/helpers/close-loader.mjs ' : normalized === 'src/modules/paperEntry.js' ? '--experimental-loader ./tests/helpers/paper-entry-loader.mjs ' : normalized === 'src/modules/ledger.js' ? '--experimental-loader ./tests/helpers/ledger-loader.mjs ' : ''}--test ${(testsByModule[normalized] ?? ['tests/*.test.js']).join(' ')}`,
      },
    });
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
