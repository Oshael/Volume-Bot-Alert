'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodChainDomainShadowRunner,
  __private: { compareShadowRow },
} = require('../src/services/robinhood-chain-domain-shadow-runner');

function row(overrides = {}) {
  const topics = [`0x${'1'.repeat(64)}`];
  return {
    domain: 'market', block_hash: `0x${'2'.repeat(64)}`, block_number: '100',
    transaction_index: '1', log_index: 2, address: `0x${'3'.repeat(40)}`,
    topics, data: '0x', legacy_block_hash: `0x${'2'.repeat(64)}`,
    legacy_block_number: '100', legacy_transaction_index: '1',
    legacy_address: `0x${'3'.repeat(40)}`, legacy_topics: topics, legacy_data: '0x',
    ...overrides,
  };
}

describe('Robinhood chain domain shadow runner', () => {
  it('distinguishes matches, canonical-only candidates, and divergence', () => {
    assert.equal(compareShadowRow(row()).result, 'matched');
    assert.equal(compareShadowRow(row({ legacy_block_hash: null })).result, 'canonical_only');
    assert.deepEqual(compareShadowRow(row({ legacy_data: '0x01' })), {
      result: 'divergent', differences: ['data'],
    });
  });

  it('completes matches and canonical-only candidates but blocks divergence', async () => {
    const settled = [];
    const repository = {
      reclaimExpiredLeases: async () => 1,
      claimShadow: async () => [row(), row({ log_index: 3, legacy_block_hash: null }),
        row({ log_index: 4, legacy_data: '0x01' })],
      settle: async (input) => {
        settled.push(input);
        return { completed: input.complete.length, blocked: input.blocked.length, retried: 0 };
      },
    };
    const runner = createRobinhoodChainDomainShadowRunner({
      repository, options: { domain: 'market', owner: 'shadow-test' },
    });
    assert.deepEqual(await runner.runOnce(), {
      domain: 'market', reclaimed: 1, claimed: 3, matched: 1, canonicalOnly: 1,
      divergent: 1, completed: 2, blocked: 1, retried: 0,
    });
    assert.equal(settled[0].blocked[0].error.code, 'shadow_divergent');
  });
});
