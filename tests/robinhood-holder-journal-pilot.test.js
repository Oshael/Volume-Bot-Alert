const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseArgs } = require('../src/utils/pilot-robinhood-holder-journal');
const { validatePlan, measurement, runPilot } = require('../src/services/robinhood-holder-journal-pilot');

const document = (scan = {}) => ({ 'Execution Time': 10, Plan: {
  'Node Type': 'Hash Join', 'Actual Rows': 3, 'Shared Read Blocks': 9,
  Plans: [{ 'Node Type': 'Tid Range Scan', 'Relation Name': 'robinhood_holder_transfer_journal',
    'TID Cond': "((ctid >= '(0,0)'::tid) AND (ctid < '(128,0)'::tid))",
    'Actual Rows': 5, 'Shared Read Blocks': 4, ...scan }],
} });

test('pilot requires explicit database and bounds a single opt-in measured sample', () => {
  assert.equal(parseArgs(['--database=volume_alert']).measure, false);
  assert.equal(parseArgs(['--database=volume_alert', '--measure', '--pages=8192']).pages, 8192);
  for (const args of [[], ['--pages=8193'], ['--pages=0'], ['--pages=1.5'],
    ['--from-page=-1'], ['--timeout-ms=10001'], ['--pages=1', '--pages=2'], ['--write']]) {
    assert.throws(() => parseArgs(args.length ? ['--database=test', ...args] : args));
  }
});

test('plan guard rejects whole-table, unbounded and parallel access before measurement', () => {
  assert.equal(validatePlan(document())['Node Type'], 'Tid Range Scan');
  for (const scan of [{ 'Node Type': 'Seq Scan' }, { 'Node Type': 'Index Scan' },
    { 'TID Cond': '(ctid >= something)' }, { 'Parallel Aware': true }]) {
    assert.throws(() => validatePlan(document(scan)), /unsafe plan/);
  }
  const duplicate = document(); duplicate.Plan.Plans.push(duplicate.Plan.Plans[0]);
  assert.throws(() => validatePlan(duplicate), /unsafe plan/);
  assert.throws(() => validatePlan({}), /missing EXPLAIN/);
});

test('measurement separates journal buffers from inclusive query totals without double counting', () => {
  const result = measurement(document(), 100, 8192);
  assert.equal(result.selectedRowsPerSecond, 30);
  assert.equal(result.journalSharedReadBlocks, 4);
  assert.equal(result.totalSharedReadBlocks, 9);
  assert.equal(result.sharedReadBytes, 9 * 8192);
});

test('interrupt cancels only the owned backend and rolls back before releasing it', async () => {
  const controller = new AbortController(); const calls = [];
  const client = { release: () => calls.push('release'), async query(sql) {
    calls.push(sql);
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('SELECT pid')) return { rows: [{ pid: 123, backend_start: '2026-01-01', application_name: 'pilot' }] };
    if (sql.includes('SELECT current_database')) {
      controller.abort();
      throw Object.assign(new Error('query cancelled'), { code: '57014' });
    }
    return { rows: [] };
  } };
  const pool = { connect: async () => client, query: async (request) => {
    assert.match(request.text, /backend_start = \$2/);
    assert.deepEqual(request.values, [123, '2026-01-01', 'pilot']);
    calls.push('cancel'); return { rows: [{ cancelled: true }] };
  } };
  await assert.rejects(runPilot(pool, { database: 'test' }, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(calls.slice(-3), ['cancel', 'ROLLBACK', 'release']);
});

test('pre-aborted pilot never starts a scan', async () => {
  const calls = []; const controller = new AbortController(); controller.abort();
  const client = { query: async (sql) => calls.push(sql), release: () => {} };
  await assert.rejects(runPilot({ connect: async () => client }, { database: 'test' },
    { signal: controller.signal }), /interrupted/);
  assert.deepEqual(calls, ['ROLLBACK']);
});
