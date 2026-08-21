const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CONFIG_PATH = require.resolve('../config');
const ROOT_DIR = path.resolve(__dirname, '..');
const WORKER_GROUPS = [
  'core', 'market', 'solana-maintenance', 'maintenance', 'robinhood-maintenance',
  'robinhood', 'robinhood-head', 'robinhood-processing', 'robinhood-derived',
  'robinhood-wallet', 'robinhood-backfill', 'robinhood-holders',
  'robinhood-holder-global', 'robinhood-wallet-intelligence', 'x-match', 'x-ingest',
];

function skippedExcept(...active) {
  return WORKER_GROUPS.filter((group) => !active.includes(group));
}

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
      assert.deepEqual(
        config.runtime.workerGroupsActive,
        ['core', 'market', 'solana-maintenance']
      );
      assert.deepEqual(
        config.runtime.workerGroupsSkipped,
        skippedExcept('core', 'market', 'solana-maintenance')
      );
      assert.deepEqual(config.runtime.maintenanceWorkerOwners, {
        catalogCleanup: 'solana-maintenance',
        robinhoodRetention: null,
        mockTradingTakeProfit: null,
      });
    });
  });

  it('normalizes selected worker groups and tracks skipped groups', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: ' core,market,core ' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['core', 'market']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['core', 'market']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('core', 'market'));
    });
  });

  it('rejects combining the legacy maintenance alias with all', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR,
      env: { ...process.env, BACKGROUND_WORKER_GROUPS: 'maintenance,all' },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot combine legacy maintenance/);
  });

  it('keeps the legacy maintenance group explicit with its previous worker ownership', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'maintenance' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsActive, ['maintenance']);
      assert.deepEqual(config.runtime.maintenanceWorkerOwners, {
        catalogCleanup: 'maintenance',
        robinhoodRetention: 'maintenance',
        mockTradingTakeProfit: 'maintenance',
      });
    });
  });

  it('allows Solana maintenance to share a process without Robinhood workers', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'core,solana-maintenance' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsActive, ['core', 'solana-maintenance']);
      assert.deepEqual(config.runtime.maintenanceWorkerOwners, {
        catalogCleanup: 'solana-maintenance',
        robinhoodRetention: null,
        mockTradingTakeProfit: null,
      });
    });
  });

  it('allows Robinhood maintenance only as an isolated worker group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood-maintenance' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-maintenance']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood-maintenance'));
      assert.deepEqual(config.runtime.maintenanceWorkerOwners, {
        catalogCleanup: null,
        robinhoodRetention: 'robinhood-maintenance',
        mockTradingTakeProfit: null,
      });
    });
  });

  it('rejects combining Robinhood maintenance with Solana maintenance', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        BACKGROUND_WORKER_GROUPS: 'robinhood-maintenance,solana-maintenance',
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot combine isolated worker groups/);
  });

  it('ships symmetric maintenance runners with distinct ports', () => {
    const scripts = require('../package.json').scripts;
    for (const prefix of ['start:worker', 'dev:worker']) {
      const solana = scripts[`${prefix}:solana-maintenance`];
      const robinhood = scripts[`${prefix}:robinhood-maintenance`];
      assert.match(solana, /PORT=\$\{PORT:-3003\}/);
      assert.match(solana, /RUN_SOCKET_HUB=false/);
      assert.match(solana, /BACKGROUND_WORKER_GROUPS=solana-maintenance/);
      assert.match(robinhood, /PORT=\$\{PORT:-3011\}/);
      assert.match(robinhood, /RUN_SOCKET_HUB=false/);
      assert.match(robinhood, /BACKGROUND_WORKER_GROUPS=robinhood-maintenance/);
    }
  });

  it('ships symmetric maintenance units with Robinhood retention disabled', () => {
    const systemdDir = path.join(ROOT_DIR, 'deploy', 'systemd');
    for (const [network, port] of [['solana', '3003'], ['robinhood', '3011']]) {
      const name = `${network}-maintenance`;
      const service = fs.readFileSync(
        path.join(systemdDir, `trendscope-worker@${name}.service.example`),
        'utf8'
      );
      const env = fs.readFileSync(path.join(systemdDir, `${name}.env.example`), 'utf8');
      assert.match(service, new RegExp(`EnvironmentFile=.*/${name}\\.env`));
      assert.match(env, new RegExp(`PORT=${port}`));
      assert.match(env, new RegExp(`BACKGROUND_WORKER_GROUPS=${name}`));
    }

    const robinhoodEnv = fs.readFileSync(
      path.join(systemdDir, 'robinhood-maintenance.env.example'),
      'utf8'
    );
    assert.match(robinhoodEnv, /ROBINHOOD_RETENTION_ENABLED=false/);
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
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood'));
    });
  });

  it('allows the Robinhood backfill only as an isolated worker group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood-backfill' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['robinhood-backfill']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-backfill']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood-backfill'));
    });
  });

  it('allows Robinhood holders only as an isolated worker group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood-holders' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['robinhood-holders']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-holders']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood-holders'));
    });
  });

  it('ships the systemd-compatible Robinhood holders worker runner', () => {
    const command = require('../package.json').scripts['start:worker:robinhood-holders'];

    assert.match(command, /PORT=\$\{PORT:-3010\}/);
    assert.match(command, /RUN_SOCKET_HUB=false/);
    assert.match(command, /RUN_BACKGROUND_JOBS=true/);
    assert.match(command, /BACKGROUND_WORKER_GROUPS=robinhood-holders/);
  });

  it('allows the global holder backfill as an isolated worker group without local live', () => {
    withEnv({
      BACKGROUND_WORKER_GROUPS: 'robinhood-holder-global',
      ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ENABLED: 'true',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_CATALOG_CUTOFF: '2026-08-10T00:00:00Z',
      ROBINHOOD_HOLDER_LIVE_ENABLED: 'false',
    }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-holder-global']);
      assert.deepEqual(
        config.runtime.workerGroupsSkipped,
        skippedExcept('robinhood-holder-global')
      );
    });
  });

  it('still requires local live when global backfill runs in the holders group', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        BACKGROUND_WORKER_GROUPS: 'robinhood-holders',
        ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
        ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ENABLED: 'true',
        ROBINHOOD_HOLDER_GLOBAL_BACKFILL_CATALOG_CUTOFF: '2026-08-10T00:00:00Z',
        ROBINHOOD_HOLDER_LIVE_ENABLED: 'false',
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROBINHOOD_HOLDER_LIVE_ENABLED=true/);
  });

  it('ships the isolated global holder backfill worker runner', () => {
    const command = require('../package.json').scripts[
      'start:worker:robinhood-holder-global'
    ];

    assert.match(command, /PORT=\$\{PORT:-3012\}/);
    assert.match(command, /RUN_SOCKET_HUB=false/);
    assert.match(command, /RUN_BACKGROUND_JOBS=true/);
    assert.match(command, /BACKGROUND_WORKER_GROUPS=robinhood-holder-global/);
  });

  it('allows the Robinhood head only as an isolated worker group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood-head' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['robinhood-head']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-head']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood-head'));
    });
  });

  it('allows the Robinhood processing only as an isolated worker group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood-processing' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['robinhood-processing']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-processing']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood-processing'));
    });
  });

  it('keeps the processing shadow auditor opt-in and bounds its sample limit', () => {
    withEnv({
      ROBINHOOD_PROCESSING_SHADOW_AUDIT_ENABLED: 'true',
      ROBINHOOD_PROCESSING_SHADOW_AUDIT_SAMPLE_LIMIT: '999',
      ROBINHOOD_PROCESSING_SHADOW_AUDIT_STATEMENT_TIMEOUT_MS: '1',
    }, (config) => {
      assert.equal(config.robinhoodProcessingWorker.shadowAuditEnabled, true);
      assert.equal(config.robinhoodProcessingWorker.shadowAuditSampleLimit, 20);
      assert.equal(config.robinhoodProcessingWorker.shadowAuditStatementTimeoutMs, 100);
    });
    withEnv({ ROBINHOOD_PROCESSING_SHADOW_AUDIT_ENABLED: undefined }, (config) => {
      assert.equal(config.robinhoodProcessingWorker.shadowAuditEnabled, false);
    });
  });

  it('allows the Robinhood derived only as an isolated worker group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood-derived' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['robinhood-derived']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-derived']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood-derived'));
    });
  });

  it('allows the Robinhood wallet-swap attribution only as an isolated worker group', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood-wallet' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsRequested, ['robinhood-wallet']);
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-wallet']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood-wallet'));
    });
  });

  it('isolates Robinhood wallet intelligence', () => {
    withEnv({ BACKGROUND_WORKER_GROUPS: 'robinhood-wallet-intelligence' }, (config) => {
      assert.deepEqual(config.runtime.workerGroupsActive, ['robinhood-wallet-intelligence']);
      assert.deepEqual(config.runtime.workerGroupsSkipped, skippedExcept('robinhood-wallet-intelligence'));
    });
  });

  it('keeps Robinhood wallet transfers opt-in and bounds RPC work', () => {
    withEnv({
      ROBINHOOD_WALLET_TRANSFER_LIVE_ENABLED: 'true',
      ROBINHOOD_WALLET_TRANSFER_LIVE_INTERVAL_MS: '1',
      ROBINHOOD_WALLET_TRANSFER_LIVE_MAX_BLOCKS_PER_TICK: '999',
      ROBINHOOD_WALLET_TRANSFER_ADDRESS_SHARD_CONCURRENCY: '9',
      ROBINHOOD_WALLET_TRANSFER_BLOCK_BATCH_SIZE: '999',
      ROBINHOOD_WALLET_TRANSFER_ROLE_BATCH_SIZE: '0',
      ROBINHOOD_WALLET_UNIFIED_POSITION_LIVE_ENABLED: 'true',
    }, (config) => {
      assert.deepEqual(config.robinhoodWalletTransferLiveWorker, {
        enabled: true, unifiedPositionEnabled: true,
        intervalMs: 250, maxErrorBackoffMs: 30_000,
        maxBlocks: 250, addressShardConcurrency: 4,
        blockEvidenceBatchSize: 100, endpointRoleBatchSize: 1,
      });
    });
    withEnv({ ROBINHOOD_WALLET_TRANSFER_LIVE_ENABLED: undefined }, (config) => {
      assert.equal(config.robinhoodWalletTransferLiveWorker.enabled, false);
    });
  });

  it('keeps the derived bucket shadow audit opt-in and bounds its query controls', () => {
    withEnv({
      ROBINHOOD_DERIVED_SHADOW_AUDIT_ONLY: 'true',
      ROBINHOOD_DERIVED_SHADOW_AUDIT_SAMPLE_LIMIT: '999',
      ROBINHOOD_DERIVED_SHADOW_AUDIT_STATEMENT_TIMEOUT_MS: '1',
      ROBINHOOD_DERIVED_STANDARD_ALERTS_ENABLED: 'true',
      ROBINHOOD_DERIVED_STANDARD_ALERTS_PUBLISHABLE: 'true',
      ROBINHOOD_DERIVED_LIVE_SINKS_ENABLED: 'true',
      ROBINHOOD_DERIVED_REALTIME_ALERTS_ENABLED: 'true',
      ROBINHOOD_DERIVED_REALTIME_ALERTS_PUBLISHABLE: 'true',
      ROBINHOOD_DERIVED_ALERT_HEALTH_MAX_AGE_MS: '1',
      ROBINHOOD_DERIVED_STANDARD_ALERT_MAX_EVENT_LAG_MS: '1',
      ROBINHOOD_DERIVED_STANDARD_ALERT_STATEMENT_TIMEOUT_MS: '999999',
      ROBINHOOD_ALERTS_ENABLED: 'true',
    }, (config) => {
      assert.equal(config.robinhoodDerivedWorker.shadowAuditOnly, true);
      assert.equal(config.robinhoodDerivedWorker.shadowAuditSampleLimit, 20);
      assert.equal(config.robinhoodDerivedWorker.shadowAuditStatementTimeoutMs, 100);
      assert.equal(config.robinhoodDerivedWorker.standardAlertsEnabled, true);
      assert.equal(config.robinhoodDerivedWorker.standardAlertsPublishable, true);
      assert.equal(config.robinhoodDerivedWorker.standardAlertsRequested, true);
      assert.equal(config.robinhoodDerivedWorker.liveSinksEnabled, true);
      assert.equal(config.robinhoodDerivedWorker.realtimeAlertsEnabled, true);
      assert.equal(config.robinhoodDerivedWorker.realtimeAlertsPublishable, true);
      assert.equal(config.robinhoodDerivedWorker.alertHealthMaxAgeMs, 10_000);
      assert.equal(config.robinhoodDerivedWorker.standardAlertMaxEventLagMs, 1000);
      assert.equal(config.robinhoodDerivedWorker.standardAlertStatementTimeoutMs, 60_000);
    });
    withEnv({
      ROBINHOOD_DERIVED_SHADOW_AUDIT_ONLY: undefined,
      ROBINHOOD_DERIVED_LIVE_SINKS_ENABLED: undefined,
      ROBINHOOD_DERIVED_REALTIME_ALERTS_ENABLED: undefined,
      ROBINHOOD_DERIVED_REALTIME_ALERTS_PUBLISHABLE: undefined,
    }, (config) => {
      assert.equal(config.robinhoodDerivedWorker.shadowAuditOnly, false);
      assert.equal(config.robinhoodDerivedWorker.liveSinksEnabled, false);
      assert.equal(config.robinhoodDerivedWorker.realtimeAlertsEnabled, false);
      assert.equal(config.robinhoodDerivedWorker.realtimeAlertsPublishable, false);
    });
  });

  it('fails fast when the Robinhood head is mixed with another group', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', "require('./config')"],
      {
        cwd: ROOT_DIR,
        env: { ...process.env, BACKGROUND_WORKER_GROUPS: 'robinhood-head,market' },
        encoding: 'utf8',
      }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot combine isolated worker groups/);
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
    assert.match(result.stderr, /cannot combine isolated worker groups/);
  });

  it('bounds the Robinhood retention worker maintenance controls', () => {
    withEnv({
      ROBINHOOD_RETENTION_ENABLED: 'true',
      ROBINHOOD_RETENTION_INTERVAL_MS: '1',
      ROBINHOOD_RETENTION_BATCH_LIMIT: '999999',
      ROBINHOOD_RETENTION_MAX_BATCHES: '0',
      ROBINHOOD_RETENTION_STATEMENT_TIMEOUT_MS: '500',
      ROBINHOOD_MARKET_AGGREGATE_VERIFIED_FROM: '2026-07-01T00:00:00.000Z',
      ROBINHOOD_MARKET_AGGREGATE_VERIFIED_THROUGH: '2026-07-20T00:00:00.000Z',
    }, (config) => {
      assert.deepEqual(config.robinhoodRetentionWorker, {
        enabled: true,
        intervalMs: 10_000,
        batchLimit: 10_000,
        maxBatches: 1,
        statementTimeoutMs: 1000,
        verifiedCoverage: {
          from: '2026-07-01T00:00:00.000Z',
          through: '2026-07-20T00:00:00.000Z',
        },
      });
    });
  });

  it('runs Robinhood catalog reconciliation on a bounded one-minute default', () => {
    withEnv({ ROBINHOOD_CATALOG_PROJECTION_INTERVAL_MS: undefined }, (config) => {
      assert.equal(config.robinhoodCatalogProjectionWorker.intervalMs, 60_000);
      assert.equal(config.robinhoodCatalogProjectionWorker.maxTokens, 50);
      assert.equal(config.robinhoodCatalogProjectionWorker.concurrency, 8);
      assert.equal(config.robinhoodCatalogProjectionWorker.blockscoutBatchSize, 50);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialMetadataEnabled, true);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialBatchSize, 5);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialDrainIntervalMs, 60_000);
    });
    withEnv({
      ROBINHOOD_CATALOG_PROJECTION_INTERVAL_MS: '1',
      ROBINHOOD_CATALOG_PROJECTION_MAX_TOKENS: '999',
      ROBINHOOD_CATALOG_PROJECTION_CONCURRENCY: '999',
      ROBINHOOD_BLOCKSCOUT_METADATA_BATCH_SIZE: '999',
      ROBINHOOD_SOCIAL_METADATA_BATCH_SIZE: '50',
      ROBINHOOD_SOCIAL_METADATA_INTERVAL_MS: '1',
    }, (config) => {
      assert.equal(config.robinhoodCatalogProjectionWorker.intervalMs, 60_000);
      assert.equal(config.robinhoodCatalogProjectionWorker.maxTokens, 50);
      assert.equal(config.robinhoodCatalogProjectionWorker.concurrency, 10);
      assert.equal(config.robinhoodCatalogProjectionWorker.blockscoutBatchSize, 50);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialBatchSize, 5);
      assert.equal(config.robinhoodCatalogProjectionWorker.socialDrainIntervalMs, 60_000);
    });
  });

  it('keeps Robinhood holder requests below the public Blockscout ceiling', () => {
    withEnv({
      ROBINHOOD_HOLDER_REQUESTS_PER_SECOND: '99',
      ROBINHOOD_HOLDER_REQUEST_CONCURRENCY: '99',
      ROBINHOOD_HOLDER_MAX_RETRIES: '99',
      ROBINHOOD_HOLDER_BACKOFF_BASE_MS: '1',
      ROBINHOOD_HOLDER_BACKOFF_MAX_MS: '999999',
      ROBINHOOD_HOLDER_CIRCUIT_FAILURE_THRESHOLD: '1',
      ROBINHOOD_HOLDER_CIRCUIT_RESET_MS: '1',
    }, (config) => {
      assert.deepEqual(config.robinhoodHolderRequests, {
        requestsPerSecond: 2,
        concurrency: 2,
        maxRetries: 3,
        baseBackoffMs: 250,
        maxBackoffMs: 120_000,
        circuitFailureThreshold: 2,
        circuitResetMs: 5000,
      });
    });
  });

  it('keeps native holder balances opt-in and bound to the configured Robinhood RPC', () => {
    withEnv({
      ROBINHOOD_HOLDER_NATIVE_BALANCE_ENABLED: 'true',
      ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
      ROBINHOOD_HOLDER_NATIVE_BALANCE_TIMEOUT_MS: '99999',
      ROBINHOOD_HOLDER_NATIVE_BALANCE_MAX_RETRIES: '99',
      ROBINHOOD_HOLDER_NATIVE_BALANCE_CACHE_TTL_MS: '999999',
    }, (config) => {
      assert.deepEqual(config.robinhoodHolderNativeBalance, {
        enabled: true, rpcUrl: 'http://127.0.0.1:8547', timeoutMs: 15_000,
        maxRetries: 2, cacheTtlMs: 300_000,
      });
    });
  });

  it('keeps the Blockscout holder summary opt-in and bounded', () => {
    withEnv({
      ROBINHOOD_HOLDER_SUMMARY_ENABLED: undefined,
      ROBINHOOD_HOLDER_SUMMARY_INTERVAL_MS: '1',
      ROBINHOOD_HOLDER_SUMMARY_BATCH_SIZE: '999',
      ROBINHOOD_HOLDER_HOT_REFRESH_MS: '1',
      ROBINHOOD_HOLDER_COLD_REFRESH_MS: '9999999999',
    }, (config) => {
      assert.equal(config.robinhoodHolderSummaryWorker.enabled, false);
      assert.equal(config.robinhoodHolderSummaryWorker.intervalMs, 10_000);
      assert.equal(config.robinhoodHolderSummaryWorker.batchSize, 50);
      assert.equal(config.robinhoodHolderSummaryWorker.hotRefreshMs, 60_000);
      assert.equal(config.robinhoodHolderSummaryWorker.coldRefreshMs, 604_800_000);
    });
  });

  it('keeps all isolated holder workers opt-in and bounded', () => {
    withEnv({
      ROBINHOOD_HOLDER_BACKFILL_ENABLED: undefined,
      ROBINHOOD_HOLDER_BACKFILL_ADMITTED_AFTER: undefined,
      ROBINHOOD_HOLDER_COLD_ENABLED: undefined,
      ROBINHOOD_HOLDER_COLD_ADMITTED_BEFORE: undefined,
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ENABLED: undefined,
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_CATALOG_CUTOFF: undefined,
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ROLLING_ENABLED: undefined,
      ROBINHOOD_HOLDER_LIVE_ENABLED: undefined,
      ROBINHOOD_HOLDER_INTELLIGENCE_ENABLED: undefined,
      ROBINHOOD_HOLDER_RECONCILIATION_ENABLED: undefined,
      ROBINHOOD_HOLDER_JOURNAL_PRUNE_ENABLED: undefined,
      ROBINHOOD_HOLDER_SNAPSHOT_ENABLED: undefined,
    }, (config) => {
      assert.equal(config.robinhoodHolderBackfillWorker.enabled, false);
      assert.equal(config.robinhoodHolderBackfillWorker.admittedAfter, null);
      assert.equal(config.robinhoodHolderColdWorker.enabled, false);
      assert.equal(config.robinhoodHolderColdWorker.admittedBefore, null);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.enabled, false);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.autoStart, false);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.rollingEnabled, false);
      assert.equal(config.robinhoodHolderLiveWorker.enabled, false);
      assert.equal(config.robinhoodHolderIntelligenceWorker.enabled, false);
      assert.equal(config.robinhoodHolderReconciliationWorker.enabled, false);
      assert.equal(config.robinhoodHolderJournalPruneWorker.enabled, false);
      assert.equal(config.robinhoodHolderSnapshotWorker.enabled, false);
    });
    withEnv({
      ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
      ROBINHOOD_HOLDER_LIVE_ENABLED: 'true', ROBINHOOD_HOLDER_COLD_ENABLED: 'false',
      ROBINHOOD_HOLDER_BACKFILL_ADMITTED_AFTER: '2026-08-10T00:00:00Z',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ENABLED: 'true',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_AUTO_START: 'true',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_CATALOG_CUTOFF: '2026-08-10T00:00:00Z',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_PREFETCH: '99',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_MAX_COMMIT_MS: '10000',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ADDRESS_SHARD_CONCURRENCY: '99',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ROLLING_ENABLED: 'true',
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ROLLING_MIN_TOKENS: '999999',
    }, (config) => {
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.enabled, true);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.autoStart, true);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.prefetch, 8);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.maxCommitMs, 10_000);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.addressShardConcurrency, 4);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.rollingEnabled, true);
      assert.equal(config.robinhoodHolderGlobalBackfillWorker.rollingMinTokens, 100_000);
    });
    withEnv({
      ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
      ROBINHOOD_HOLDER_BACKFILL_ENABLED: 'true',
      ROBINHOOD_HOLDER_BACKFILL_ADMITTED_AFTER: '2026-08-10T00:00:00Z',
      ROBINHOOD_HOLDER_BACKFILL_INTERVAL_MS: '1',
      ROBINHOOD_HOLDER_BACKFILL_MAX_ERROR_BACKOFF_MS: '1',
      ROBINHOOD_HOLDER_BACKFILL_SEED_LIMIT: '9999',
      ROBINHOOD_HOLDER_BACKFILL_MAX_INITIAL_GAP_BLOCKS: '9999999999',
      ROBINHOOD_HOLDER_BACKFILL_CONCURRENCY: '99',
      ROBINHOOD_HOLDER_BACKFILL_RANGE_SIZE: '9999',
      ROBINHOOD_HOLDER_BACKFILL_CONFIRMATIONS: '9999',
      ROBINHOOD_HOLDER_COLD_ENABLED: 'true',
      ROBINHOOD_HOLDER_COLD_ADMITTED_BEFORE: '2026-08-10T00:00:00Z',
      ROBINHOOD_HOLDER_COLD_INTERVAL_MS: '1',
      ROBINHOOD_HOLDER_COLD_MAX_ERROR_BACKOFF_MS: '1',
      ROBINHOOD_HOLDER_COLD_CANDIDATE_LIMIT: '9999',
      ROBINHOOD_HOLDER_COLD_RETRY_MS: '9999999999',
      ROBINHOOD_HOLDER_COLD_RANGE_SIZE: '9999',
      ROBINHOOD_HOLDER_COLD_CONFIRMATIONS: '9999',
      ROBINHOOD_HOLDER_COLD_BLOCKSCOUT_TIMEOUT_MS: '1',
      ROBINHOOD_HOLDER_COLD_REQUESTS_PER_SECOND: '99',
      ROBINHOOD_HOLDER_COLD_REQUEST_MAX_RETRIES: '99',
      ROBINHOOD_HOLDER_LIVE_ENABLED: 'true',
      ROBINHOOD_HOLDER_INTELLIGENCE_ENABLED: 'true',
      ROBINHOOD_HOLDER_INTELLIGENCE_INTERVAL_MS: '1',
      ROBINHOOD_HOLDER_INTELLIGENCE_BATCH_SIZE: '999',
      ROBINHOOD_HOLDER_INTELLIGENCE_CONCURRENCY: '99',
      ROBINHOOD_HOLDER_LIVE_INTERVAL_MS: '999999',
      ROBINHOOD_HOLDER_LIVE_MAX_ERROR_BACKOFF_MS: '1',
      ROBINHOOD_HOLDER_LIVE_RANGE_SIZE: '9999',
      ROBINHOOD_HOLDER_LIVE_CONFIRMATIONS: '9999',
      ROBINHOOD_HOLDER_LIVE_MAX_APPLY_EVENTS: '999999',
      ROBINHOOD_HOLDER_LIVE_APPLY_BATCH_SIZE: '999999',
      ROBINHOOD_HOLDER_LIVE_APPLY_INTERVAL_MS: '1',
      ROBINHOOD_HOLDER_LIVE_APPLY_MAX_ERROR_BACKOFF_MS: '9999999999',
      ROBINHOOD_HOLDER_LIVE_ADDRESS_SHARD_CONCURRENCY: '99',
      ROBINHOOD_HOLDER_LIVE_RPC_TIMEOUT_MS: '1',
      ROBINHOOD_HOLDER_RECONCILIATION_ENABLED: 'true',
      ROBINHOOD_HOLDER_RECONCILIATION_INTERVAL_MS: '1',
      ROBINHOOD_HOLDER_RECONCILIATION_MAX_ERROR_BACKOFF_MS: '9999999999',
      ROBINHOOD_HOLDER_RECONCILIATION_REQUIRED_MATCHES: '99',
      ROBINHOOD_HOLDER_RECONCILIATION_BLOCKSCOUT_TIMEOUT_MS: '1',
      ROBINHOOD_HOLDER_RECONCILIATION_UNAVAILABLE_RETRY_MS: '1',
      ROBINHOOD_HOLDER_RECONCILIATION_REQUESTS_PER_SECOND: '99',
      ROBINHOOD_HOLDER_RECONCILIATION_REQUEST_MAX_RETRIES: '99',
      ROBINHOOD_HOLDER_JOURNAL_PRUNE_ENABLED: 'true',
      ROBINHOOD_HOLDER_JOURNAL_PRUNE_INTERVAL_MS: '1',
      ROBINHOOD_HOLDER_JOURNAL_PRUNE_MAX_ERROR_BACKOFF_MS: '1',
      ROBINHOOD_HOLDER_JOURNAL_RETENTION_BLOCKS: '9999999',
      ROBINHOOD_HOLDER_JOURNAL_PRUNE_BATCH_LIMIT: '999999',
      ROBINHOOD_HOLDER_JOURNAL_PRUNE_MAX_BATCHES: '999',
      ROBINHOOD_HOLDER_SNAPSHOT_ENABLED: 'true',
      ROBINHOOD_HOLDER_SNAPSHOT_INTERVAL_MS: '1',
      ROBINHOOD_HOLDER_SNAPSHOT_MAX_ERROR_BACKOFF_MS: '9999999999',
      ROBINHOOD_HOLDER_SNAPSHOT_BATCH_SIZE: '99999',
    }, (config) => {
      assert.deepEqual(config.robinhoodHolderBackfillWorker, {
        enabled: true,
        admittedAfter: '2026-08-10T00:00:00.000Z',
        intervalMs: 100,
        maxErrorBackoffMs: 1000,
        seedLimit: 1000,
        maxInitialGapBlocks: 100_000_000,
        concurrency: 8,
        rangeSize: 5000,
        confirmations: 1000,
      });
      assert.deepEqual(config.robinhoodHolderColdWorker, {
        enabled: true,
        admittedBefore: '2026-08-10T00:00:00.000Z',
        intervalMs: 10_000, maxErrorBackoffMs: 10_000,
        candidateLimit: 10, retryMs: 2_592_000_000,
        rangeSize: 5000, confirmations: 1000, blockscoutTimeoutMs: 1000,
        requestOptions: { requestsPerSecond: 0.5, concurrency: 1, maxRetries: 1 },
      });
      assert.deepEqual(config.robinhoodHolderLiveWorker, {
        enabled: true,
        intervalMs: 300_000,
        maxErrorBackoffMs: 1000,
        rangeSize: 5000,
        confirmations: 1000,
        addressShardConcurrency: 4,
        rpcTimeoutMs: 1000,
      });
      assert.deepEqual(config.robinhoodHolderLiveApplyWorker, {
        enabled: true, intervalMs: 50, maxErrorBackoffMs: 300_000,
        maxApplyEvents: 50_000, applyBatchSize: 1000, rpcTimeoutMs: 1000,
      });
      assert.deepEqual(config.robinhoodHolderIntelligenceWorker, {
        enabled: true, intervalMs: 10_000, maxErrorBackoffMs: 300_000,
        batchSize: 100, concurrency: 8, unavailableRetryMs: 3_600_000,
      });
      assert.deepEqual(config.robinhoodHolderReconciliationWorker, {
        enabled: true,
        intervalMs: 10_000,
        maxErrorBackoffMs: 3_600_000,
        requiredMatches: 5,
        blockscoutTimeoutMs: 1000,
        unavailableRetryMs: 60_000,
        requestOptions: { requestsPerSecond: 0.5, concurrency: 1, maxRetries: 1 },
      });
      assert.deepEqual(config.robinhoodHolderJournalPruneWorker, {
        enabled: true,
        intervalMs: 10_000,
        maxErrorBackoffMs: 10_000,
        retentionBlocks: 1_000_000,
        batchLimit: 50_000,
        maxBatches: 50,
      });
      assert.deepEqual(config.robinhoodHolderSnapshotWorker, {
        enabled: true, intervalMs: 10_000,
        maxErrorBackoffMs: 3_600_000, batchSize: 5000,
      });
    });
  });

  it('fails fast when holder backfill lacks its durable cutoff', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
        ROBINHOOD_HOLDER_BACKFILL_ENABLED: 'true',
        ROBINHOOD_HOLDER_BACKFILL_ADMITTED_AFTER: '',
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROBINHOOD_HOLDER_BACKFILL_ADMITTED_AFTER/);
  });

  it('fails fast when holder cold runtime lacks its durable cutoff', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
        ROBINHOOD_HOLDER_COLD_ENABLED: 'true',
        ROBINHOOD_HOLDER_COLD_ADMITTED_BEFORE: '',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROBINHOOD_HOLDER_COLD_ADMITTED_BEFORE/);
  });

  it('rejects the serial cold worker during a global holder campaign', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR, encoding: 'utf8', env: { ...process.env,
        ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547', ROBINHOOD_HOLDER_LIVE_ENABLED: 'true',
        ROBINHOOD_HOLDER_BACKFILL_ADMITTED_AFTER: '2026-08-10T00:00:00Z',
        ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ENABLED: 'true',
        ROBINHOOD_HOLDER_GLOBAL_BACKFILL_CATALOG_CUTOFF: '2026-08-10T00:00:00Z',
        ROBINHOOD_HOLDER_COLD_ENABLED: 'true', ROBINHOOD_HOLDER_COLD_ADMITTED_BEFORE: '2026-08-10T00:00:00Z' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROBINHOOD_HOLDER_COLD_ENABLED must be false/);
  });

  it('fails fast when holder reconciliation is enabled without live capture', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ROBINHOOD_HOLDER_LIVE_ENABLED: 'false',
        ROBINHOOD_HOLDER_RECONCILIATION_ENABLED: 'true',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROBINHOOD_HOLDER_LIVE_ENABLED=true/);
  });

  it('fails fast when holder snapshots are enabled without live capture', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ROBINHOOD_HOLDER_LIVE_ENABLED: 'false',
        ROBINHOOD_HOLDER_SNAPSHOT_ENABLED: 'true',
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROBINHOOD_HOLDER_LIVE_ENABLED=true for holder snapshots/);
  });

  it('fails fast when holder intelligence is enabled without live capture', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: ROOT_DIR, encoding: 'utf8', env: {
        ...process.env,
        ROBINHOOD_HOLDER_LIVE_ENABLED: 'false',
        ROBINHOOD_HOLDER_INTELLIGENCE_ENABLED: 'true',
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROBINHOOD_HOLDER_LIVE_ENABLED=true for holder intelligence/);
  });

  it('keeps the DexScreener profile fast path disabled and bounded by default', () => {
    withEnv({
      ROBINHOOD_DEXSCREENER_PROFILE_ENABLED: undefined,
      ROBINHOOD_DEXSCREENER_PROFILE_INTERVAL_MS: undefined,
      ROBINHOOD_DEXSCREENER_PROFILE_PENDING_TTL_MS: undefined,
      ROBINHOOD_DEXSCREENER_PROFILE_PENDING_MAX: undefined,
    }, (config) => {
      assert.equal(config.robinhoodCatalogProjectionWorker.dexProfileEnabled, false);
      assert.equal(config.robinhoodCatalogProjectionWorker.dexProfileIntervalMs, 60_000);
      assert.equal(config.robinhoodCatalogProjectionWorker.dexProfilePendingTtlMs, 30 * 60_000);
      assert.equal(config.robinhoodCatalogProjectionWorker.dexProfilePendingMax, 500);
    });
    withEnv({
      ROBINHOOD_DEXSCREENER_PROFILE_ENABLED: 'true',
      ROBINHOOD_DEXSCREENER_PROFILE_INTERVAL_MS: '1',
      ROBINHOOD_DEXSCREENER_PROFILE_PENDING_TTL_MS: '1',
      ROBINHOOD_DEXSCREENER_PROFILE_PENDING_MAX: '999999',
    }, (config) => {
      assert.equal(config.robinhoodCatalogProjectionWorker.dexProfileEnabled, true);
      assert.equal(config.robinhoodCatalogProjectionWorker.dexProfileIntervalMs, 60_000);
      assert.equal(config.robinhoodCatalogProjectionWorker.dexProfilePendingTtlMs, 60_000);
      assert.equal(config.robinhoodCatalogProjectionWorker.dexProfilePendingMax, 5000);
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
      ROBINHOOD_TIMESTAMP_BATCH_SIZE: '999',
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
      assert.equal(config.robinhoodIngestionWorker.timestampBatchSize, 100);
    });
  });

  it('keeps wallet-swap LIVE disabled and bounds its independent controls', () => {
    withEnv({
      ROBINHOOD_WALLET_SWAP_LIVE_ENABLED: '',
      ROBINHOOD_WALLET_SWAP_LIVE_INTERVAL_MS: '1',
      ROBINHOOD_WALLET_SWAP_LIVE_MAX_BLOCKS_PER_TICK: '9999',
      ROBINHOOD_WALLET_SWAP_LIVE_REORG_DEPTH: '0',
      ROBINHOOD_WALLET_SWAP_LIVE_MAX_CONSECUTIVE_FAILURES: '999',
    }, (config) => {
      assert.deepEqual(config.robinhoodWalletSwapLiveWorker, {
        enabled: false,
        intervalMs: 250,
        maxErrorBackoffMs: 30_000,
        maxBlocks: 2000,
        reorgDepth: 1,
        maxConsecutiveFailures: 100,
      });
    });
  });

  it('keeps backfill shadow disabled and bounds its dedicated RPC controls', () => {
    withEnv({ ROBINHOOD_BACKFILL_SHADOW_ENABLED: '' }, (config) => {
      assert.equal(config.robinhoodBackfillMarketScanner.enabled, false);
    });
    withEnv({
      ROBINHOOD_BACKFILL_SHADOW_ENABLED: 'true',
      ROBINHOOD_BACKFILL_START_BLOCK: '0x64',
      ROBINHOOD_SCAN_PROVIDER: 'drpc',
      ROBINHOOD_HEAD_PROVIDER: 'public',
      ROBINHOOD_SCAN_RANGE_SIZE: '99999',
      ROBINHOOD_SCAN_MIN_RANGE_SIZE: '0',
      ROBINHOOD_SCAN_IN_FLIGHT_RANGES: '99',
      ROBINHOOD_SCAN_MAX_LOGS_PER_RANGE: '0',
      ROBINHOOD_SCAN_MAX_BUFFERED_LOGS: '9999999',
      ROBINHOOD_SCAN_MAX_PENDING_LOGS: '99999999',
      ROBINHOOD_BACKFILL_DISCOVERY_ENABLED: 'true',
      ROBINHOOD_DISCOVERY_SCAN_PROVIDER: 'alchemy',
      ROBINHOOD_DISCOVERY_SCAN_RANGE_SIZE: '10',
      ROBINHOOD_DISCOVERY_SCAN_MAX_RANGES_PER_POLL: '999',
      ROBINHOOD_BACKFILL_DISCOVERY_DECODER_VERSION: ' discovery-v2 ',
      ROBINHOOD_SCAN_INTERVAL_MS: '1',
      ROBINHOOD_SCAN_RPC_TIMEOUT_MS: '999999',
      ROBINHOOD_SCAN_RPC_MAX_RETRIES: '99',
      ROBINHOOD_SCAN_RPC_MIN_INTERVAL_MS: '999999',
      ROBINHOOD_BACKFILL_DECODER_VERSION: ' market-log-v2 ',
    }, (config) => {
      const scanner = config.robinhoodBackfillMarketScanner;
      assert.equal(scanner.enabled, true);
      assert.equal(scanner.startBlock, '0x64');
      assert.equal(scanner.rangeSize, 10_000);
      assert.equal(scanner.minRangeSize, 1);
      assert.equal(scanner.inFlightRanges, 8);
      assert.equal(scanner.maxLogsPerRange, 1);
      assert.equal(scanner.maxBufferedLogs, 1_000_000);
      assert.equal(scanner.maxPendingLogs, 10_000_000);
      assert.equal(scanner.intervalMs, 250);
      assert.equal(scanner.rpcTimeoutMs, 60_000);
      assert.equal(scanner.rpcMaxRetries, 5);
      assert.equal(scanner.rpcMinIntervalMs, 60_000);
      assert.equal(scanner.decoderVersion, 'market-log-v2');
      assert.deepEqual(config.robinhoodBackfillDiscoveryScanner, {
        enabled: true, scanProvider: 'alchemy', rangeSize: 10, maxRangesPerPoll: 100,
        decoderVersion: 'discovery-v2',
      });
    });
  });

  it('keeps backfill processing bounded and disabled unless explicit', () => {
    withEnv({
      ROBINHOOD_BACKFILL_ENRICHMENT_ENABLED: 'true',
      ROBINHOOD_BACKFILL_ALCHEMY_TIMESTAMPS_ENABLED: 'true',
      ROBINHOOD_ALCHEMY_RPC_URL: 'https://alchemy.test',
      ROBINHOOD_BACKFILL_ENRICHMENT_INTERVAL_MS: '1',
      ROBINHOOD_BACKFILL_ENRICHMENT_CLAIM_SIZE: '9999',
      ROBINHOOD_BACKFILL_ENRICHMENT_LEASE_MS: '1',
      ROBINHOOD_ENRICHMENT_RPC_MIN_INTERVAL_MS: '999999',
      ROBINHOOD_RPC_BATCH_SIZE: '999',
      ROBINHOOD_BACKFILL_FINALIZER_ENABLED: 'true',
      ROBINHOOD_BACKFILL_FINALIZER_INTERVAL_MS: '1',
      ROBINHOOD_BACKFILL_FINALIZER_RANGE_LIMIT: '0',
    }, (config) => {
      const enrichment = config.robinhoodBackfillEnrichmentWorker;
      assert.equal(enrichment.enabled, true);
      assert.equal(enrichment.alchemyTimestampsEnabled, true);
      assert.equal(enrichment.alchemyRpcUrl, 'https://alchemy.test');
      assert.equal(enrichment.intervalMs, 250);
      assert.equal(enrichment.limit, 1000);
      assert.equal(enrichment.leaseMs, 1000);
      assert.equal(enrichment.rpcMinIntervalMs, 60_000);
      assert.equal(enrichment.rpcBatchSize, 100);
      assert.deepEqual(config.robinhoodBackfillFinalizerWorker, {
        enabled: true,
        intervalMs: 250,
        maxErrorBackoffMs: 30_000,
        limit: 1,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5000,
      });
      assert.deepEqual(config.robinhoodBackfillWatchdogWorker, {
        enabled: true,
        intervalMs: 5000,
        maxErrorBackoffMs: 30_000,
        staleQueryThresholdMs: 20_000,
      });
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
