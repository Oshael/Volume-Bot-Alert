'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const db = require('../src/models/db');
const { auditRange, comparePage, parseArgs } = require(
  '../src/utils/audit-robinhood-chain-event-shadow');

it('compares identity and payload in both directions within a bounded page', async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE audit_source (
      chain text, block_number bigint, block_hash text, transaction_hash text,
      transaction_index integer, log_index integer, address text, topic0 text,
      topics jsonb, data text, captured_at timestamptz
    ) ON COMMIT DROP`);
    await client.query('CREATE TEMP TABLE audit_shadow (LIKE audit_source) ON COMMIT DROP');
    await client.query(`INSERT INTO audit_source VALUES
      ('robinhood', 100, 'block-a', 'tx-a', 0, 1, 'from-a', 'topic-a',
       '["topic-a"]', 'data-a', '2026-09-24T00:00:00Z')`);
    const names = { source: 'pg_temp.audit_source', shadow: 'pg_temp.audit_shadow' };
    let result = await comparePage(client, 100, 100, names);
    assert.equal(result.mismatch, 'count');
    await client.query('INSERT INTO audit_shadow SELECT * FROM audit_source');
    result = await comparePage(client, 100, 100, names);
    assert.equal(result.mismatch, null);
    await client.query("UPDATE audit_shadow SET data='wrong'");
    result = await comparePage(client, 100, 100, names);
    assert.equal(result.mismatch.block_hash, 'block-a');
    await client.query("UPDATE audit_shadow SET data='data-a'");
    await client.query("UPDATE audit_shadow SET block_hash='different'");
    result = await comparePage(client, 100, 100, names);
    assert.equal(result.mismatch.block_hash, 'block-a');
    await client.query("UPDATE audit_shadow SET block_hash='block-a'");
    await client.query(`INSERT INTO audit_shadow VALUES
      ('robinhood', 100, 'block-b', 'tx-b', 0, 2, 'from-b', 'topic-b',
       '["topic-b"]', 'data-b', '2026-09-24T00:00:00Z')`);
    result = await comparePage(client, 100, 100, names);
    assert.equal(result.mismatch, 'count');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await db.pool.end();
  }
});

it('stops on a mismatch and reports the exact restart block', async () => {
  const input = parseArgs(['--from-block=100', '--through-block=129',
    '--max-blocks=10', '--max-pages=3']);
  const checked = [];
  const result = await auditRange(input, {
    database: {},
    inspect: async (_database, fromBlock, pageEnd) => {
      checked.push([fromBlock, pageEnd]);
      return { sourceEvents: 5, shadowEvents: 5,
        mismatch: fromBlock === 110 ? { block_number: '115' } : null };
    },
  });
  assert.deepEqual(checked, [[100, 109], [110, 119]]);
  assert.equal(result.verified, false);
  assert.equal(result.nextBlock, 110);
  assert.equal(result.pages, 1);
  assert.equal(result.events, 5);
});

it('marks a page-limited run incomplete even when every checked page matches', async () => {
  const input = parseArgs(['--from-block=100', '--through-block=129',
    '--max-blocks=10', '--max-pages=2']);
  const result = await auditRange(input, {
    database: {},
    inspect: async () => ({ sourceEvents: 1, shadowEvents: 1, mismatch: null }),
  });
  assert.equal(result.verified, false);
  assert.equal(result.stopReason, 'page_limit');
  assert.equal(result.nextBlock, 120);
});

it('reduces a dense page and grows again after stable pages', async () => {
  const input = parseArgs(['--from-block=100', '--through-block=1000',
    '--max-blocks=100', '--max-pages=19']);
  const widths = [];
  const result = await auditRange(input, {
    database: {},
    inspect: async (_database, fromBlock, pageEnd) => {
      const width = pageEnd - fromBlock + 1;
      widths.push(width);
      if (fromBlock === 100 && width > 25) {
        const error = new Error('dense');
        error.code = 'shadow_audit_page_too_large';
        throw error;
      }
      return { sourceEvents: 1, shadowEvents: 1, mismatch: null };
    },
  });
  assert.deepEqual(widths.slice(0, 3), [100, 50, 25]);
  assert.equal(widths.at(-1), 50);
  assert.equal(result.nextBlock, 650);
});
