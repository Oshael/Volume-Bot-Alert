const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderCexSource,
} = require('../src/models/robinhood-holder-cex-source');
const {
  buildCexSnapshot,
  createRobinhoodHolderCexMaterializer,
} = require('../src/services/robinhood-holder-cex-materializer');

const TOKEN = `0x${'1'.repeat(40)}`;
const CEX = `0x${'2'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function candidate() {
  return {
    ready: true, tokenAddress: TOKEN,
    frontier: { blockNumber: '200', blockHash: HASH },
    entries: [{
      address: CEX, kind: 'cex', label: 'Example Exchange', source: 'manual_audit',
      evidence: { reference: 'case-1' }, validFromBlock: '100', validThroughBlock: null,
      verifiedAt: '2026-08-21T12:00:00.000Z',
    }],
  };
}

describe('Robinhood holder CEX materializer', () => {
  it('builds deterministic records with auditable registry evidence', () => {
    const snapshot = buildCexSnapshot(candidate(), '2026-08-21T13:00:00Z');

    assert.equal(snapshot.classifier, 'cex');
    assert.equal(snapshot.throughBlockNumber, '200');
    assert.deepEqual(snapshot.records, [{
      walletAddress: CEX, confidence: 'deterministic', reasonCode: 'known_cex_address',
      evidence: {
        source: 'robinhood_infrastructure_registry',
        registry: {
          label: 'Example Exchange', source: 'manual_audit',
          evidence: { reference: 'case-1' }, validFromBlock: '100',
          validThroughBlock: null, verifiedAt: '2026-08-21T12:00:00.000Z',
        },
      },
    }]);
  });

  it('does not publish before the holder frontier is ready', async () => {
    let publications = 0;
    const materializer = createRobinhoodHolderCexMaterializer({
      source: { loadCexEvidence: async () => ({
        ready: false, reason: 'holder_frontier_unavailable',
      }) },
      classifications: { replaceClassifierSnapshot: async () => { publications += 1; } },
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'deferred', reason: 'holder_frontier_unavailable', records: 0,
    });
    assert.equal(publications, 0);
  });

  it('batches holder lookups at the registry limit', async () => {
    const wallets = Array.from({ length: 10_001 }, (_, index) => (
      `0x${index.toString(16).padStart(40, '0')}`
    ));
    const calls = [];
    const source = createRobinhoodHolderCexSource({
      database: { query: async () => ({ rows: wallets.map((wallet) => ({
        token_address: TOKEN, ledger_status: 'live', live_through_block: '200',
        live_through_hash: HASH, wallet_address: wallet,
      })) }) },
      infrastructure: { listActiveAtBlock: async (input) => {
        calls.push(input);
        return [];
      } },
    });

    const result = await source.loadCexEvidence(TOKEN);

    assert.equal(result.ready, true);
    assert.deepEqual(calls.map(({ addresses }) => addresses.length), [10_000, 1]);
    assert.ok(calls.every((call) => call.kinds[0] === 'cex' && call.blockNumber === '200'));
  });
});
