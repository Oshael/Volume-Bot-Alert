'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createCalloutRobinhoodEnrichmentRead, __private: readerPrivate,
} = require('../src/models/callout-robinhood-enrichment-read');
const {
  createCalloutChainEnrichment,
} = require('../src/services/callout-chain-enrichment');

const NOW = Date.parse('2026-08-25T15:00:00.000Z');
const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01';

function row(overrides = {}) {
  return {
    platform: 'fomo', platform_user_id: 'profile-1', username: 'caller',
    x_username: null, display_name: 'Caller', profile_picture_url: null,
    observation_key: 'fomo:wallet:1',
    address_normalized: '0x1111111111111111111111111111111111111111',
    chain_key: 'robinhood', relation_type: 'reported', source_type: 'platform_reported',
    source_field: 'evmAddress', source_record_id: 'leaderboard-1', confidence: 'high',
    evidence_at: '2026-08-25T13:00:00.000Z',
    transaction_hash: `0x${'a'.repeat(64)}`, action_index: '7', block_number: '100',
    block_time: '2026-08-25T14:00:00.000Z', protocol: 'uniswap-v3',
    market_key: 'robinhood:uniswap-v3:pool', volume_usd: '250.5',
    price_usd: '0.25', parser_version: 'rh-v1', ...overrides,
  };
}

describe('callout chain enrichment boundary', () => {
  it('returns explicit pending state when a chain has no adapter', async () => {
    const service = createCalloutChainEnrichment({ adapters: {} });
    assert.deepEqual(await service.listProfileWalletBuys({
      chainKey: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112',
    }), {
      status: 'pending', reason: 'adapter_unavailable', chainKey: 'solana',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      evidenceVersion: null, from: null, to: null,
      actions: [], hasMore: false,
    });
    assert.deepEqual(service.availableChains, []);
  });

  it('delegates only to the selected adapter and validates its contract', async () => {
    const expected = { status: 'ready', chainKey: 'robinhood', actions: [] };
    const service = createCalloutChainEnrichment({
      adapters: { robinhood: { listProfileWalletBuys: async () => expected } },
    });
    assert.equal(await service.listProfileWalletBuys({ chainKey: 'ROBINHOOD' }), expected);
    await assert.rejects(
      createCalloutChainEnrichment({
        adapters: { robinhood: { listProfileWalletBuys: async () => ({ status: 'ready', chainKey: 'base' }) } },
      }).listProfileWalletBuys({ chainKey: 'robinhood' }),
      /invalid contract/
    );
  });
});

describe('Robinhood profile-wallet buy reader', () => {
  it('uses only exact Robinhood or unresolved EVM bindings and proven buys', () => {
    const sql = readerPrivate.PROFILE_WALLET_BUYS_SQL;
    assert.match(sql, /wallet\.chain_key = 'robinhood'/);
    assert.match(sql, /wallet\.chain_family = 'evm'/);
    assert.match(sql, /wallet\.resolution_status = 'unknown_chain'/);
    assert.match(sql, /swap\.side = 'buy'/);
    assert.match(sql, /swap\.block_time >= \$2::timestamptz/);
    assert.match(sql, /swap\.block_time < \$3::timestamptz/);
    assert.doesNotMatch(sql, /callout_events/);
  });

  it('bounds the query to 72 hours and 200 rows', () => {
    const query = readerPrivate.normalizeQuery({ tokenAddress: TOKEN }, () => NOW);
    assert.equal(Date.parse(query.to) - Date.parse(query.from), readerPrivate.MAX_RANGE_MS);
    assert.equal(query.limit, readerPrivate.DEFAULT_LIMIT);
    assert.throws(() => readerPrivate.normalizeQuery({
      tokenAddress: TOKEN,
      from: '2026-08-21T15:00:00Z', to: '2026-08-25T15:00:00Z',
    }), (error) => error.code === 'INVALID_ENRICHMENT_RANGE');
    assert.throws(() => readerPrivate.normalizeLimit(201),
      (error) => error.code === 'INVALID_ENRICHMENT_LIMIT');
  });

  it('keeps profile binding separate from the on-chain wallet action', () => {
    const exact = readerPrivate.normalizeEvidence(row());
    assert.equal(exact.evidenceState, 'wallet_action');
    assert.match(exact.evidenceId, /callout_robinhood_wallet_buy_v1/);
    assert.equal(exact.correlationStatus, 'not_evaluated');
    assert.equal(exact.walletBinding.networkScope, 'exact_chain');
    assert.equal(exact.walletBinding.sourceType, 'platform_reported');
    assert.equal(exact.action.side, 'buy');
    assert.match(exact.action.actionId, /robinhood:wallet_buy:/);
    assert.equal(exact.action.amountUsd, 250.5);
    assert.equal(exact.provenance.actionSource, 'robinhood_wallet_swaps');

    const candidate = readerPrivate.normalizeEvidence(row({ chain_key: null }));
    assert.equal(candidate.walletBinding.networkScope, 'evm_address_candidate');
    assert.equal(candidate.correlationStatus, 'not_evaluated');
  });

  it('returns a bounded page with immutable provenance', async () => {
    const calls = [];
    const database = {
      query: async (sql, params) => { calls.push({ sql, params }); return { rows: [row(), row()] }; },
    };
    const reader = createCalloutRobinhoodEnrichmentRead({ database, now: () => NOW });
    const result = await reader.listProfileWalletBuys({ tokenAddress: TOKEN, limit: 1 });

    assert.deepEqual(calls[0].params, [
      TOKEN, '2026-08-22T15:00:00.000Z', '2026-08-25T15:00:00.000Z', 2,
    ]);
    assert.equal(result.status, 'ready');
    assert.equal(result.actions.length, 1);
    assert.equal(result.hasMore, true);
    assert.equal(Object.isFrozen(result.actions[0].provenance), true);
  });

  it('uses a short statement timeout when the database supports it', async () => {
    const calls = [];
    const database = {
      queryWithStatementTimeout: async (sql, params, timeoutMs) => {
        calls.push({ sql, params, timeoutMs }); return { rows: [] };
      },
    };
    const reader = createCalloutRobinhoodEnrichmentRead({ database, now: () => NOW });
    await reader.listProfileWalletBuys({ tokenAddress: TOKEN });
    assert.equal(calls[0].timeoutMs, readerPrivate.DEFAULT_STATEMENT_TIMEOUT_MS);
  });
});
