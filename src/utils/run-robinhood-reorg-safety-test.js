'use strict';

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');

const DATABASE = 'volume_alert_reorg_test';
const USER = 'reorg_test';
const IMAGE = 'postgres:16-alpine';
const PURPOSE_LABEL = 'com.trendscope.purpose=robinhood-reorg-safety-test';
const INIT_FILES = Object.freeze([
  'src/utils/db-init.js',
  'src/utils/db-init-stage5.js',
]);
const REQUIRED_TEST_FILES = Object.freeze([
  'tests/robinhood-chain-capture-journal.integration.test.js',
  'tests/robinhood-wallet-swap-outbox.integration.test.js',
  'tests/robinhood-wallet-swap-realtime-audit-runner.test.js',
  'tests/robinhood-wallet-swap-realtime-publisher-runner.test.js',
  'tests/market-trade-finality-event.test.js',
  'tests/market-trade-realtime.test.js',
  'tests/frontend-robinhood-trades-format.test.js',
]);
const ESBUILD_TEST_FILES = Object.freeze([
  'tests/frontend-market-events.test.js',
  'tests/frontend-socket-client.test.js',
]);
const TEST_FILES = Object.freeze([...REQUIRED_TEST_FILES, ...ESBUILD_TEST_FILES]);
const ESBUILD_PATH = 'frontend/node_modules/esbuild';

function parsePublishedPort(output) {
  const match = String(output || '').trim().match(/(?:^|\n)127\.0\.0\.1:([0-9]+)$/m);
  if (!match) throw new Error(`Could not parse Docker PostgreSQL port: ${String(output).trim()}`);
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Docker PostgreSQL port is invalid: ${match[1]}`);
  }
  return port;
}

function createTestEnvironment(baseEnvironment, port, password) {
  const environment = { ...baseEnvironment };
  for (const key of [
    'DATABASE_URL', 'POSTGRES_URL', 'DATABASE_URL_TEST', 'POSTGRES_URL_TEST',
    'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
    'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
    'DB_HOST_TEST', 'DB_PORT_TEST', 'DB_NAME_TEST', 'DB_USER_TEST', 'DB_PASSWORD_TEST',
    'PGHOST_TEST', 'PGPORT_TEST', 'PGDATABASE_TEST', 'PGUSER_TEST', 'PGPASSWORD_TEST',
    'DB_SSL_TEST', 'DB_SSL_REJECT_UNAUTHORIZED_TEST', 'PGSSLMODE_TEST',
  ]) delete environment[key];
  environment.NODE_ENV = 'test';
  environment.ALLOW_UNSAFE_TEST_DATABASE = 'false';
  environment.DATABASE_URL_TEST =
    `postgresql://${USER}:${password}@127.0.0.1:${port}/${DATABASE}`;
  return environment;
}

function resolveTestFiles(pathExists = existsSync) {
  const optional = pathExists(ESBUILD_PATH) ? ESBUILD_TEST_FILES : [];
  return {
    files: [...REQUIRED_TEST_FILES, ...optional],
    skipped: ESBUILD_TEST_FILES.filter((file) => !optional.includes(file)),
  };
}

function commandFailure(label, result) {
  const stderr = String(result.stderr || '').trim().slice(0, 1000);
  const detail = result.error?.message || stderr || `exit ${result.status ?? 'unknown'}`;
  const error = new Error(`${label} failed (${detail})`);
  error.code = 'reorg_safety_command_failed';
  return error;
}

function createCommandRunner(options = {}) {
  const execute = options.spawnSync || spawnSync;
  return function run(command, args, input = {}) {
    return execute(command, args, {
      cwd: input.cwd || process.cwd(),
      env: input.env || process.env,
      encoding: 'utf8',
      stdio: input.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
  };
}

function dockerAvailable(run) {
  const result = run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true });
  if (result.status !== 0) throw commandFailure('Docker availability check', result);
  return String(result.stdout || '').trim();
}

