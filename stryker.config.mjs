/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  testRunner: 'command',
  coverageAnalysis: 'off',
  concurrency: 8,
  mutate: ['src/modules/**/*.js'],
  reporters: ['clear-text', 'json'],
  tempDirName: '/private/tmp/stryker-hl-paper-scanner',
  commandRunner: {
    command: process.env.STRYKER_TEST_COMMAND ?? 'npm test',
  },
};
