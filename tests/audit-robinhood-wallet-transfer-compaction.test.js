const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  loadCanonicalBlockHash,
  main,
  parseArgs,
} = require('../src/utils/audit-robinhood-wallet-transfer-compaction');

const ARGS = [
  '--day=2099-01-03',
  '--projection-version=rh_transfer_v1',
  '--position-projection-version=unified_transfer_v1',
];
const HASH = `0x${'a'.repeat(64)}`;

function harness() {
  const calls = [];
  const auditor = {
    inspectDay: async (input) => {
      calls.push({ method: 'inspectDay', input });
      return { lifecycleState: 'blocked', stateReason: 'position_incomplete' };
    },
    auditDay: async (input) => {
      calls.push({ method: 'auditDay', input });
      return { audit: { lifecycleState: 'verified' }, watermark: { lifecycle_state: 'verified' } };
    },
  };
  return {
    calls,
    deps: {
      database: {}, rpcClient: {}, logger: { log() {} },
      validateChainIds: async () => ({ primary: '4663' }),
      auditorFactory: (options) => {
        calls.push({ method: 'factory', options });
        return auditor;
      },
    },
  };
}

describe('Robinhood wallet transfer compaction audit command', () => {
  it('requires one explicit day and both projection versions', () => {
    assert.deepEqual(parseArgs(ARGS), {
      commit: false, partitionDay: '2099-01-03', projectionVersion: 'rh_transfer_v1',
      positionProjectionVersion: 'unified_transfer_v1',
    });
    assert.throws(() => parseArgs(ARGS.slice(1)), /--day is required/);
    assert.throws(() => parseArgs([...ARGS, '--day=2099-01-04']), /cannot be repeated/);
    assert.throws(() => parseArgs([...ARGS, '--limit=2']), /unknown argument/);
  });

  it('loads exactly the requested canonical block hash', async () => {
    const calls = [];
    const rpcClient = { request: async (method, params) => {
      calls.push({ method, params });
      return { number: '0x64', hash: HASH };
    } };
    assert.equal(await loadCanonicalBlockHash(rpcClient, '100'), HASH);
    assert.deepEqual(calls, [{ method: 'eth_getBlockByNumber', params: ['0x64', false] }]);
    await assert.rejects(
      loadCanonicalBlockHash({ request: async () => ({ number: '0x65', hash: HASH }) }, '100'),
      /does not match/
    );
  });

  it('is read-only by default and persists only with --commit', async () => {
    const dryRun = harness();
    const dryReport = await main(ARGS, dryRun.deps);
    assert.equal(dryReport.mode, 'dry-run');
    assert.equal(dryReport.watermark, null);
    assert.equal(dryRun.calls.some(({ method }) => method === 'inspectDay'), true);
    assert.equal(dryRun.calls.some(({ method }) => method === 'auditDay'), false);

    const committed = harness();
    const commitReport = await main([...ARGS, '--commit'], committed.deps);
    assert.equal(commitReport.mode, 'commit-watermark');
    assert.equal(commitReport.watermark.lifecycle_state, 'verified');
    assert.equal(committed.calls.some(({ method }) => method === 'auditDay'), true);
  });
});
