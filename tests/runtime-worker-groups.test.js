const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CONFIG_PATH = require.resolve('../config');
const ROOT_DIR = path.resolve(__dirname, '..');

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  delete require.cache[CONFIG_PATH];
  try {
    return fn(require('../config'));
  } finally {
    delete require.cache[CONFIG_PATH];
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

describe('runtime worker groups config', () => {
  it('defaults to all worker groups', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: undefined }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['all']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['core', 'market', 'maintenance']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, []);
    });
  });

  it('normalizes selected worker groups and tracks skipped groups', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: ' core,market,core ' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['core', 'market']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['core', 'market']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, ['maintenance']);
    });
  });

  it('treats all as all groups even when combined with a specific group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'maintenance,all' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['maintenance', 'all']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['core', 'market', 'maintenance']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, []);
    });
  });

  it('fails fast on invalid worker groups', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', "require('./config')"],
      {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          BACKGROUND_WORKER_GROUPS: 'core,unknown',
        },
        encoding: 'utf8',
      }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BACKGROUND_WORKER_GROUPS invalid values: unknown/);
  });
});
