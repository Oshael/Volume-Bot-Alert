'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodChainDomainOutboxRepository,
} = require('../src/models/robinhood-chain-domain-outbox');

describe('Robinhood chain domain outbox', () => {
  it('bounds the production frontier before locking and starts leases after the claim work', async () => {
    const calls = [];
    const repository = createRobinhoodChainDomainOutboxRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } });

    assert.deepEqual(await repository.claimNextBlock({
      owner: 'canonical-head', leaseMs: 60_000, maxBlocks: 16,
    }), []);
    assert.match(calls[0].sql, /WITH frontiers AS MATERIALIZED/);
    assert.match(calls[0].sql, /SELECT DISTINCT block_number/);
    assert.match(calls[0].sql, /readiness AS MATERIALIZED/);
    assert.match(calls[0].sql, /claimable AS MATERIALIZED/);
    assert.match(calls[0].sql, /lease_until=clock_timestamp\(\)/);
    assert.deepEqual(calls[0].params, ['robinhood', 'canonical-head', 60_000, 16]);
  });
});
