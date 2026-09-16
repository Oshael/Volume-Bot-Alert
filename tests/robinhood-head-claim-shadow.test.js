'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DECISION_SQL,
  V4_CONTINUATION_SQL,
  compareDecisions,
  comparePoolKeys,
  createRobinhoodHeadClaimShadowRepository,
} = require('../src/models/robinhood-head-claim-shadow');
const {
  textOption,
} = require('../src/utils/audit-robinhood-head-v4-continuation-shadow');

function row(block, hash = `0x${'a'.repeat(64)}`) {
  return {
    chain: 'robinhood', transaction_hash: hash, log_index: '0',
    block_number: String(block), transaction_index: '1',
    protocol: 'uniswap-v3', market_key: 'robinhood:uniswap-v3:test',
  };
}

describe('Robinhood head claim shadow', () => {
  it('accepts a validated continuation cursor from the CLI', () => {
    assert.equal(textOption(
      'after-market-key', null, 256, ['node', '--after-market-key=POOL-A']
    ), 'pool-a');
    assert.throws(
      () => textOption('after-market-key', null, 256, ['node', '--after-market-key=']),
      /after-market-key is invalid/
    );
  });

  it('uses the narrow state routes for every read-only claim branch', () => {
    assert.match(DECISION_SQL.market.state, /FROM robinhood_head_capture_states capture/);
    assert.match(DECISION_SQL.market.state, /WITH RECURSIVE first_v4_by_pool/);
    assert.match(DECISION_SQL.market.state, /protocol IS DISTINCT FROM 'uniswap-v4'/);
    assert.match(DECISION_SQL.discovery.state, /stream='discovery'/);
    assert.match(V4_CONTINUATION_SQL.decisions.state, /marked_prefix AS MATERIALIZED/);
    assert.match(V4_CONTINUATION_SQL.decisions.state, /BOOL_OR/);
    assert.match(V4_CONTINUATION_SQL.pools.state, /processing_status IN/);
    Object.values(DECISION_SQL).forEach((streams) => Object.values(streams)
      .forEach((sql) => assert.doesNotMatch(sql, /UPDATE|FOR UPDATE/i)));
    Object.values(V4_CONTINUATION_SQL).forEach((branches) => Object.values(branches)
      .forEach((sql) => assert.doesNotMatch(sql, /UPDATE|FOR UPDATE/i)));
  });

  it('reports V4 pool routing divergence before comparing prefixes', () => {
    const legacy = [{ market_key: 'pool-a' }, { market_key: 'pool-b' }];
    const state = [{ market_key: 'pool-a' }, { market_key: 'pool-c' }];
    const report = comparePoolKeys(legacy, state);
    assert.equal(report.safe, false);
    assert.deepEqual(report.firstMismatch, {
      index: 1, legacy: 'pool-b', state: 'pool-c',
    });
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

  it('compares V4 continuation prefixes and pool inventories in one snapshot', async () => {
    const calls = [];
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql.includes('transaction_timestamp')) {
          return { rows: [{ snapshot_at: new Date('2026-09-16T12:00:00Z') }] };
        }
        if (sql.includes(':v4-pools')) return { rows: [{ market_key: 'pool-a' }] };
        if (sql.includes(':v4-continuation')) return { rows: [row(101)] };
        return { rows: [] };
      },
      release() { calls.push('release'); },
    };
    const repository = createRobinhoodHeadClaimShadowRepository({
      database: { async getClient() { return client; } },
    });
    const report = await repository.auditV4ContinuationDecisions({ limit: 10 });
    assert.equal(report.safe, true);
    assert.equal(report.requestedPoolCount, 1);
    assert.equal(report.complete, true);
    assert.equal(report.nextMarketKey, 'pool-a');
    assert.equal(report.decisions.legacyCount, 1);
    assert.equal(calls.filter((sql) => sql.includes(':v4-pools')).length, 2);
    assert.equal(calls.filter((sql) => sql.includes(':v4-continuation')).length, 2);
  });
});
