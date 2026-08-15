const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRobinhoodWalletEndpointRoleBackfill,
} = require('../src/services/robinhood-wallet-endpoint-role-backfill');

const ADDRESS = `0x${'1'.repeat(40)}`;
const HASH = `0x${'2'.repeat(64)}`;

function harness(candidates = [{
  endpointAddress: ADDRESS, blockNumber: '100', blockHash: HASH,
}]) {
  const calls = { writes: [], reads: [] };
  return {
    calls,
    deps: {
      repository: {
        listUnresolvedCandidates: async () => candidates,
        upsertEvidence: async (items) => { calls.writes.push(items); return items; },
      },
      reader: { resolveRoles: async (input) => {
        calls.reads.push(input);
        return {
          contractAddresses: [], walletAddresses: [ADDRESS],
          evidence: [{
            endpointAddress: ADDRESS, endpointRole: 'wallet',
            evidenceBlock: '100', evidenceBlockHash: HASH,
          }],
          telemetry: { probes: 1, batches: 1, endpoints: 1 },
        };
      } },
    },
  };
}

describe('Robinhood wallet endpoint role backfill', () => {
  it('is dry-run by default and resolves only the bounded candidates', async () => {
    const test = harness();
    const result = await runRobinhoodWalletEndpointRoleBackfill(test.deps, { limit: 25 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.persisted, 0);
    assert.equal(test.calls.writes.length, 0);
    assert.equal(test.calls.reads[0].transfers[0].blockHash, HASH);
  });

  it('persists archive evidence only with explicit confirmation', async () => {
    const test = harness();
    const result = await runRobinhoodWalletEndpointRoleBackfill(test.deps, {
      limit: 25, commit: true,
    });
    assert.equal(result.status, 'persisted');
    assert.equal(result.persisted, 1);
    assert.deepEqual(test.calls.writes[0][0], {
      endpointAddress: ADDRESS, endpointRole: 'wallet',
      evidenceBlock: '100', evidenceBlockHash: HASH,
      evidenceSource: 'pc_archive', resolverVersion: 'rh_endpoint_v1',
    });
  });

  it('stops without RPC when all retained endpoints are resolved', async () => {
    const test = harness([]);
    const result = await runRobinhoodWalletEndpointRoleBackfill(test.deps, { commit: true });
    assert.deepEqual(result, { status: 'caught-up', candidates: 0, persisted: 0 });
    assert.equal(test.calls.reads.length, 0);
  });
});
