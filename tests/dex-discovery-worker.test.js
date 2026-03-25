const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const discoveryWorker = require('../src/services/dex-discovery-worker');
const tokenCatalog = require('../src/models/token-catalog');

const VALID_ADDRESS = '11111111111111111111111111111111';

let originalGetByAddress;
let originalUpsertToken;
let originalScheduleImmediateEvaluation;
let originalReactivateSoftArchivedToken;

describe('dex discovery archived-token handling', () => {
  beforeEach(() => {
    discoveryWorker.__private.resetStatus();
    originalGetByAddress = tokenCatalog.getByAddress;
    originalUpsertToken = tokenCatalog.upsertToken;
    originalScheduleImmediateEvaluation = tokenCatalog.scheduleImmediateEvaluation;
    originalReactivateSoftArchivedToken = tokenCatalog.reactivateSoftArchivedToken;
  });

  afterEach(() => {
    tokenCatalog.getByAddress = originalGetByAddress;
    tokenCatalog.upsertToken = originalUpsertToken;
    tokenCatalog.scheduleImmediateEvaluation = originalScheduleImmediateEvaluation;
    tokenCatalog.reactivateSoftArchivedToken = originalReactivateSoftArchivedToken;
  });

  it('reactivates soft-archived tokens that reappear in discovery', async () => {
    let reactivatedAddress = null;

    tokenCatalog.getByAddress = async () => ({ suppressed_reason: 'cleanup_soft_archive' });
    tokenCatalog.reactivateSoftArchivedToken = async (address) => {
      reactivatedAddress = address;
      return { address };
    };
    tokenCatalog.upsertToken = async () => {
      throw new Error('should not upsert existing archived token');
    };
    tokenCatalog.scheduleImmediateEvaluation = async () => {
      throw new Error('should not reschedule manually after archive reactivation');
    };

    await discoveryWorker.__private.upsertDiscoveredAddress(VALID_ADDRESS);

    assert.equal(reactivatedAddress, VALID_ADDRESS);
    assert.equal(discoveryWorker.getStatus().totalReactivatedArchived, 1);
    assert.equal(discoveryWorker.getStatus().totalScheduled, 1);
    assert.equal(discoveryWorker.getStatus().totalSkippedExisting, 0);
  });

  it('still skips existing non-archived tokens', async () => {
    tokenCatalog.getByAddress = async () => ({ suppressed_reason: null });
    tokenCatalog.reactivateSoftArchivedToken = async () => {
      throw new Error('should not reactivate non-archived token');
    };

    await discoveryWorker.__private.upsertDiscoveredAddress(VALID_ADDRESS);

    assert.equal(discoveryWorker.getStatus().totalReactivatedArchived, 0);
    assert.equal(discoveryWorker.getStatus().totalSkippedExisting, 1);
  });
});
