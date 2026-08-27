const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { materializePossibleBundles } = require(
  '../src/services/robinhood-possible-bundle-materializer'
);

const TOKEN = `0x${'9'.repeat(40)}`;
const A = `0x${'1'.repeat(40)}`;
const B = `0x${'2'.repeat(40)}`;
const C = `0x${'3'.repeat(40)}`;
const F = `0x${'4'.repeat(40)}`;
const G = `0x${'5'.repeat(40)}`;
const X = `0x${'6'.repeat(40)}`;
const F1 = `0x${'7'.repeat(40)}`;
const F2 = `0x${'8'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function candidate(walletAddress, firstBuyBlock = '102') {
  return { tokenAddress: TOKEN, walletAddress, launchBlock: '100',
    firstBuyBlock, firstBuyTransactionIndex: '1' };
}

let transaction = 0;
function evidence(candidateWallet, hop, fromAddress, toAddress, valueWei) {
  transaction += 1;
  return { tokenAddress: TOKEN, candidateWallet, hop, fromAddress, toAddress,
    valueWei: String(valueWei), blockNumber: '99', transactionIndex: '0',
    transactionHash: `0x${transaction.toString(16).padStart(64, '0')}` };
}

function materialize(candidates, funding, overrides = {}) {
  return materializePossibleBundles({
    tokenAddress: TOKEN, candidates, evidence: funding,
    evidenceVersion: 'rh_native_funding_v2', sourceKind: 'seed', sourceRunId: '1',
    lookbackBlocks: '1000', minimumValueWei: '10',
    throughBlockNumber: '200', throughBlockHash: HASH,
    barrierAddresses: [], ...overrides,
  });
}

describe('Robinhood possible bundle materializer', () => {
  it('forms a stable direct-member bundle without claiming common ownership', () => {
    const candidates = [candidate(A), candidate(B)];
    const funding = [evidence(B, 1, A, B, 25)];
    const result = materialize(candidates, funding);
    assert.equal(result.state.statusReason, 'groups_found');
    assert.equal(result.groups.length, 1);
    assert.deepEqual({ members: result.groups[0].memberCount,
      connections: result.groups[0].connectionCount,
      value: result.groups[0].qualifyingValueWei },
    { members: 2, connections: 1, value: '25' });
    assert.deepEqual(result.members.map(({ connectionKind }) => connectionKind),
      ['direct_member_funding', 'direct_member_funding']);
    assert.equal(result.groups[0].evidenceJson.signal, 'connected_funding_launch_cluster');
    assert.equal(materialize([...candidates].reverse(), funding).groups[0].bundleId,
      result.groups[0].bundleId);
  });

  it('merges transitive common-funder relations without requiring a star', () => {
    const candidates = [candidate(A), candidate(B), candidate(C)];
    const funding = [
      evidence(A, 1, F, A, 11), evidence(B, 1, F, B, 12),
      evidence(B, 1, G, B, 13), evidence(C, 1, G, C, 14),
    ];
    const result = materialize(candidates, funding);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].memberCount, 3);
    assert.equal(result.groups[0].connectionCount, 2);
    assert.equal(result.groups[0].qualifyingValueWei, '11');
    assert.deepEqual(result.groups[0].evidenceJson.connections.map(({ kind }) => kind),
      ['common_funder', 'common_funder']);
    assert.deepEqual(materialize([...candidates].reverse(), [...funding].reverse()), result);
    assert.equal(materialize(candidates, funding, { barrierAddresses: [F, G] }).groups.length, 0);
  });

  it('uses aggregate two-hop capacity and treats CEX/infra as traversal barriers', () => {
    const candidates = [candidate(A), candidate(B)];
    const funding = [
      evidence(A, 1, F1, A, 6), evidence(A, 1, F1, A, 6),
      evidence(A, 2, X, F1, 20), evidence(B, 1, F2, B, 15),
      evidence(B, 2, X, F2, 11),
    ];
    const result = materialize(candidates, funding);
    assert.equal(result.groups[0].qualifyingValueWei, '11');
    assert.equal(result.groups[0].evidenceJson.connections[0].kind, 'connected_ancestor');
    assert.equal(materialize(candidates, funding, { barrierAddresses: [X] }).groups.length, 0);
    assert.equal(materialize(candidates, funding, { barrierAddresses: [F1] }).groups.length, 0);
  });

  it('fails closed on invalid launch windows, evidence versions, and hops', () => {
    assert.throws(() => materialize([candidate(A, '104'), candidate(B)], []), /launch \+ 3/);
    assert.throws(() => materialize([candidate(A), candidate(B)], [], {
      evidenceVersion: 'rh_native_funding_v1',
    }), /must be rh_native_funding_v2/);
    assert.throws(() => materialize([candidate(A), candidate(B)], [
      evidence(A, 3, F, A, 10),
    ]), /hop must be 1 or 2/);
  });
});
