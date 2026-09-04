const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  INDEX_STATEMENTS, parseArgs, runPrepare,
} = require('../src/utils/prepare-robinhood-holder-journal-compaction');

function harness(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('to_regclass')) return { rows: [{ target: options.target || null }] };
      if (sql.includes('holder-compact:leases')) {
        return { rows: (options.activeLeases || []).map((lease_key) => ({ lease_key })) };
      }
      if (sql.includes('SELECT next_block')) {
        return { rowCount: 1, rows: [{ next_block: '100000', journal_floor_block: '1' }] };
      }
      if (sql.includes('INSERT INTO')) return { rowCount: 77 };
      if (sql.includes('invalid_old_rows')) {
        return { rows: [{
          copied_rows: '77', invalid_old_rows: options.invalidRows || '0',
          old_pending_rows: '11', old_recovery_rows: '13',
        }] };
      }
      if (sql.includes('FROM pg_index')) return { rows: [{ ready: INDEX_STATEMENTS.length }] };
      if (sql.includes('pg_total_relation_size')) return { rows: [{ total_bytes: '1234' }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, database: { getClient: async () => client } };
}

describe('Robinhood holder journal compaction prepare', () => {
  it('requires an explicit prepare write command and a safe disk floor', () => {
    assert.deepEqual(parseArgs(['--prepare', '--write']), { minFreeGiB: 60 });
    assert.deepEqual(parseArgs(['--prepare', '--write', '--min-free-gib=80']), {
      minFreeGiB: 80,
    });
    for (const args of [[], ['--prepare'], ['--prepare', '--write', '--min-free-gib=39']]) {
      assert.throws(() => parseArgs(args), /Use --prepare --write/);
    }
  });

  it('copies the exact protected set under locks and commits only after validation', async () => {
    const context = harness();
    const progress = [];
    const result = await runPrepare({ minFreeGiB: 60 }, {
      database: context.database, freeBytes: () => 100n * 1024n ** 3n,
      progress: (entry) => progress.push(entry),
    });

    assert.equal(result.status, 'prepared');
    assert.equal(result.cutoffBlock, '80000');
    assert.equal(result.copiedRows, '77');
    assert.equal(result.oldPendingRows, '11');
    assert.equal(result.oldRecoveryRows, '13');
    assert.equal(result.originalUntouched, true);
    const sql = context.calls.map((call) => call.sql);
    assert.equal(sql.some((text) => text.includes('DROP TABLE')), false);
    assert.equal(sql.some((text) => text.includes('ALTER TABLE robinhood_holder_transfer_journal ')),
      false);
    assert.equal(sql.indexOf('BEGIN') < sql.findIndex((text) => text.includes('LOCK TABLE')), true);
    assert.equal(sql.findIndex((text) => text.includes('invalid_old_rows'))
      < sql.indexOf('COMMIT'), true);
    const copySql = sql.find((text) => text.includes('INSERT INTO'));
    assert.match(copySql, /protected\.recovery_from_block IS NOT NULL/);
    assert.match(copySql, /journal\.block_number >= protected\.recovery_from_block/);
    assert.equal(progress.filter(({ phase }) => phase === 'index').length,
      INDEX_STATEMENTS.length);
  });

  it('fails before copying when a holder lease is active', async () => {
    const context = harness({ activeLeases: ['robinhood-holder-live-worker'] });
    await assert.rejects(runPrepare({ minFreeGiB: 60 }, {
      database: context.database, freeBytes: () => 100n * 1024n ** 3n,
    }), /active holder leases/);
    assert.equal(context.calls.some(({ sql }) => sql.includes('INSERT INTO')), false);
  });

  it('rolls back the entire prepare when validation diverges', async () => {
    const context = harness({ invalidRows: '1' });
    await assert.rejects(runPrepare({ minFreeGiB: 60 }, {
      database: context.database, freeBytes: () => 100n * 1024n ** 3n,
    }), /validation diverged/);
    assert.equal(context.calls.some(({ sql }) => sql === 'COMMIT'), false);
    assert.equal(context.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  });
});
