const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodWalletTransferRetentionTransaction } = require(
  '../src/models/robinhood-wallet-transfer-retention-transaction'
);

const DAY = '2026-07-19';
const INPUT = { day: DAY, expectedWatermarkVersion: '0',
  now: '2026-09-23T12:00:00Z' };

function fixture(overrides = {}) {
  const calls = [];
  let released = false;
  const watermark = {
    version: '0', lifecycle_state: 'verified', dropped_at: null,
    raw_event_count: '0', target_classified_event_count: '0',
    eligible_transfer_count: '0', eligible_amount_raw: '0',
    summary_transfer_count: '0', summary_amount_raw: '0', raw_last_block: null,
    summary_reconciled: true, position_complete: true, evidence_complete: true,
    cursor_complete: true, checkpoint_canonical: true,
    actual_partition: 'robinhood_token_transfer_events_2026_07_19', attached: true,
    partition_bound: "FOR VALUES FROM ('2026-07-19 02:00:00+02') TO ('2026-07-20 02:00:00+02')",
    ...overrides.watermark,
  };
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FOR UPDATE OF watermark')) return { rows: [watermark] };
      if (sql.includes('FROM robinhood_wallet_transfer_cursors transfer')) {
        return { rows: [{ transfer_state: 'running', transfer_time: '2026-07-21T00:00:00Z',
          transfer_next: '200', position_state: 'running', position_next: '200' }] };
      }
      if (sql.includes('FROM totals LEFT JOIN compared')) {
        return { rows: [{ total: '0', classified: '0', eligible: '0', amount: '0',
          summary_total: '0', summary_amount: '0', mismatches: '0',
          ...overrides.reconciliation }] };
      }
      if (sql.includes('SELECT 1 FROM robinhood_wallet_position_cursors')) {
        return { rowCount: 1 };
      }
      if (sql.includes('AS present')) {
        return { rows: [{ present: Boolean(overrides.dependency
          && sql.includes(overrides.dependency)) }] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  const gate = createRobinhoodWalletTransferRetentionTransaction({
    database: { getClient: async () => client },
    lockRecovery: async () => { calls.push('canonical recovery shared lock'); },
  });
  return { gate, calls, get released() { return released; } };
}

describe('Robinhood transfer retention transaction', () => {
  it('rejects an ineligible day or missing same-transaction action before acquiring a client', async () => {
    const gate = createRobinhoodWalletTransferRetentionTransaction({
      database: { getClient: async () => { throw new Error('unexpected connection'); } },
    });
    await assert.rejects(gate.withVerifiedPartition({ ...INPUT, day: '2026-09-21' },
      async () => {}), /three-day cutoff/);
    await assert.rejects(gate.withVerifiedPartition(INPUT), /same-transaction action/);
  });

  it('holds recovery, day, partition and position locks through the action', async () => {
    const f = fixture({ dependency: 'robinhood_wallet_endpoint_roles role' });
    const result = await f.gate.withVerifiedPartition(INPUT, async (client, candidate) => {
      assert.equal(candidate.day, DAY);
      assert.equal(candidate.partition, 'public.robinhood_token_transfer_events_2026_07_19');
      assert.equal(candidate.watermarkVersion, '0');
      assert.equal(client != null, true);
      assert.equal(f.calls.some((sql) => sql.startsWith('COMMIT')), false);
      return 'verified';
    });
    assert.equal(result, 'verified');
    assert.equal(f.released, true);
    assert.equal(f.calls.at(-1), 'COMMIT');
    const recovery = f.calls.indexOf('canonical recovery shared lock');
    const position = f.calls.findIndex((sql) => sql.includes('FOR UPDATE')
      && sql.includes('robinhood_wallet_position_cursors'));
    const dayLock = f.calls.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const partition = f.calls.findIndex((sql) => sql.includes('LOCK TABLE'));
    const watermark = f.calls.findIndex((sql) => sql.includes('FOR UPDATE OF watermark'));
    const evidence = f.calls.findIndex((sql) => sql.includes('pending_evidence evidence'));
    assert.ok(recovery < dayLock && dayLock < partition && partition < position
      && position < watermark && watermark < evidence);
  });

  it('rolls back on changed reconciliation or unpreserved evidence', async () => {
    for (const overrides of [
      { reconciliation: { mismatches: '1' } },
      { dependency: 'pending_evidence evidence' },
      { watermark: { version: '1' } },
    ]) {
      const f = fixture(overrides);
      await assert.rejects(f.gate.withVerifiedPartition(INPUT, async () => {
        throw new Error('action must not run');
      }), /reconcile|unpreservedUnknown|watermark or partition changed/);
      assert.equal(f.calls.at(-1), 'ROLLBACK');
      assert.equal(f.released, true);
    }
  });
});
