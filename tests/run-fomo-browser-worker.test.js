'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
  chromeArgs, main, optionsFromEnv,
} = require('../src/utils/run-fomo-browser-worker');

const OPTIONS = Object.freeze({
  chromePath: '/usr/bin/google-chrome-stable',
  profileDir: '/var/lib/fomo-browser/profile',
  cdpPort: 9222,
  startUrl: 'https://fomo.family/',
});

function harness() {
  const calls = [];
  const handlers = {};
  const child = new EventEmitter();
  child.kill = (signal) => { calls.push(['kill', signal]); child.emit('exit', 0, signal); };
  const runtimeProcess = {
    exitCode: undefined,
    once: (signal, handler) => { handlers[signal] = handler; },
  };
  return {
    calls, child, handlers, runtimeProcess,
    deps: {
      options: OPTIONS,
      fileSystem: {
        access: async (...args) => calls.push(['access', ...args]),
        stat: async (...args) => { calls.push(['stat', ...args]); return { isDirectory: () => true }; },
      },
      spawn: (...args) => { calls.push(['spawn', ...args]); return child; },
      process: runtimeProcess,
      logger: {
        log: (message) => calls.push(['log', message]),
        error: (message) => calls.push(['error', message]),
      },
    },
  };
}

describe('dedicated Fomo browser process', () => {
  it('validates bounded configuration and builds loopback-only Chrome arguments', () => {
    const options = optionsFromEnv({
      FOMO_BROWSER_CHROME_PATH: '/opt/google/chrome',
      FOMO_BROWSER_PROFILE_DIR: '/var/lib/fomo/profile',
      FOMO_BROWSER_CDP_PORT: '9333',
      FOMO_BROWSER_START_URL: 'https://www.fomo.family/alerts',
    });
    assert.equal(options.cdpPort, 9333);
    assert.deepEqual(chromeArgs(options), [
      '--headless=new', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9333', '--user-data-dir=/var/lib/fomo/profile',
      '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
      'https://www.fomo.family/alerts',
    ]);
    assert.throws(() => optionsFromEnv({ FOMO_BROWSER_CDP_PORT: '70000' }), /between 1 and 65535/);
    assert.throws(() => optionsFromEnv({ FOMO_BROWSER_START_URL: 'https://example.com/' }),
      /HTTPS fomo\.family/);
    assert.throws(() => optionsFromEnv({ FOMO_BROWSER_PROFILE_DIR: 'relative' }),
      /absolute path/);
  });

  it('checks the durable profile, launches Chrome and forwards shutdown', async () => {
    const test = harness();
    const runtime = await main(test.deps);
    const spawnCall = test.calls.find(([kind]) => kind === 'spawn');
    assert.equal(test.calls.filter(([kind]) => kind === 'access').length, 3);
    assert.deepEqual(test.calls.find(([kind, target]) => (
      kind === 'access' && target.endsWith('Local State')
    )).slice(0, 2), ['access', '/var/lib/fomo-browser/profile/Local State']);
    assert.equal(spawnCall[1], OPTIONS.chromePath);
    assert.deepEqual(spawnCall[2], chromeArgs(OPTIONS));
    assert.deepEqual(spawnCall[3], { stdio: 'inherit' });
    assert.equal(typeof test.handlers.SIGTERM, 'function');

    await runtime.shutdown();
    assert.deepEqual(test.calls.find(([kind]) => kind === 'kill'), ['kill', 'SIGTERM']);
    assert.equal(test.runtimeProcess.exitCode, undefined);
  });

  it('fails the supervisor when Chrome exits unexpectedly', async () => {
    const test = harness();
    const runtime = await main(test.deps);
    test.child.emit('exit', 2, null);
    await runtime.exit;
    assert.equal(test.runtimeProcess.exitCode, 1);
    assert.match(test.calls.find(([kind]) => kind === 'error')[1], /exited unexpectedly; code=2/);
  });
});
