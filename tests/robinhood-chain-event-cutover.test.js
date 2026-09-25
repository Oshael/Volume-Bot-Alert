'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  parseArgs, readAuditReport, swap,
} = require('../src/utils/cutover-robinhood-chain-events');

function cutoverClient(input = {}) {
  const commands = [];
  let renamed = 0;
  const client = { query: async (sql) => {
    commands.push(sql);
    if (sql.includes('active.oid::text AS active_oid')) {
      return { rows: [renamed < 2 ? {
        active_oid: '101', active_kind: 'r', shadow_oid: '202', shadow_kind: 'p',
        retired_oid: null, retired_kind: null,
      } : {
        active_oid: '202', active_kind: 'p', shadow_oid: null, shadow_kind: null,
        retired_oid: '101', retired_kind: 'r',
      }] };
    }
    if (sql.includes("FROM pg_constraint WHERE contype='f'")) {
      return { rows: [
        { child: 'robinhood_chain_domain_outbox', conname: 'rh_chain_domain_outbox_event_fkey',
          parent_oid: '202', convalidated: true },
        { child: 'robinhood_canonical_head_candidates',
          conname: 'rh_canonical_head_candidates_event_fkey',
          parent_oid: '202', convalidated: true },
        ...(input.legacyFk ? [{ child: 'other', conname: 'other_fkey',
          parent_oid: '101', convalidated: true }] : []),
      ] };
    }
    if (sql.includes('has_dependent_view')) return { rows: [{ has_dependent_view: false }] };
    if (sql.includes('FROM pg_inherits')) return { rows: [{ ready: true }] };
    if (sql.includes('cursor.next_block::text')) return { rows: [{
      next_block: '123', checkpoint_block: '122', finalized_head: '120',
      recovery_state: 'running', capture_active: input.activeLease === true,
    }] };
    if (sql.includes('min(block_number)::text')) return { rows: [{ block: '100' }] };
    if (sql.includes('pg_total_relation_size')) return { rows: [{ bytes: '1000' }] };
    if (sql.includes('AS differs')) return { rows: [{ differs: input.tailDiffers === true }] };
    if (sql.startsWith('LOCK TABLE')) return { rows: [] };
    if (sql.startsWith('ALTER TABLE')) { renamed += 1; return { rows: [] }; }
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  return { client, commands };
}

test('cutover requires a stopped capture, migrated FKs and equal event tail', async () => {
  const ready = cutoverClient();
  const result = await swap(ready.client, 123);
  assert.equal(result.phase, 'swapped');
  assert.equal(result.retiredOid, '101');
  assert.equal(result.activeOid, '202');
  assert.equal(result.shadowOid, null);
  assert.equal(result.checkedFromBlock, '100');
  assert.equal(ready.commands.filter((sql) => sql.startsWith('ALTER TABLE')).length, 2);
  for (const scenario of [
    { activeLease: true, message: /stop capture/ },
    { legacyFk: true, message: /referencing foreign keys/ },
    { tailDiffers: true, message: /tail differs/ },
  ]) {
    const context = cutoverClient(scenario);
    await assert.rejects(swap(context.client, 123), scenario.message);
    assert.equal(context.commands.some((sql) => sql.startsWith('ALTER TABLE')), false);
  }
  const stale = cutoverClient();
  await assert.rejects(swap(stale.client, 124), /current next_block/);
});

test('retired drop accepts only a complete parity report for the correct relations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-event-audit-'));
  const reportPath = path.join(directory, 'audit.jsonl');
  try {
    const report = { phase: 'summary', mode: 'read-only', verified: true,
      stopReason: 'complete', nextBlock: null, pages: 2, events: 50,
      fromBlock: 100, throughBlock: 122,
      source: 'public.robinhood_chain_events_retired',
      shadow: 'public.robinhood_chain_events' };
    fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
    assert.equal(readAuditReport(reportPath).throughBlock, 122);
    fs.writeFileSync(reportPath, `${JSON.stringify({ ...report, verified: false })}\n`);
    assert.throws(() => readAuditReport(reportPath), /does not prove/);
    assert.deepEqual(parseArgs(['--apply', '--expected-next-block=123']),
      { action: 'apply', expectedNextBlock: 123 });
    assert.throws(() => parseArgs(['--apply']), /requires/);
  } finally {
    fs.unlinkSync(reportPath);
    fs.rmdirSync(directory);
  }
});
