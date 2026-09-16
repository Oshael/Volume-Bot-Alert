'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DECISION_SQL,
  compareDecisions,
  createRobinhoodHeadClaimShadowRepository,
} = require('../src/models/robinhood-head-claim-shadow');

function row(block, hash = `0x${'a'.repeat(64)}`) {
  return {
    chain: 'robinhood', transaction_hash: hash, log_index: '0',
    block_number: String(block), transaction_index: '1',
    protocol: 'uniswap-v3', market_key: 'robinhood:uniswap-v3:test',
  };
}

describe('Robinhood head claim shadow', () => {
  it('uses the narrow state routes for every read-only claim branch', () => {
    assert.match(DECISION_SQL.market.state, /FROM robinhood_head_capture_states capture/);
    assert.match(DECISION_SQL.market.state, /WITH RECURSIVE first_v4_by_pool/);
    assert.match(DECISION_SQL.market.state, /protocol IS DISTINCT FROM 'uniswap-v4'/);
    assert.match(DECISION_SQL.discovery.state, /stream='discovery'/);
    Object.values(DECISION_SQL).forEach((streams) => Object.values(streams)
      .forEach((sql) => assert.doesNotMatch(sql, /UPDATE|FOR UPDATE/i)));
  });

  it('reports the first identity or ordering divergence', () => {
    assert.equal(compareDecisions([row(1)], [row(1)]).safe, true);
    const report = compareDecisions([row(1), row(2)], [row(2), row(1)]);
    assert.equal(report.safe, false);
    assert.equal(report.firstMismatch.index, 0);
    assert.equal(report.firstMismatch.legacy.blockNumber, '1');
    assert.equal(report.firstMismatch.state.blockNumber, '2');
  });

  it('compares market and discovery inside one repeatable-read transaction', async () => {
    const calls = [];
    const rows = [row(100)];
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql.includes('transaction_timestamp')) {
          return { rows: [{ snapshot_at: new Date('2026-09-16T12:00:00Z') }] };
        }
        if (sql.includes('head-claim-shadow')) return { rows };
        return { rows: [] };
      },
      release() { calls.push('release'); },
    };
    const repository = createRobinhoodHeadClaimShadowRepository({
      database: { async getClient() { return client; } },
    });
    const report = await repository.auditClaimDecisions({ limit: 10 });
    assert.equal(report.safe, true);
    assert.deepEqual(Object.keys(report.streams), ['market', 'discovery']);
    assert.equal(calls[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(calls.at(-2), 'COMMIT');
    assert.equal(calls.at(-1), 'release');
    assert.equal(calls.filter((sql) => sql.includes('head-claim-shadow')).length, 4);
  });
});
