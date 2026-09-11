'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DATABASE,
  IMAGE,
  PURPOSE_LABEL,
  TEST_FILES,
  createTestEnvironment,
  parsePublishedPort,
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
  if (args[0] === 'src/utils/db-init.js') return { status: options.initStatus ?? 0 };
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

  it('removes production database variables from the child environment', () => {
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
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.DB_NAME, undefined);
    assert.equal(env.PGDATABASE, undefined);
    assert.equal(env.DB_HOST_TEST, undefined);
    assert.equal(env.DB_NAME_TEST, undefined);
    assert.equal(env.ALLOW_UNSAFE_TEST_DATABASE, 'false');
    assert.equal(env.UNRELATED, 'preserved');
    assert.equal(
      env.DATABASE_URL_TEST,
      'postgresql://reorg_test:secret@127.0.0.1:49152/volume_alert_reorg_test'
    );
  });

  it('runs the suite against an isolated container and removes it after success', () => {
    const fake = fakeRunner();
    assert.deepEqual(runRobinhoodReorgSafetyTest({
      run: fake.run,
      randomUUID: uuidSequence(),
      env: { DATABASE_URL: 'postgresql://production' },
      wait: () => {},
    }), { status: 'passed', files: TEST_FILES.length });

    const dockerRun = fake.calls.find(({ command, args }) => (
      command === 'docker' && args[0] === 'run'
    ));
    assert.ok(dockerRun.args.includes(IMAGE));
    assert.ok(dockerRun.args.includes(PURPOSE_LABEL));
    assert.ok(dockerRun.args.includes('127.0.0.1::5432'));

    const test = fake.calls.find(({ command, args }) => (
      command === process.execPath && args[0] === '--test'
    ));
    assert.equal(test.env.NODE_ENV, 'test');
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
    }), /Robinhood reorg safety suite failed/);
    assert.equal(fake.calls.some(({ command, args }) => (
      command === 'docker' && args[0] === 'rm'
    )), false);
  });

  it('reports the Docker failure without creating a database', () => {
    const fake = fakeRunner({ dockerStatus: 1 });
    assert.throws(() => runRobinhoodReorgSafetyTest({
      run: fake.run,
      randomUUID: uuidSequence(),
      wait: () => {},
    }), /docker daemon unavailable/);
    assert.equal(fake.calls.some(({ command, args }) => (
      command === 'docker' && args[0] === 'run'
    )), false);
  });
});
