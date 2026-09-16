'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  AUXILIARY_SQL,
  compareValues,
  createRobinhoodHeadLifecycleShadowRepository,
  normalizeRetentionRow,
  normalizeWatermark,
} = require('../src/models/robinhood-head-lifecycle-shadow');

describe('Robinhood head lifecycle shadow', () => {
  it('defines only read-only legacy and narrow-state auxiliary decisions', () => {
    for (const branches of Object.values(AUXILIARY_SQL)) {
      assert.match(branches.legacy, /robinhood_head_captures/);
      assert.match(branches.state, /robinhood_head_capture_states/);
      for (const sql of Object.values(branches)) {
        assert.doesNotMatch(sql, /DELETE|UPDATE|FOR UPDATE/i);
      }
    }
    assert.match(AUXILIARY_SQL.frontier.state, /JOIN robinhood_head_captures payload/);
    assert.match(AUXILIARY_SQL.recovery.state, /LIMIT \(\$3::int \+ 1\)/);
  });

  it('detects watermark count and frontier identity divergence', () => {
    const watermark = compareValues(
      [{ pending_block: '100', pending: '2', leased: '1', blocked: '0' }],
      [{ pending_block: '100', pending: '1', leased: '1', blocked: '0' }],
      normalizeWatermark
    );
    assert.equal(watermark.safe, false);
    assert.equal(watermark.firstMismatch.legacy.pending, 2);
    assert.equal(watermark.firstMismatch.state.pending, 1);
  });

  it('does not require historical terminal routing for retention parity', () => {
    const base = {
      chain: 'robinhood', transaction_hash: `0x${'a'.repeat(64)}`, log_index: '0',
      processing_status: 'processed', terminal_at: '2026-09-10T00:00:00Z',
      retention_eligible_at: '2026-09-13T00:00:00Z',
    };
    const report = compareValues(
      [{ ...base, block_number: '100', transaction_index: '1' }],
      [{ ...base, block_number: null, transaction_index: null }],
      normalizeRetentionRow
    );
    assert.equal(report.safe, true);
  });

  it('audits every auxiliary decision inside one repeatable-read snapshot', async () => {
    const calls = [];
    const watermark = [{ pending_block: null, pending: '0', leased: '0', blocked: '0' }];
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql.includes('transaction_timestamp')) {
          return { rows: [{ snapshot_at: new Date('2026-09-16T12:00:00Z') }] };
        }
        if (sql.includes(':watermark')) return { rows: watermark };
        if (sql.includes('head-lifecycle-shadow')) return { rows: [] };
        return { rows: [] };
      },
      release() { calls.push('release'); },
    };
    const repository = createRobinhoodHeadLifecycleShadowRepository({
      database: { async getClient() { return client; } },
    });
    const report = await repository.auditAuxiliaryReads({ limit: 10 });
    assert.equal(report.safe, true);
    assert.deepEqual(Object.keys(report.streams), ['market', 'discovery']);
    assert.equal(calls[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(calls.filter((sql) => sql.includes('head-lifecycle-shadow')).length, 12);
    assert.equal(calls.at(-2), 'COMMIT');
    assert.equal(calls.at(-1), 'release');
  });
});
