const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletTokenFirstBuyRepository,
  __private,
} = require('../src/models/robinhood-wallet-token-first-buy');

describe('Robinhood wallet-token first buy writer', () => {
  it('benchmarks the same canonical source path without writing', async () => {
    const calls = [];
    const repository = createRobinhoodWalletTokenFirstBuyRepository({ database: {
      async queryWithStatementTimeout(sql, params, timeout) {
        calls.push({ sql, params, timeout });
        return { rows: [{
          rows_scanned: '8', missing_positions: '1', facts_considered: '3',
        }] };
      },
    } });
    const result = await repository.probeRange({
      rangeStart: '2026-08-22T00:00:00Z', rangeEnd: '2026-08-22T01:00:00Z',
    });
    assert.equal(result.rowsScanned, 8);
    assert.equal(result.missingPositions, 1);
    assert.equal(calls[0].timeout, 120_000);
    assert.doesNotMatch(calls[0].sql, /INSERT INTO robinhood_wallet_token_first_buys/);
    assert.match(calls[0].sql, /canonical AS MATERIALIZED/);
  });

  it('uses one bounded SQL materialization with canonical conflict ordering', async () => {
    const calls = [];
    const repository = createRobinhoodWalletTokenFirstBuyRepository({ database: {
      async queryWithStatementTimeout(sql, params, timeout) {
        calls.push({ sql, params, timeout });
        return { rows: [{
          rows_scanned: '12', missing_positions: '0',
          facts_considered: '4', facts_written: '3',
        }] };
      },
    } });
    const result = await repository.materializeRange({
      rangeStart: '2026-08-22T00:00:00Z', rangeEnd: '2026-08-22T01:00:00Z',
    });
    assert.deepEqual(result, {
      rangeStart: '2026-08-22T00:00:00.000Z', rangeEnd: '2026-08-22T01:00:00.000Z',
      rowsScanned: 12, factsConsidered: 4, factsWritten: 3,
    });
    assert.equal(calls[0].timeout, 120_000);
    assert.match(calls[0].sql, /ON CONFLICT \(chain, token_address, wallet_address\)/);
    assert.match(calls[0].sql, /EXCLUDED\.block_number.*EXCLUDED\.transaction_index/s);
  });

  it('fails closed before writing when an earliest block lacks position evidence', async () => {
    const repository = createRobinhoodWalletTokenFirstBuyRepository({ database: {
      async query() {
        return { rows: [{
          rows_scanned: '2', missing_positions: '1',
          facts_considered: '1', facts_written: '0',
        }] };
      },
    } });
    await assert.rejects(repository.materializeRange({
      rangeStart: '2026-08-22T00:00:00Z', rangeEnd: '2026-08-22T01:00:00Z',
    }), (error) => error.code === 'first_buy_position_unavailable');
    assert.match(__private.MATERIALIZE_RANGE_SQL, /WHERE \(SELECT missing_positions FROM quality\) = 0/);
  });

  it('rejects invalid and unbounded source ranges', () => {
    assert.throws(() => __private.normalizeRange({
      rangeStart: '2026-08-22T01:00:00Z', rangeEnd: '2026-08-22T00:00:00Z',
    }), /after rangeStart/);
    assert.throws(() => __private.normalizeRange({
      rangeStart: '2026-08-22T00:00:00Z', rangeEnd: '2026-08-24T00:00:01Z',
    }), /must not exceed 24 hours/);
  });
});
