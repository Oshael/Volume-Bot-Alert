const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderInsiderSource,
  __private: { normalizeRows },
} = require('../src/models/robinhood-holder-insider-source');
const {
  buildInsiderSnapshot,
  createRobinhoodHolderInsiderMaterializer,
  INSIDER_DIRECT_RULE,
} = require('../src/services/robinhood-holder-insider-materializer');

const TOKEN = `0x${'1'.repeat(40)}`;
const CREATOR = `0x${'2'.repeat(40)}`;
const WALLET = `0x${'3'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;

function row(overrides = {}) {
  return {
    ledger_status: 'live', live_through_block: '200', live_through_hash: HASH,
    creator_address: CREATOR, attribution_source: 'rpc_direct',
    attribution_block: '90', attribution_tx_hash: TX,
    attribution_factory_address: null, transfer_lifecycle_state: 'running',
    transfer_next_block: '201', replay_id: '7', replay_from_block: '50',
    replay_through_block: '199', wallet_address: WALLET,
    first_wallet_transfer_block: '100', first_wallet_transfer_log_index: '2',
    first_wallet_transfer_at: '2026-08-23T12:00:00Z',
    first_wallet_transfer_transaction_hash: TX,
    first_wallet_transfer_amount_raw: '500', ...overrides,
  };
}

describe('Robinhood holder INSIDER direct materializer', () => {
  it('requires replay completion and transfer coverage through the holder frontier', () => {
    assert.equal(normalizeRows([row({ replay_id: null })], TOKEN).reason,
      'directional_replay_incomplete');
    assert.equal(normalizeRows([row({ transfer_next_block: '200' })], TOKEN).reason,
      'transfer_projection_behind');
    assert.equal(normalizeRows([row({ creator_address: null })], TOKEN).reason,
      'creator_unavailable');
    assert.equal(normalizeRows([row({
      creator_address: '0x000000000000000000000000000000000000dead',
    })], TOKEN).reason, 'creator_unavailable');
  });

  it('normalizes direct distribution and its frozen evidence coverage', () => {
    const evidence = normalizeRows([row()], TOKEN);
    assert.equal(evidence.ready, true);
    assert.deepEqual(evidence.coverage, {
      projectionVersion: 'rh_transfer_v1', replayRunId: '7',
      replayFromBlock: '50', replayThroughBlock: '199',
      transferCompleteThroughBlock: '200',
    });
    assert.deepEqual(evidence.distributions[0], {
      walletAddress: WALLET, blockNumber: '100', logIndex: '2',
      blockTime: '2026-08-23T12:00:00.000Z', transactionHash: TX, amountRaw: '500',
    });
  });

  it('queries only positive direct edges and excludes infrastructure at evidence time', async () => {
    let query;
    const source = createRobinhoodHolderInsiderSource({
      database: { async query(sql, params) { query = { sql, params }; return { rows: [row()] }; } },
    });
    assert.equal((await source.loadDirectDistributionEvidence(TOKEN)).ready, true);
    assert.match(query.sql, /direct\.from_wallet = attribution\.creator_address/);
    assert.match(query.sql, /direct\.first_wallet_transfer_amount_raw > 0/);
    assert.match(query.sql, /robinhood_infrastructure_registry/);
    assert.match(query.sql, /robinhood_pool_registry/);
    assert.deepEqual(query.params.slice(0, 3), ['robinhood', TOKEN, 'rh_transfer_v1']);
  });

  it('builds only the direct token-distribution high-confidence rule', () => {
    const snapshot = buildInsiderSnapshot(normalizeRows([row()], TOKEN),
      '2026-08-23T13:00:00Z');
    assert.deepEqual(INSIDER_DIRECT_RULE, {
      evidenceVersion: 'rh_insider_direct_v1', maxHops: 1,
      requirePositiveAmount: true, nativeFundingIncluded: false,
    });
    assert.equal(snapshot.classifier, 'insider');
    assert.equal(snapshot.records[0].reasonCode, 'creator_token_distribution');
    assert.equal(snapshot.records[0].confidence, 'high');
    assert.equal(snapshot.records[0].evidence.creator.address, CREATOR);
    assert.equal(snapshot.records[0].evidence.transfer.amountRaw, '500');
    assert.throws(() => buildInsiderSnapshot(normalizeRows([
      row({ first_wallet_transfer_amount_raw: '0' }),
    ], TOKEN), '2026-08-23T13:00:00Z'), /evidence is invalid/);
  });

  it('defers without replacing a snapshot when its source is not ready', async () => {
    let writes = 0;
    const materializer = createRobinhoodHolderInsiderMaterializer({
      source: { loadDirectDistributionEvidence: async () => ({
        ready: false, reason: 'directional_replay_incomplete',
      }) },
      classifications: { replaceClassifierSnapshot: async () => { writes += 1; } },
    });
    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'deferred', reason: 'directional_replay_incomplete', records: 0,
    });
    assert.equal(writes, 0);
  });

  it('replaces the shadow snapshot when evidence is ready', async () => {
    let stored;
    const materializer = createRobinhoodHolderInsiderMaterializer({
      source: { loadDirectDistributionEvidence: async () => normalizeRows([row()], TOKEN) },
      classifications: { replaceClassifierSnapshot: async (snapshot) => {
        stored = snapshot; return { status: 'replaced', records: snapshot.records.length };
      } },
      now: () => '2026-08-23T13:00:00Z',
    });
    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'replaced', records: 1,
    });
    assert.equal(stored.records[0].walletAddress, WALLET);
  });
});
