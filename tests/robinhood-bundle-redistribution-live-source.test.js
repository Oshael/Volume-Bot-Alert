const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodBundleRedistributionLiveSource, __private } = require(
  '../src/models/robinhood-bundle-redistribution-live-source'
);

const TOKEN = `0x${'1'.repeat(40)}`;
const SOURCE = `0x${'2'.repeat(40)}`;
const RECIPIENT = `0x${'3'.repeat(40)}`;
const CREATOR = `0x${'4'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function ready(overrides = {}) {
  return { ledger_status: 'live', live_through_block: '100', live_through_hash: HASH,
    creator_address: CREATOR, attribution_block: '1',
    first_buy_next_time: '2026-09-01T00:00:00Z',
    first_buy_source_through: '2026-09-01T00:00:00Z', first_buy_source_next_block: '101',
    swap_lifecycle_state: 'running', swap_next_block: '101', swap_safe_head: '100',
    transfer_lifecycle_state: 'running', transfer_next_block: '101', ...overrides };
}

function edge(overrides = {}) {
  return { source_wallet: SOURCE, buy_block: '10', buy_tx_index: '1',
    buy_action_index: '2', buy_tx_hash: HASH, buy_time: '2026-09-01T00:00:00Z',
    buy_fdv_usd: '50000', recipient_wallet: RECIPIENT, transfer_block: '20',
    transfer_tx_index: '2', transfer_log_index: '3', transfer_tx_hash: HASH,
    transfer_time: '2026-09-01T00:01:00Z', transfer_amount_raw: '100', sell_block: '21',
    sell_tx_index: '3', sell_action_index: '4', sell_tx_hash: HASH,
    sell_time: '2026-09-01T00:02:00Z', sell_fdv_usd: null, ...overrides };
}

describe('Robinhood BUNDLED redistribution live source', () => {
  it('requires a future rollout observation frontier instead of backfilling history', async () => {
    const source = createRobinhoodBundleRedistributionLiveSource({ database: {
      async query() { throw new Error('database must not be queried'); },
    } });
    assert.equal((await source.loadToken(TOKEN)).reason, 'observation_frontier_missing');
    assert.equal((await source.loadToken(TOKEN, { observationFromBlock: '-1' })).reason,
      'observation_frontier_missing');
    const ahead = createRobinhoodBundleRedistributionLiveSource({ database: {
      async query() { return { rows: [ready()] }; },
    } });
    assert.equal((await ahead.loadToken(TOKEN, { observationFromBlock: '101' })).reason,
      'observation_frontier_ahead');
  });

  it('fails closed while any durable frontier is behind', () => {
    for (const [change, reason] of [
      [{ first_buy_source_next_block: '100' }, 'first_buy_frontier_behind'],
      [{ swap_safe_head: '99' }, 'swap_frontier_behind'],
      [{ transfer_next_block: '100' }, 'transfer_frontier_behind'],
      [{ creator_address: null }, 'creator_unavailable'],
      [{ creator_address: `0x${'0'.repeat(40)}` }, 'creator_unavailable'],
    ]) assert.equal(__private.readiness(ready(change), TOKEN).reason, reason);
  });

  it('returns token-scoped canonical evidence and temporal barriers', async () => {
    const calls = [];
    const database = { async query(sql, params) {
      calls.push({ sql, params });
      if (sql === __private.READINESS_SQL) return { rows: [ready()] };
      if (sql === __private.EVIDENCE_SQL) return { rows: [edge()] };
      return { rows: [{ address: RECIPIENT }] };
    } };
    const result = await createRobinhoodBundleRedistributionLiveSource({ database })
      .loadToken(TOKEN, { observationFromBlock: '15' });
    assert.equal(result.ready, true);
    assert.deepEqual(result.frontier, { blockNumber: '100', blockHash: HASH });
    assert.equal(result.sources[0].sourceBuy.transactionIndex, '1');
    assert.equal(result.sources[0].recipients[0].firstSell.fdvUsd, null);
    assert.deepEqual(result.barrierAddresses, [RECIPIENT]);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].params[3], '100');
    assert.equal(calls[1].params[4], '15');
    assert.match(calls[2].params[1], new RegExp(RECIPIENT));
  });

  it('blocks incomplete transaction positions instead of producing a false negative', async () => {
    const database = { async query(sql) {
      if (sql === __private.READINESS_SQL) return { rows: [ready()] };
      return { rows: [edge({ sell_tx_index: null })] };
    } };
    const result = await createRobinhoodBundleRedistributionLiveSource({ database })
      .loadToken(TOKEN, { observationFromBlock: '15' });
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'transaction_position_missing');
    assert.deepEqual(result.frontier, { blockNumber: '100', blockHash: HASH });
  });
});