function startPostgres(run, input) {
  const result = run('docker', [
    'run', '--detach',
    '--name', input.container,
    '--label', PURPOSE_LABEL,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_DB=${DATABASE}`,
    '--env', `POSTGRES_USER=${USER}`,
    '--env', `POSTGRES_PASSWORD=${input.password}`,
    IMAGE,
  ], { capture: true });
  if (result.status !== 0) throw commandFailure('Ephemeral PostgreSQL start', result);
}

function waitForPostgres(run, input = {}) {
  const attempts = input.attempts || 60;
  const wait = input.wait || ((milliseconds) => (
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  ));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = run('docker', [
      'exec', input.container, 'pg_isready', '--quiet',
      '--username', USER, '--dbname', DATABASE,
    ], { capture: true });
    if (result.status === 0) return attempt + 1;
    wait(500);
  }
  throw new Error('Ephemeral PostgreSQL did not become ready within 30 seconds');
}

function readPublishedPort(run, container) {
  const result = run('docker', ['port', container, '5432/tcp'], { capture: true });
  if (result.status !== 0) throw commandFailure('Docker port discovery', result);
  return parsePublishedPort(result.stdout);
}

function removeContainer(run, container) {
  const result = run('docker', ['rm', '--force', container], { capture: true });
  if (result.status !== 0) throw commandFailure('Ephemeral PostgreSQL cleanup', result);
}

function runRobinhoodReorgSafetyTest(options = {}) {
  const run = options.run || createCommandRunner(options);
  const id = (options.randomUUID || randomUUID)().replaceAll('-', '').slice(0, 12);
  const container = `volume-alert-reorg-test-${id}`;
  const password = `reorg-${(options.randomUUID || randomUUID)().replaceAll('-', '')}`;
  let started = false;
  let passed = false;

  console.log('[ReorgSafety] Checking Docker runtime...');
  const dockerVersion = dockerAvailable(run);
  console.log(`[ReorgSafety] Docker ${dockerVersion}; starting isolated PostgreSQL ${IMAGE}.`);
  try {
    startPostgres(run, { container, password });
    started = true;
    waitForPostgres(run, { container, wait: options.wait });
    const port = readPublishedPort(run, container);
    const env = createTestEnvironment(options.env || process.env, port, password);
    console.log(`[ReorgSafety] Target locked to 127.0.0.1:${port}/${DATABASE}.`);

    for (const file of INIT_FILES) {
      const init = run(process.execPath, [file], { env });
      if (init.status !== 0) throw commandFailure(`Test database initialization (${file})`, init);
    }

    const selection = resolveTestFiles(options.existsSync);
    if (selection.skipped.length) {
      console.log(`[ReorgSafety] Optional frontend tests skipped: ${selection.skipped.join(', ')}.`);
    }
    const tests = run(process.execPath, [
      '--test', '--test-force-exit', '--test-concurrency=1', ...selection.files,
    ], { env });
    if (tests.status !== 0) throw commandFailure('Robinhood reorg safety suite', tests);
    passed = true;
    console.log(`[ReorgSafety] PASS: ${selection.files.length} required/available test files completed.`);
    return { status: 'passed', files: selection.files.length, skipped: selection.skipped.length };
  } finally {
    if (started && passed) {
      removeContainer(run, container);
      console.log('[ReorgSafety] Ephemeral PostgreSQL removed.');
    } else if (started) {
      console.error(`[ReorgSafety] Test database preserved in Docker container ${container}.`);
      console.error(`[ReorgSafety] Inspect: docker logs ${container}`);
      console.error(`[ReorgSafety] Cleanup: docker rm --force ${container}`);
    }
  }
}

function printHelp() {
  console.log([
    'Usage: npm run robinhood:reorg-safety-test',
    '',
    'Starts an isolated PostgreSQL 16 container on a random loopback port,',
    'loads synthetic fixtures, runs the Robinhood reorg safety suite, and',
    'removes the database after success. A failed database is preserved.',
  ].join('\n'));
}

if (require.main === module) {
  if (process.argv.includes('--help')) printHelp();
  else {
    try {
      runRobinhoodReorgSafetyTest();
    } catch (error) {
      console.error(`[ReorgSafety] FAIL: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  DATABASE,
  ESBUILD_PATH,
  ESBUILD_TEST_FILES,
  IMAGE,
  INIT_FILES,
  PURPOSE_LABEL,
  REQUIRED_TEST_FILES,
  TEST_FILES,
  createCommandRunner,
  createTestEnvironment,
  parsePublishedPort,
  resolveTestFiles,
  runRobinhoodReorgSafetyTest,
};
