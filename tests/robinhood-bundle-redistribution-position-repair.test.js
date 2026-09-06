const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, execute, parseArgs, repairBatch, summarize,
} = require('../src/utils/repair-robinhood-bundle-redistribution-positions');

describe('Robinhood bundle redistribution transaction-position repair', () => {
  it('is read-only by default and validates bounded apply options', () => {
    assert.deepEqual(parseArgs([]), {
      apply: false, batchSize: 10, maxBatches: 1, pauseMs: 0,
      statementTimeoutMs: 120000,
    });
    assert.deepEqual(parseArgs([
      '--apply', CONFIRM_FLAG, '--batch-size=25', '--max-batches=20', '--pause-ms=10',
    ]), {
      apply: true, batchSize: 25, maxBatches: 20, pauseMs: 10,
      statementTimeoutMs: 120000,
    });
    assert.throws(() => parseArgs(['--apply']), /requires/);
    assert.throws(() => parseArgs(['--batch-size=26']), /between 1 and 25/);
  });

  it('separates fully recoverable tokens from archive or non-transfer gaps', () => {
    const result = summarize([
      { token_address: '0x1', needed: 3, recoverable: 3 },
      { token_address: '0x2', needed: 4, recoverable: 2 },
      { token_address: '0x3', needed: 0, recoverable: 0 },
    ], 3);
    assert.equal(result.repaired, 1);
    assert.deepEqual(result.repairedTokens, ['0x1']);
    assert.deepEqual(result.unresolved.map((item) => item.tokenAddress), ['0x2', '0x3']);
  });

  it('persists evidence and wakes only fully repaired pending tokens', async () => {
    const calls = [];
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql.includes('WITH tokens AS MATERIALIZED')) return { rows: [
          { token_address: '0x1', needed: 2, recoverable: 2, inserted: 2 },
          { token_address: '0x2', needed: 1, recoverable: 0, inserted: 2 },
        ] };
        if (sql.includes('SELECT token_address, observation_from_block')) {
          return { rowCount: 2, rows: [
            { token_address: '0x1', observation_from_block: '10' },
            { token_address: '0x2', observation_from_block: '10' },
          ] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() { calls.push('release'); },
    };
    const result = await repairBatch({ async getClient() { return client; } }, {
      apply: true, batchSize: 10, statementTimeoutMs: 120000, exclude: [],
    });
    assert.equal(result.inserted, 2);
    assert.deepEqual(result.repairedTokens, ['0x1']);
    assert.equal(calls.some((sql) => String(sql).includes('last_error_code = NULL')), true);
    assert.equal(calls.at(-1), 'release');
  });

  it('drains bounded batches and reports remaining errors', async () => {
    let runs = 0;
    const logs = [];
    const report = await execute({
      apply: true, batchSize: 10, maxBatches: 3, pauseMs: 0,
      statementTimeoutMs: 120000,
    }, {
      database: {}, logger: { log(value) { logs.push(value); } },
      async repairBatch(_database, input) {
        runs += 1;
        assert.equal(input.exclude.includes('0x1'), runs > 1);
        if (runs > 1) return summarize([], 0);
        return summarize([{ token_address: '0x1', needed: 2, recoverable: 2 }], 2);
      },
      async countPending() { return 0; },
    });
    assert.equal(report.status, 'drained');
    assert.equal(report.inserted, 2);
    assert.equal(logs.length, 1);
  });
});
