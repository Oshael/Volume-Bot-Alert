const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletTransferRoleHydrator,
} = require('../src/services/robinhood-wallet-transfer-role-hydration');

const ALICE = `0x${'1'.repeat(40)}`;
const BOB = `0x${'2'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function transfer(blockNumber) {
  return { blockNumber: String(blockNumber), blockHash: HASH, fromWallet: ALICE, toWallet: BOB };
}

function harness(roles = []) {
  const calls = { reads: [], probes: [], writes: [] };
  const deps = {
    repository: {
      loadRoles: async (addresses) => { calls.reads.push(addresses); return roles; },
      upsertEvidence: async (evidence) => { calls.writes.push(evidence); return evidence; },
    },
    reader: { resolveRoles: async ({ transfers }) => {
      calls.probes.push(transfers);
      const observations = transfers.map((item) => ({
        endpointAddress: item.fromWallet,
        endpointRole: item.fromWallet === BOB ? 'contract' : 'wallet',
        evidenceBlock: item.blockNumber, evidenceBlockHash: item.blockHash,
      }));
      return {
        contractAddresses: [BOB], walletAddresses: [ALICE], observations,
        telemetry: { probes: transfers.length, batches: 1, endpoints: 2 },
      };
    } },
  };
  return { calls, hydrator: createRobinhoodWalletTransferRoleHydrator(deps) };
}

describe('Robinhood historical transfer endpoint-role hydration', () => {
  it('skips archive RPC when persisted evidence covers every transfer block', async () => {
    const test = harness([
      { endpointAddress: ALICE, observedFromBlock: '90', observedThroughBlock: '210' },
      { endpointAddress: BOB, observedFromBlock: '90', observedThroughBlock: '210' },
    ]);
    const result = await test.hydrator.hydrate({ transfers: [transfer(100), transfer(200)] });
    assert.equal(result.probes, 0);
    assert.equal(test.calls.probes.length, 0);
    assert.equal(test.calls.writes.length, 0);
  });

  it('resolves every uncovered address/block but keeps dry-run read-only', async () => {
    const test = harness([
      { endpointAddress: ALICE, observedFromBlock: '90', observedThroughBlock: '210' },
      { endpointAddress: BOB, observedFromBlock: '150', observedThroughBlock: '150' },
    ]);
    const result = await test.hydrator.hydrate({ transfers: [transfer(100), transfer(200)] });
    assert.equal(result.probes, 2);
    assert.deepEqual(test.calls.probes[0].map(({ blockNumber }) => blockNumber), ['100', '200']);
    assert.deepEqual(result.contractAddresses, [BOB]);
    assert.equal(test.calls.writes.length, 0);
  });

  it('persists complete archive observations only for a confirmed range', async () => {
    const test = harness();
    const result = await test.hydrator.hydrate({
      transfers: [transfer(100), transfer(200)], commit: true,
    });
    assert.equal(result.persisted, 4);
    assert.equal(test.calls.writes[0].length, 4);
    assert.ok(test.calls.writes[0].every((item) => (
      item.evidenceSource === 'pc_archive' && item.resolverVersion === 'rh_endpoint_v1'
    )));
  });

  it('fails closed when the archive omits evidence for any planned probe', async () => {
    const test = harness();
    test.hydrator = createRobinhoodWalletTransferRoleHydrator({
      repository: {
        loadRoles: async () => [],
        upsertEvidence: async () => { throw new Error('must not write'); },
      },
      reader: { resolveRoles: async () => ({
        contractAddresses: [], walletAddresses: [], observations: [], telemetry: {},
      }) },
    });
    await assert.rejects(
      test.hydrator.hydrate({ transfers: [transfer(100)], commit: true }),
      /incomplete evidence/
    );
  });
});
