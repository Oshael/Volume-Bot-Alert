const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, buildPlan, parseArgs, repairLiveOrigin,
} = require('../src/utils/repair-robinhood-wallet-transfer-live-origin');

function snapshot(overrides = {}) {
  return {
    liveWorkerActive: false,
    cursor: { originBlock: null, nextBlock: '250', lifecycleState: 'running', version: 7 },
    ...overrides,
  };
}
function databaseFor(value) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM robinhood_wallet_transfer_cursors')) return { rows: [{
        origin_block: value.cursor.originBlock, next_block: value.cursor.nextBlock,
        lifecycle_state: value.cursor.lifecycleState, version: value.cursor.version,
      }] };
      return { rows: value.liveWorkerActive ? [{ active: true }] : [] };
    },
    getClient: async () => { throw new Error('dry-run must not open a transaction'); },
  };
}

describe('Robinhood wallet-transfer LIVE origin repair', () => {
  it('requires explicit version/origin and the long confirmation flag', () => {
    assert.deepEqual(parseArgs(['--projection-version=v1', '--live-origin-block=90']), {
      projectionVersion: 'v1', liveOriginBlock: '90', confirm: false,
    });
    assert.equal(parseArgs([
      '--projection-version=v1', '--live-origin-block=90', CONFIRM_FLAG,
    ]).confirm, true);
    assert.throws(() => parseArgs([]), /projection-version.*required/);
    assert.throws(() => parseArgs([
      '--projection-version=v1', '--live-origin-block=90', '--commit',
    ]), /unknown argument/);
  });

  it('rejects impossible or conflicting provenance', () => {
    assert.equal(buildPlan(snapshot(), '90').pendingWrites, 1);
    assert.throws(() => buildPlan(snapshot(), '251'), /exceeds current/);
    assert.throws(() => buildPlan(snapshot({
      cursor: { ...snapshot().cursor, originBlock: '91' },
    }), '90'), /conflicts/);
  });

  it('keeps dry-run read-only and blocks confirmation while LIVE is leased', async () => {
    const report = await repairLiveOrigin({
      database: databaseFor(snapshot()), projectionVersion: 'v1', liveOriginBlock: '90',
    });
    assert.equal(report.mode, 'dry-run');
    await assert.rejects(repairLiveOrigin({
      database: databaseFor(snapshot({ liveWorkerActive: true })),
      projectionVersion: 'v1', liveOriginBlock: '90', confirm: true,
    }), /lease is active/);
  });
});
