const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG,
  buildPlan,
  main,
  parseArgs,
  repairOrigins,
} = require('../src/utils/repair-robinhood-wallet-swap-origins');

function snapshot(overrides = {}) {
  return {
    liveWorkerActive: false,
    seed: {
      stream: 'seed', originBlock: null, nextBlock: '201', safeHead: '200',
      lifecycleState: 'complete', completedAt: '2099-01-01T00:00:00.000Z', version: 4,
    },
    live: {
      stream: 'live', originBlock: null, nextBlock: '250', safeHead: '249',
      lifecycleState: 'running', completedAt: null, version: 7,
    },
    ...overrides,
  };
}

function databaseFor(value) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM robinhood_wallet_swap_cursors')) {
        return { rows: [
          {
            stream: 'seed', origin_block: value.seed.originBlock,
            next_block: value.seed.nextBlock, safe_head: value.seed.safeHead,
            lifecycle_state: value.seed.lifecycleState,
            completed_at: value.seed.completedAt, version: value.seed.version,
          },
          {
            stream: 'live', origin_block: value.live.originBlock,
            next_block: value.live.nextBlock, safe_head: value.live.safeHead,
            lifecycle_state: value.live.lifecycleState,
            completed_at: value.live.completedAt, version: value.live.version,
          },
        ] };
      }
      return { rows: value.liveWorkerActive ? [{ active: true }] : [] };
    },
    getClient: async () => { throw new Error('dry-run must not open a transaction'); },
  };
}

describe('Robinhood wallet-swap origin repair', () => {
  it('requires an explicit origin and long confirmation flag', () => {
    assert.deepEqual(parseArgs(['--seed-origin-block=90']), {
      seedOriginBlock: '90', confirm: false,
    });
    assert.equal(parseArgs(['--seed-origin-block=90', CONFIRM_FLAG]).confirm, true);
    assert.throws(() => parseArgs([]), /required exactly once/);
    assert.throws(() => parseArgs(['--seed-origin-block=90', '--commit']), /unknown argument/);
  });

  it('derives only the LIVE handoff and rejects conflicting provenance', () => {
    const plan = buildPlan(snapshot(), '90');
    assert.equal(plan.seedOriginBlock, '90');
    assert.equal(plan.liveOriginBlock, '201');
    assert.equal(plan.pendingWrites, 2);
    assert.throws(
      () => buildPlan(snapshot({ seed: { ...snapshot().seed, originBlock: '91' } }), '90'),
      /seed origin conflicts/
    );
    assert.throws(
      () => buildPlan(snapshot({ live: { ...snapshot().live, originBlock: '202' } }), '90'),
      /live origin conflicts/
    );
  });

  it('keeps dry-run read-only and blocks confirmation while LIVE is leased', async () => {
    const logs = [];
    const report = await main(['--seed-origin-block=90'], {
      database: databaseFor(snapshot()), logger: { log: (value) => logs.push(value) },
    });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.pendingWrites, 2);
    assert.equal(logs.length, 2);

    await assert.rejects(repairOrigins({
      database: databaseFor(snapshot({ liveWorkerActive: true })),
      seedOriginBlock: '90', confirm: true,
    }), /lease is active/);
  });
});
