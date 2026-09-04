const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage116 = require('../src/utils/db-init-stage116');
const stage117 = require('../src/utils/db-init-stage117');
const stage118 = require('../src/utils/db-init-stage118');
const stage121 = require('../src/utils/db-init-stage121');
const stage141 = require('../src/utils/db-init-stage141');
const stage196 = require('../src/utils/db-init-stage196');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood holder shadow ledger schema', () => {
  it('creates positive-only uint256 balances and a top-holder index', () => {
    const sql = stage116.STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_balances/);
    assert.match(sql, /balance_raw NUMERIC\(78,0\) NOT NULL/);
    assert.match(sql, /CHECK \(balance_raw > 0\)/);
    assert.match(sql, /wallet_address <> '0x0{40}'/);
    assert.match(sql, /balance_raw DESC, wallet_address ASC/);
    assert.doesNotMatch(sql, /DOUBLE PRECISION|\bREAL\b/);
  });

  it('keeps totals and bootstrap progress shadowed per token', () => {
    const sql = stage116.STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_token_states/);
    assert.match(sql, /holder_count BIGINT NOT NULL DEFAULT 0/);
    assert.match(sql, /ledger_status IN \('pending', 'backfilling', 'shadow', 'live'/);
    assert.match(sql, /backfill_next_block BIGINT/);
    assert.match(sql, /\(live_through_block IS NULL\) = \(live_through_hash IS NULL\)/);
  });

  it('deduplicates events and retains the before/after state needed for rollback', () => {
    const sql = stage116.STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_cursors/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_transfer_journal/);
    assert.match(sql, /PRIMARY KEY \(chain, transaction_hash, log_index\)/);
    assert.match(sql, /from_balance_before NUMERIC\(78,0\)/);
    assert.match(sql, /to_balance_after NUMERIC\(78,0\)/);
    assert.match(sql, /applied = false[\s\S]+from_balance_before IS NULL/);
    assert.match(sql, /from_wallet <> '0x0{40}'[\s\S]+from_balance_before IS NOT NULL/);
    assert.match(sql, /WHERE applied = false/);
    assert.match(sql, /block_number DESC, log_index DESC/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
  });

  it('registers all four tables in runtime schema validation', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage116-robinhood-holder-shadow-ledger'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage116.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_holder_balances',
      'robinhood_holder_token_states',
      'robinhood_holder_cursors',
      'robinhood_holder_transfer_journal',
    ]);
    assert.deepEqual(group.tables[0].columnTypes.balance_raw, {
      dataType: 'numeric', numericPrecision: 78, numericScale: 0,
    });
  });

  it('adds reversible journal provenance without creating a history table', () => {
    const sql = stage117.STATEMENTS.join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS from_last_block_before BIGINT/);
    assert.match(sql, /from_last_transaction_hash_before VARCHAR\(66\)/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS to_last_block_before BIGINT/);
    assert.match(sql, /to_last_transaction_hash_before VARCHAR\(66\)/);
    assert.match(sql, /rh_holder_journal_from_provenance_check/);
    assert.match(sql, /rh_holder_journal_to_provenance_check/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage117-robinhood-holder-rollback-provenance'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage117.js');
    assert.equal(group.tables[0].columns.length, 6);
  });

  it('persists a fail-closed journal floor behind the live cursor', () => {
    const sql = stage118.STATEMENTS.join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS journal_floor_block BIGINT/);
    assert.match(sql, /journal_floor_block >= 0/);
    assert.match(sql, /journal_floor_block <= next_block/);
    assert.doesNotMatch(sql, /DEFAULT|NOT NULL/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage118-robinhood-holder-journal-floor'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage118.js');
    assert.deepEqual(group.tables[0].columnTypes.journal_floor_block, {
      dataType: 'bigint',
    });
  });

  it('indexes pending holder events by token without blocking journal writes', () => {
    const sql = stage121.STATEMENTS.join('\n');
    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    assert.match(sql, /idx_rh_holder_journal_pending_token/);
    assert.match(sql, /chain, token_address, block_number ASC/);
    assert.match(sql, /transaction_index ASC, log_index ASC/);
    assert.match(sql, /WHERE applied = false/);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage121-robinhood-holder-pending-token-index'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage121.js');
    assert.equal(group.tables[0].indexes[0].name, 'idx_rh_holder_journal_pending_token');
  });

  it('replaces the full rollback B-tree only after a BRIN index is ready', async () => {
    assert.match(stage196.CREATE_STATEMENT, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    assert.match(stage196.CREATE_STATEMENT, /USING BRIN \(block_number\)/);
    assert.match(stage196.CREATE_STATEMENT, /autosummarize = on/);
    assert.match(stage196.DROP_STATEMENT,
      /DROP INDEX CONCURRENTLY IF EXISTS idx_robinhood_holder_journal_rollback/);
    const calls = [];
    const database = { query: async (sql) => {
      calls.push(sql);
      if (sql.includes('SELECT indisvalid')) {
        return { rows: calls.length === 1
          ? [] : [{ indisvalid: true, indisready: true }] };
      }
      return { rows: [] };
    } };

    await stage196.init({ database, closePool: false });

    assert.equal(calls.indexOf(stage196.CREATE_STATEMENT)
      < calls.indexOf(stage196.DROP_STATEMENT), true);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage196-robinhood-holder-rollback-brin'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage196.js');
    assert.equal(group.tables[0].indexes[0].name, stage196.BRIN_INDEX);
    const original = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage116-robinhood-holder-shadow-ledger'
    ));
    const journal = original.tables.find(({ table }) => (
      table === 'robinhood_holder_transfer_journal'
    ));
    assert.equal(journal.indexes.some(({ name }) => name === stage196.LEGACY_INDEX), false);
  });

  it('preserves the rollback B-tree when the BRIN replacement is not ready', async () => {
    let readinessChecks = 0;
    const calls = [];
    const database = { query: async (sql) => {
      calls.push(sql);
      if (!sql.includes('SELECT indisvalid')) return { rows: [] };
      readinessChecks += 1;
      return { rows: readinessChecks === 1
        ? [] : [{ indisvalid: false, indisready: false }] };
    } };

    await assert.rejects(
      stage196.init({ database, closePool: false }),
      /legacy index was preserved/
    );

    assert.equal(calls.includes(stage196.DROP_STATEMENT), false);
  });

  it('persists the proven floor of complete Transfer buffering', () => {
    const sql = stage141.STATEMENTS.join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS buffer_floor_block BIGINT/);
    assert.match(sql, /buffer_floor_block >= 0/);
    assert.match(sql, /buffer_floor_block <= next_block/);
    assert.doesNotMatch(sql, /DEFAULT|NOT NULL/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage141-robinhood-holder-transfer-buffer-floor'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage141.js');
    assert.deepEqual(group.tables[0].columnTypes.buffer_floor_block, {
      dataType: 'bigint',
    });
  });
});
