const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderIntelligenceReadRepository,
  __private,
} = require('../src/models/robinhood-holder-intelligence-read');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET_A = `0x${'2'.repeat(40)}`;
const WALLET_B = `0x${'3'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

function rowsFor(sql) {
  if (sql.includes('WITH stored_metrics')) return [{
    metric: 'dev_hold', classification_version: 'rh_holder_v1', status: 'ready',
    value_numerator_raw: '25', value_denominator_raw: '1000', wallet_count: '1',
    group_count: null, through_block_number: '200', through_block_hash: HASH_A,
    observed_at: '2026-08-21T12:00:00Z',
  }, {
    metric: 'snipers', classification_version: 'rh_holder_v1', status: 'ready',
    value_numerator_raw: '2', value_denominator_raw: '100', wallet_count: '2',
    group_count: null, through_block_number: '200', through_block_hash: HASH_A,
    observed_at: '2026-08-21T12:00:00Z',
  }];
  if (sql.includes('classification_states')) return [{
    classifier: 'cex', status: 'ready', through_block_number: '200',
    through_block_hash: HASH_A, observed_at: '2026-08-21T12:00:00Z',
  }, {
    classifier: 'lp', status: 'ready', through_block_number: '199',
    through_block_hash: HASH_B, observed_at: '2026-08-21T11:59:00Z',
  }, {
    classifier: 'sniper', status: 'reorged', through_block_number: '1',
    through_block_hash: HASH_B, observed_at: '2026-08-21T11:58:00Z',
  }];
  if (sql.includes('holder_classifications')) return [{
    wallet_address: WALLET_A, tag: 'cex', confidence: 'deterministic',
    reason_code: 'known_cex_address', observed_at: '2026-08-21T12:00:00Z',
    expires_at: null,
  }, {
    wallet_address: WALLET_A, tag: 'lp', confidence: 'deterministic',
    reason_code: 'registered_token_pool', observed_at: '2026-08-21T11:59:00Z',
    expires_at: null,
  }, {
    wallet_address: WALLET_A, tag: 'sniper', confidence: 'high',
    reason_code: 'early_launch_buy', observed_at: '2026-08-21T11:58:00Z',
    expires_at: null,
  }];
  return [];
}

describe('Robinhood holder intelligence public read', () => {
  it('returns compact tags, state frontier and complete metric availability', async () => {
    const calls = [];
    const repository = createRobinhoodHolderIntelligenceReadRepository({
      database: { query: async (sql, params) => {
        calls.push([sql, params]);
        return { rows: rowsFor(sql) };
      } },
    });

    const result = await repository.loadPage({
      tokenAddress: TOKEN.toUpperCase(), walletAddresses: [WALLET_A, WALLET_B, WALLET_A],
    });

    assert.equal(result.classificationVersion, 'rh_holder_v1');
    assert.equal(result.classificationStatus, 'reorged');
    assert.deepEqual(result.classificationThroughBlock, {
      blockNumber: '1', blockHash: HASH_B,
    });
    assert.deepEqual(result.holders[0].tags, ['lp', 'cex', 'sniper']);
    assert.equal(result.holders[0].primaryTag, 'sniper');
    assert.deepEqual(result.holders[0].classifications.map(({ reasonCode }) => reasonCode), [
      'known_cex_address', 'registered_token_pool', 'early_launch_buy',
    ]);
    assert.equal(result.holders[1].primaryTag, 'unknown');
    assert.equal(result.distribution.length, 8);
    assert.deepEqual(result.distribution.find(({ metric }) => metric === 'dev_hold').value, {
      numeratorRaw: '25', denominatorRaw: '1000',
    });
    assert.equal(result.distribution.find(({ metric }) => metric === 'snipers').status, 'ready');
    assert.equal(calls.length, 3);
    assert.ok(calls.every(([, params]) => params[0] === TOKEN));
    assert.match(calls.find(([sql]) => sql.includes('holder_classifications'))[0],
      /expires_at > NOW/);
    assert.ok(calls.slice(0, 2).every(([, params]) => params.some((value) => (
      Array.isArray(value) && value.includes('lp') && value.includes('cex')
        && value.includes('sniper')
    ))));
    const classificationCall = calls.find(([sql]) => sql.startsWith('SELECT wallet_address'));
    assert.equal(classificationCall[1].at(-1), 'rh_sniper_high_v2');
    assert.match(classificationCall[0], /confidence = 'high'/);
    const metricCall = calls.find(([sql]) => sql.includes('WITH stored_metrics'));
    assert.equal(metricCall[1][3], true);
    assert.equal(metricCall[1].at(-1), 'rh_sniper_high_v2');
    assert.match(metricCall[0], /current_snipers AS MATERIALIZED/);
  });

  it('keeps SNIPER private when explicitly removed from the public allowlist', async () => {
    const repository = createRobinhoodHolderIntelligenceReadRepository({
      publicTags: ['lp', 'cex'],
      database: { query: async (sql) => ({ rows: rowsFor(sql) }) },
    });
    const result = await repository.loadPage({
      tokenAddress: TOKEN, walletAddresses: [WALLET_A],
    });

    assert.deepEqual(result.holders[0].tags, ['lp', 'cex']);
    assert.equal(result.holders[0].primaryTag, 'cex');
    assert.equal(result.distribution.find(({ metric }) => metric === 'snipers').status,
      'unavailable');
  });

  it('marks a same-block hash disagreement as reorged and bounds page input', async () => {
    assert.deepEqual(__private.aggregateState([{
      status: 'ready', through_block_number: '10', through_block_hash: HASH_A,
    }, {
      status: 'ready', through_block_number: '10', through_block_hash: HASH_B,
    }]), {
      status: 'reorged', throughBlock: { blockNumber: '10', blockHash: HASH_A },
    });
    const repository = createRobinhoodHolderIntelligenceReadRepository({
      database: { query: async () => ({ rows: [] }) },
    });
    await assert.rejects(repository.loadPage({
      tokenAddress: TOKEN, walletAddresses: Array(51).fill(WALLET_A),
    }), /at most 50/);
  });
});
