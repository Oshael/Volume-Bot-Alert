const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_DIR = __dirname;
const INTEGRATION_TESTS = [
  'admin.test.js',
  'auth.test.js',
  'billing.test.js',
  'catalog.test.js',
  'config.test.js',
  'dashboard.test.js',
  'mock-trading-routes.test.js',
  'telegram-routes.test.js',
  'telegram-alert-delivery.integration.test.js',
  'robinhood-alert-publication.integration.test.js',
  'robinhood-backfill-capture.integration.test.js',
  'robinhood-head-capture.integration.test.js',
  'robinhood-head-capture-adapter.integration.test.js',
  'robinhood-head-processing.integration.test.js',
  'robinhood-holder-global-backfill.integration.test.js',
  'robinhood-token-holder-summary.integration.test.js',
  'robinhood-wallet-swap-read.integration.test.js',
  'user-alert-presence.integration.test.js',
];

function getTestFiles() {
  return readdirSync(TEST_DIR)
    .filter((file) => file.endsWith('.test.js'))
    .sort();
}

function getGroupFiles(group) {
  const allTests = getTestFiles();
  const integrationSet = new Set(INTEGRATION_TESTS);
  const missingIntegrationTests = INTEGRATION_TESTS.filter((file) => !allTests.includes(file));

  if (missingIntegrationTests.length > 0) {
    throw new Error(`Missing integration tests: ${missingIntegrationTests.join(', ')}`);
  }

  if (group === 'unit') {
    return allTests.filter((file) => !integrationSet.has(file));
  }

  if (group === 'integration') {
    return [...INTEGRATION_TESTS];
  }

  throw new Error(`Unknown test group: ${group}`);
}

function runTestFiles(files, { sequential = false } = {}) {
  const batches = sequential ? files.map((file) => [file]) : [files];

  for (const batch of batches) {
    const relativeFiles = batch.map((file) => path.join('tests', file));
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-force-exit', ...relativeFiles],
      {
        cwd: path.resolve(TEST_DIR, '..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
        },
        stdio: 'inherit',
      }
    );

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }
}

const group = process.argv[2];
const files = getGroupFiles(group);

console.log(`[Tests] Running ${files.length} ${group} test files`);
runTestFiles(files, { sequential: group === 'integration' });
