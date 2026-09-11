'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DATABASE,
  ESBUILD_PATH,
  ESBUILD_TEST_FILES,
  IMAGE,
  INIT_FILES,
  PURPOSE_LABEL,
  REQUIRED_TEST_FILES,
  TEST_FILES,
  createTestEnvironment,
  parsePublishedPort,
  resolveTestFiles,
  runRobinhoodReorgSafetyTest,
} = require('../src/utils/run-robinhood-reorg-safety-test');

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

function fakeDockerResult(args, options) {
  const action = args[0];
  if (action === 'version') {
    return options.dockerStatus
      ? { status: options.dockerStatus, stderr: 'docker daemon unavailable' }
      : { status: 0, stdout: '26.1.0\n' };
  }
  if (action === 'run') return { status: 0, stdout: 'container-id\n' };
  if (action === 'exec') return { status: 0 };
  if (action === 'port') return { status: 0, stdout: '127.0.0.1:49152\n' };
  if (action === 'rm') return { status: 0 };
  throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
}

function fakeNodeResult(args, options) {
  if (INIT_FILES.includes(args[0])) {
    return { status: options.initStatus ?? 0, stderr: options.initStderr || '' };
  }
  if (args[0] === '--test') return { status: options.testStatus ?? 0 };
  throw new Error(`Unexpected Node command: ${args.join(' ')}`);
}

function fakeRunner(options = {}) {
  const calls = [];
  const run = (command, args, input = {}) => {
    calls.push({ command, args, env: input.env, capture: input.capture });
    if (command === 'docker') return fakeDockerResult(args, options);
    if (command === process.execPath) return fakeNodeResult(args, options);
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { calls, run };
}

function uuidSequence() {
  let index = 0;
  return () => UUIDS[index++];
}

describe('Robinhood reorg safety test runner', () => {
  it('parses only a bounded loopback Docker port', () => {
    assert.equal(parsePublishedPort('127.0.0.1:49152\n'), 49152);
    assert.throws(() => parsePublishedPort('0.0.0.0:49152\n'), /Could not parse/);
    assert.throws(() => parsePublishedPort('127.0.0.1:99999\n'), /invalid/);
  });

  it('replaces every database target with the isolated loopback database', () => {
    const env = createTestEnvironment({
      DATABASE_URL: 'postgresql://production',
      DB_NAME: 'volume_alert',
      PGDATABASE: 'volume_alert',
      DB_HOST_TEST: 'production.internal',
      DB_NAME_TEST: 'volume_alert',
      ALLOW_UNSAFE_TEST_DATABASE: 'true',
      UNRELATED: 'preserved',
    }, 49152, 'secret');
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(
      env.DATABASE_URL,
      'postgresql://reorg_test:secret@127.0.0.1:49152/volume_alert_reorg_test'
    );
    assert.equal(env.DB_NAME, undefined);
    assert.equal(env.PGDATABASE, undefined);
    assert.equal(env.DB_HOST_TEST, undefined);
    assert.equal(env.DB_NAME_TEST, undefined);
    assert.equal(env.ALLOW_UNSAFE_TEST_DATABASE, 'false');
    assert.equal(env.DB_SSL, 'false');
    assert.equal(env.DB_SSL_TEST, 'false');
    assert.equal(env.PGSSLMODE, 'disable');
    assert.equal(env.PGSSLMODE_TEST, 'disable');
    assert.equal(env.UNRELATED, 'preserved');
    assert.equal(
      env.DATABASE_URL_TEST,
      'postgresql://reorg_test:secret@127.0.0.1:49152/volume_alert_reorg_test'
    );
  });

  it('keeps database tests required and skips only esbuild tests in a minimal deploy', () => {
    assert.deepEqual(resolveTestFiles((path) => path !== ESBUILD_PATH), {
      files: [...REQUIRED_TEST_FILES],
      skipped: [...ESBUILD_TEST_FILES],
    });
    assert.deepEqual(resolveTestFiles(() => true), {
      files: [...TEST_FILES],
      skipped: [],
    });
  });

  it('runs the suite against an isolated container and removes it after success', () => {
    const fake = fakeRunner();
    assert.deepEqual(runRobinhoodReorgSafetyTest({
      run: fake.run,
      randomUUID: uuidSequence(),
      env: { DATABASE_URL: 'postgresql://production' },
      wait: () => {},
      existsSync: () => true,
    }), { status: 'passed', files: TEST_FILES.length, skipped: 0 });

    const dockerRun = fake.calls.find(({ command, args }) => (
      command === 'docker' && args[0] === 'run'
    ));
    assert.ok(dockerRun.args.includes(IMAGE));
    assert.ok(dockerRun.args.includes(PURPOSE_LABEL));
    assert.ok(dockerRun.args.includes('127.0.0.1::5432'));

    const initFiles = fake.calls.filter(({ command, args }) => (
      command === process.execPath && INIT_FILES.includes(args[0])
    )).map(({ args }) => args[0]);
    assert.deepEqual(initFiles, [...INIT_FILES]);
    assert.equal(fake.calls.filter(({ command, args, capture }) => (
      command === process.execPath && INIT_FILES.includes(args[0]) && capture
    )).length, INIT_FILES.length);

    const test = fake.calls.find(({ command, args }) => (
      command === process.execPath && args[0] === '--test'
    ));
    assert.equal(test.env.NODE_ENV, 'test');
    assert.equal(test.env.DATABASE_URL, test.env.DATABASE_URL_TEST);
    assert.match(test.env.DATABASE_URL_TEST, new RegExp(`/${DATABASE}$`));
    assert.equal(test.args.includes('--test-concurrency=1'), true);
    assert.deepEqual(test.args.slice(-TEST_FILES.length), [...TEST_FILES]);

    const cleanup = fake.calls.find(({ command, args }) => (
      command === 'docker' && args[0] === 'rm'
    ));
    assert.deepEqual(cleanup.args, [
      'rm', '--force', 'volume-alert-reorg-test-111111111111',
    ]);
  });

  it('preserves the isolated database when the test suite fails', () => {
    const fake = fakeRunner({ testStatus: 1 });
    assert.throws(() => runRobinhoodReorgSafetyTest({
      run: fake.run,
      randomUUID: uuidSequence(),
      wait: () => {},
      existsSync: () => true,
    }), /Robinhood reorg safety suite failed/);
    assert.equal(fake.calls.some(({ command, args }) => (
      command === 'docker' && args[0] === 'rm'
    )), false);
  });

  it('reports captured initialization failures', () => {
    const fake = fakeRunner({ initStatus: 1, initStderr: 'isolated initialization failed' });
    assert.throws(() => runRobinhoodReorgSafetyTest({
      run: fake.run,
      randomUUID: uuidSequence(),
      wait: () => {},
      existsSync: () => true,
    }), /db-init\.js.*isolated initialization failed/);
  });

  it('reports the Docker failure without creating a database', () => {
    const fake = fakeRunner({ dockerStatus: 1 });
    assert.throws(() => runRobinhoodReorgSafetyTest({
      run: fake.run,
      randomUUID: uuidSequence(),
      wait: () => {},
      existsSync: () => true,
    }), /docker daemon unavailable/);
    assert.equal(fake.calls.some(({ command, args }) => (
      command === 'docker' && args[0] === 'run'
    )), false);
  });
});
