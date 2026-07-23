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
    withEnv({ BACKGROUND_WORKER_GROUPS: '' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['all']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['core', 'market', 'maintenance']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, ['robinhood']);
    });
  });

  it('normalizes selected worker groups and tracks skipped groups', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: ' core,market,core ' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['core', 'market']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['core', 'market']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, ['maintenance', 'robinhood']);
    });
  });

  it('treats all as all groups even when combined with a specific group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'maintenance,all' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['maintenance', 'all']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['core', 'market', 'maintenance']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, ['robinhood']);
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

  it('allows Robinhood only as an isolated worker group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['robinhood']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, ['core', 'market', 'maintenance']);
    });
  });

  it('keeps Robinhood user visibility independent and disabled by default', () => {
    withEnv({ ROBINHOOD_USER_VISIBILITY_ENABLED: '' }, (config) => {
      assert.deepEqual(config.robinhoodUserVisibility, { enabled: false });
    });
    withEnv({ ROBINHOOD_USER_VISIBILITY_ENABLED: 'true' }, (config) => {
      assert.deepEqual(config.robinhoodUserVisibility, { enabled: true });
    });
  });

  it('fails fast when Robinhood is mixed with shared worker groups', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', "require('./config')"],
      {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          BACKGROUND_WORKER_GROUPS: 'market,robinhood',
        },
        encoding: 'utf8',
      }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot combine isolated group robinhood/);
  });

  it('bounds the Robinhood retention worker maintenance controls', () => {
    withEnv({
      ROBINHOOD_RETENTION_ENABLED: 'true',
      ROBINHOOD_RETENTION_INTERVAL_MS: '1',
      ROBINHOOD_RETENTION_BATCH_LIMIT: '999999',
      ROBINHOOD_RETENTION_MAX_BATCHES: '0',
      ROBINHOOD_RETENTION_STATEMENT_TIMEOUT_MS: '500',
    }, (config) => {
      assert.deepEqual(config.robinhoodRetentionWorker, {
        enabled: true,
        intervalMs: 10_000,
        batchLimit: 10_000,
        maxBatches: 1,
        statementTimeoutMs: 1000,
      });
    });
  });

  it('runs Robinhood catalog reconciliation on a bounded one-minute default', () => {
    withEnv({ ROBINHOOD_CATALOG_PROJECTION_INTERVAL_MS: undefined }, (config) => {
      assert.equal(config.robinhoodCatalogProjectionWorker.intervalMs, 60_000);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialMetadataEnabled, true);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialBatchSize, 5);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialDrainIntervalMs, 60_000);
    });
    withEnv({
      ROBINHOOD_CATALOG_PROJECTION_INTERVAL_MS: '1',
      ROBINHOOD_SOCIAL_METADATA_BATCH_SIZE: '50',
      ROBINHOOD_SOCIAL_METADATA_INTERVAL_MS: '1',
    }, (config) => {
      assert.equal(config.robinhoodCatalogProjectionWorker.intervalMs, 60_000);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialBatchSize, 5);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialDrainIntervalMs, 60_000);
    });
  });

  it('keeps Robinhood ingestion disabled by default and bounds its runtime controls', () => {
    withEnv({
      ROBINHOOD_INGESTION_ENABLED: '',
      ROBINHOOD_POLL_INTERVAL_MS: '1',
      ROBINHOOD_MAX_ERROR_BACKOFF_MS: '999999',
      ROBINHOOD_RPC_MAX_RETRIES: '99',
      ROBINHOOD_RPC_MIN_INTERVAL_MS: '500',
      ROBINHOOD_ARCHIVE_RPC_MIN_INTERVAL_MS: '200',
      ROBINHOOD_RANGE_SIZE: '99999',
      ROBINHOOD_MAX_RANGE_SIZE: '99999',
      ROBINHOOD_MAX_RANGES_PER_POLL: '33',
      ROBINHOOD_DISCOVERY_MAX_RANGES_PER_POLL: '9999',
      ROBINHOOD_MARKET_MAX_RANGES_PER_POLL: '0',
      ROBINHOOD_LOOKBACK_BLOCKS: '0',
      ROBINHOOD_CONFIRMATIONS: '-1',
      ROBINHOOD_START_BLOCK: 'invalid',
      ROBINHOOD_USE_ALCHEMY: '',
      ROBINHOOD_MAX_ADDRESSES_PER_LOG_REQUEST: '9999',
      ROBINHOOD_MARKET_LOG_FILTER_MODE: 'tracked-addresses',
    }, (config) => {
      assert.equal(config.robinhoodIngestionWorker.enabled, false);
      assert.equal(config.robinhoodIngestionWorker.pollIntervalMs, 250);
      assert.equal(config.robinhoodIngestionWorker.maxErrorBackoffMs, 300_000);
      assert.equal(config.robinhoodIngestionWorker.rpcMaxRetries, 5);
      assert.equal(config.robinhoodIngestionWorker.rpcMinIntervalMs, 500);
      assert.equal(config.robinhoodIngestionWorker.archiveRpcMinIntervalMs, 200);
      assert.equal(config.robinhoodIngestionWorker.rangeSize, 10_000);
      assert.equal(config.robinhoodIngestionWorker.maxRangeSize, 10_000);
      assert.equal(config.robinhoodIngestionWorker.maxRangesPerPoll, 33);
      assert.equal(config.robinhoodIngestionWorker.discoveryMaxRangesPerPoll, 1000);
      assert.equal(config.robinhoodIngestionWorker.marketMaxRangesPerPoll, 1);
      assert.equal(config.robinhoodIngestionWorker.lookbackBlocks, 1);
      assert.equal(config.robinhoodIngestionWorker.confirmations, 0);
      assert.equal(config.robinhoodIngestionWorker.startBlock, null);
      assert.equal(config.robinhoodIngestionWorker.useAlchemy, false);
      assert.equal(config.robinhoodIngestionWorker.maxAddressesPerLogRequest, 1000);
      assert.equal(config.robinhoodIngestionWorker.marketLogFilterMode, 'tracked-addresses');
    });
  });

  it('inherits rollout axes from the legacy ingestion switch when new flags are absent', () => {
    withEnv({
      ROBINHOOD_INGESTION_ENABLED: 'true',
      ROBINHOOD_TRANSPORT_ENABLED: '',
      ROBINHOOD_PERSISTENCE_ENABLED: '',
      ROBINHOOD_ALERTS_ENABLED: '',
    }, (config) => {
      assert.deepEqual(config.robinhoodRollout, {
        transport: { enabled: true, explicit: false },
        persistence: { enabled: true, explicit: false },
        alerts: { requested: false, explicit: false },
      });
    });
  });

  it('parses explicit Robinhood transport, persistence and alert rollout controls', () => {
    withEnv({
      ROBINHOOD_INGESTION_ENABLED: 'true',
      ROBINHOOD_TRANSPORT_ENABLED: 'false',
      ROBINHOOD_PERSISTENCE_ENABLED: 'true',
      ROBINHOOD_ALERTS_ENABLED: 'true',
    }, (config) => {
      assert.deepEqual(config.robinhoodRollout, {
        transport: { enabled: false, explicit: true },
        persistence: { enabled: true, explicit: true },
        alerts: { requested: true, explicit: true },
      });
    });
  });

  it('keeps Robinhood signal gates unset until dry-run thresholds are explicit', () => {
    withEnv({
      ROBINHOOD_SIGNAL_DRY_RUN_ENABLED: 'true',
      ROBINHOOD_SIGNAL_PROTOCOLS: 'uniswap-v2,uniswap-v2',
      ROBINHOOD_SIGNAL_WINDOW_MS: '3600000',
      ROBINHOOD_SIGNAL_MIN_LIQUIDITY_USD: '10000.50',
      ROBINHOOD_SIGNAL_MIN_VOLUME_USD: '5000',
      ROBINHOOD_SIGNAL_MIN_TRANSACTIONS: '10',
      ROBINHOOD_SIGNAL_MAX_AGE_MS: '300000',
      ROBINHOOD_SIGNAL_CANDIDATE_LIMIT: '200',
      ROBINHOOD_SIGNAL_SAMPLE_LIMIT: '15',
      ROBINHOOD_SIGNAL_STATEMENT_TIMEOUT_MS: '5000',
    }, (config) => {
      assert.deepEqual(config.robinhoodSignalDryRun, {
        enabled: true,
        protocols: ['uniswap-v2'],
        windowMs: 3_600_000,
        minLiquidityUsd: '10000.50',
        minVolumeUsd: '5000',
        minTransactions: 10,
        maxAgeMs: 300_000,
        candidateLimit: 200,
        sampleLimit: 15,
        statementTimeoutMs: 5000,
      });
    });
  });

  it('defaults Robinhood signal reads above the observed five-minute token count', () => {
    withEnv({ ROBINHOOD_SIGNAL_CANDIDATE_LIMIT: '' }, (config) => {
      assert.equal(config.robinhoodSignalDryRun.candidateLimit, 1000);
    });
  });
});
