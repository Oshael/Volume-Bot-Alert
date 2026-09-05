const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  INDEX_STATEMENTS, buildPreparedMarker, createInterruptController, parseArgs,
  parsePreparedMarker, runPrepare,
} = require('../src/utils/prepare-robinhood-holder-journal-compaction');
const {
  auditCompaction, parseArgs: parseFinalizeArgs, runFinalize,
} = require('../src/utils/finalize-robinhood-holder-journal-compaction');

function harness(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('to_regclass')) return { rows: [{ target: options.target || null }] };
      if (sql.includes('holder-compact:leases')) {
        return { rows: (options.activeLeases || [])
          .filter((lease_key) => lease_key !== params[1])
          .map((lease_key) => ({ lease_key })) };
      }
      if (sql.includes('SELECT next_block')) {
        return { rowCount: 1, rows: [{ next_block: '100000', journal_floor_block: '1' }] };
      }
      if (sql.includes('INSERT INTO')) return { rowCount: 77 };
      if (sql.includes('invalid_old_rows')) {
        return { rows: [{
          copied_rows: '77', invalid_old_rows: options.invalidRows || '0',
          old_pending_rows: '11',
        }] };
      }
      if (sql.includes('FROM pg_index')) return { rows: [{ ready: INDEX_STATEMENTS.length }] };
      if (sql.includes('pg_total_relation_size')) return { rows: [{ total_bytes: '1234' }] };
      if (sql.includes('clock_timestamp()')) {
        return { rows: [{ prepared_at: '2026-09-05T20:00:00.000Z' }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, database: { getClient: async () => client } };
}

describe('Robinhood holder journal compaction prepare', () => {
  it('requires an explicit prepare write command and a safe disk floor', () => {
    const acknowledgement = '--allow-archive-recovery';
    assert.deepEqual(parseArgs(['--prepare', '--write', acknowledgement]), {
      minFreeGiB: 60, archiveRecoveryAcknowledged: true,
    });
    assert.deepEqual(parseArgs([
      '--prepare', '--write', acknowledgement, '--min-free-gib=80',
    ]), { minFreeGiB: 80, archiveRecoveryAcknowledged: true });
    for (const args of [
      [], ['--prepare'], ['--prepare', '--write'],
      ['--prepare', '--write', acknowledgement, '--min-free-gib=39'],
    ]) {
      assert.throws(() => parseArgs(args), /allow-archive-recovery/);
    }
  });

  it('copies the exact protected set under locks and commits only after validation', async () => {
    const context = harness();
    const progress = [];
    const result = await runPrepare({
      minFreeGiB: 60, archiveRecoveryAcknowledged: true,
    }, {
      database: context.database, freeBytes: () => 100n * 1024n ** 3n,
      progress: (entry) => progress.push(entry),
    });

    assert.equal(result.status, 'prepared');
    assert.equal(result.cutoffBlock, '80000');
    assert.equal(result.journalFloorBlock, '1');
    assert.equal(result.copiedRows, '77');
    assert.equal(result.oldPendingRows, '11');
    assert.equal(result.recoveryBeforeCutoff, 'archive-required');
    assert.equal(result.originalUntouched, true);
    const sql = context.calls.map((call) => call.sql);
    assert.equal(sql.some((text) => text.includes('DROP TABLE')), false);
    assert.equal(sql.some((text) => text.includes('ALTER TABLE robinhood_holder_transfer_journal ')),
      false);
    assert.equal(sql.indexOf('BEGIN') < sql.findIndex((text) => text.includes('LOCK TABLE')), true);
    assert.equal(sql.findIndex((text) => text.includes('invalid_old_rows'))
      < sql.indexOf('COMMIT'), true);
    const copySql = sql.find((text) => text.includes('INSERT INTO'));
    assert.match(copySql, /LEFT JOIN protected_tokens/);
    assert.match(copySql, /journal\.applied = false/);
    assert.doesNotMatch(copySql, /UNION ALL/);
    assert.equal(sql.includes('SET LOCAL enable_mergejoin = off'), true);
    assert.equal(sql.includes('SET LOCAL enable_nestloop = off'), true);
    assert.equal(sql.includes('SET LOCAL enable_indexscan = off'), true);
    assert.equal(sql.includes('SET LOCAL enable_bitmapscan = off'), true);
    assert.equal(progress.filter(({ phase }) => phase === 'index').length,
      INDEX_STATEMENTS.length);
  });

  it('persists a strict marker with the protected snapshot boundaries', () => {
    const input = {
      cutoffBlock: '80000', nextBlock: '100000', journalFloorBlock: '1',
      copiedRows: '77', oldPendingRows: '11', preparedAt: '2026-09-05T20:00:00.000Z',
    };
    assert.deepEqual(parsePreparedMarker(buildPreparedMarker(input)), input);
    assert.equal(parsePreparedMarker('holder-journal-compact:v3;cutoff=80000'), null);
  });

  it('fails before copying when a holder lease is active', async () => {
    const context = harness({ activeLeases: ['robinhood-holder-live-worker'] });
    await assert.rejects(runPrepare({
      minFreeGiB: 60, archiveRecoveryAcknowledged: true,
    }, {
      database: context.database, freeBytes: () => 100n * 1024n ** 3n,
    }), /active holder leases/);
    assert.equal(context.calls.some(({ sql }) => sql.includes('INSERT INTO')), false);
  });

  it('allows the read-only holder summary lease to remain active', async () => {
    const context = harness({ activeLeases: ['robinhood-holder-summary-worker'] });
    const result = await runPrepare({
      minFreeGiB: 60, archiveRecoveryAcknowledged: true,
    }, {
      database: context.database, freeBytes: () => 100n * 1024n ** 3n,
    });
    assert.equal(result.status, 'prepared');
  });

  it('rolls back the entire prepare when validation diverges', async () => {
    const context = harness({ invalidRows: '1' });
    await assert.rejects(runPrepare({
      minFreeGiB: 60, archiveRecoveryAcknowledged: true,
    }, {
      database: context.database, freeBytes: () => 100n * 1024n ** 3n,
    }), /validation diverged/);
    assert.equal(context.calls.some(({ sql }) => sql === 'COMMIT'), false);
    assert.equal(context.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  });

  it('refuses programmatic prepare without archive recovery acknowledgement', async () => {
    const context = harness();
    await assert.rejects(runPrepare({ minFreeGiB: 60 }, {
      database: context.database, freeBytes: () => 100n * 1024n ** 3n,
    }), (error) => error.code === 'holder_journal_compaction_archive_recovery_required');
    assert.equal(context.calls.length, 0);
  });

  it('cancels the tracked PostgreSQL query when interrupted', async () => {
    const calls = [];
    const progress = [];
    const controller = createInterruptController({
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ cancelled: true }] };
      },
    }, (entry) => progress.push(entry));
    controller.setBackendPid(1234);
    controller.request('SIGINT');

    assert.equal(await controller.wait(), true);
    assert.deepEqual(calls[0].params, [1234]);
    assert.match(calls[0].sql, /pg_cancel_backend/);
    assert.deepEqual(progress.map(({ status }) => status), ['requested', 'cancelled']);
  });

  it('exports with one sequential scan and a hash join for protected tokens', () => {
    const sql = fs.readFileSync(path.join(
      __dirname, '../src/utils/export-robinhood-holder-journal-compaction.sql'
    ), 'utf8');
    assert.match(sql, /SET enable_mergejoin = off/);
    assert.match(sql, /SET enable_nestloop = off/);
    assert.match(sql, /SET enable_indexscan = off/);
    assert.match(sql, /SET enable_bitmapscan = off/);
    assert.match(sql, /LEFT JOIN protected_tokens/);
    assert.match(sql, /journal\.applied = false/);
    assert.match(sql, /TO STDOUT/);
    assert.doesNotMatch(sql, /UNION ALL/);
    assert.doesNotMatch(sql, /ORDER BY/);
  });
});

function finalizeHarness(options = {}) {
  const marker = buildPreparedMarker({
    cutoffBlock: '80000', nextBlock: '100000', journalFloorBlock: '1',
    copiedRows: '77', oldPendingRows: '11', preparedAt: '2026-09-05T20:00:00.000Z',
  });
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('obj_description')) return { rows: options.missingRelations ? [] : [{
        owner_match: options.ownerMismatch !== true,
        acl_match: true,
        marker: options.marker || marker,
        source_bytes: '1000', target_bytes: '100',
      }] };
      if (sql.includes('FROM worker_leases')) {
        const touched = sql.includes('heartbeat_at >=');
        const leases = touched ? (options.touchedLeases || []) : (options.activeLeases || []);
        return { rows: leases.map((lease_key) => ({ lease_key })) };
      }
      if (sql.includes('SELECT next_block')) return { rows: [{
        next_block: options.nextBlock || '100000', journal_floor_block: '1',
      }] };
      if (sql.includes('invalid_old_rows')) return { rows: [{
        copied_rows: options.copiedRows || '77', invalid_old_rows: '0', old_pending_rows: '11',
      }] };
      if (sql.includes('FROM pg_index')) return { rows: [{ ready: INDEX_STATEMENTS.length }] };
      if (sql.includes("to_regprocedure('enqueue_robinhood_holder_hot()')")) {
        return { rows: [{ ready: true }] };
      }
      if (sql.includes('UPDATE robinhood_holder_cursors')) {
        return { rowCount: 1, rows: [{ journal_floor_block: '80000' }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, client, database: { getClient: async () => client } };
}

describe('Robinhood holder journal compaction finalize', () => {
  it('keeps audit read-only and reports the physical reclaim estimate', async () => {
    const context = finalizeHarness();
    const result = await auditCompaction(context.client);

    assert.equal(result.ready, true);
    assert.equal(result.storage.reclaimable_bytes, '900');
    assert.equal(context.calls.some(({ sql }) => /^(DROP|ALTER|UPDATE)/.test(sql)), false);
    assert.deepEqual(context.calls.filter(({ sql }) => sql.includes('FROM worker_leases'))
      .map(({ params }) => params.length), [2, 3]);
  });

  it('blocks when a holder ran after prepare or the cursor advanced', async () => {
    const context = finalizeHarness({
      touchedLeases: ['robinhood-holder-live-worker'], nextBlock: '100001',
    });
    const result = await auditCompaction(context.client);

    assert.equal(result.ready, false);
    assert.deepEqual(result.blockers.map(({ code }) => code), [
      'holder_cursor_advanced', 'holder_workers_ran_after_prepare',
    ]);
  });

  it('requires four explicit finalize acknowledgements', () => {
    assert.deepEqual(parseFinalizeArgs(['--audit']), { mode: 'audit' });
    assert.equal(parseFinalizeArgs([
      '--finalize', '--write', '--drop-original', '--allow-archive-recovery',
    ]).mode, 'finalize');
    assert.throws(() => parseFinalizeArgs(['--finalize', '--write']), /drop-original/);
  });

  it('rechecks under locks and swaps only inside the committing transaction', async () => {
    const context = finalizeHarness();
    const result = await runFinalize(context.database, { archiveRecoveryAcknowledged: true });
    const sql = context.calls.map((entry) => entry.sql);

    assert.equal(result.status, 'completed');
    assert.equal(result.cutoffBlock, '80000');
    assert.equal(sql.filter((text) => text.includes('obj_description')).length, 2);
    assert.ok(sql.indexOf('BEGIN') < sql.findIndex((text) => text.startsWith('LOCK TABLE')));
    assert.ok(sql.findIndex((text) => text.includes('UPDATE robinhood_holder_cursors'))
      < sql.findIndex((text) => text.startsWith('ALTER TABLE robinhood_holder_transfer_journal ')));
    const drop = sql.find((text) => text.startsWith('DROP TABLE'));
    assert.equal(drop, 'DROP TABLE robinhood_holder_transfer_journal_retired');
    assert.doesNotMatch(drop, /CASCADE/);
    assert.ok(sql.includes('COMMIT'));
  });

  it('does not begin a finalize when the audit is blocked', async () => {
    const context = finalizeHarness({ activeLeases: ['robinhood-holder-live-worker'] });
    await assert.rejects(runFinalize(context.database, {
      archiveRecoveryAcknowledged: true,
    }), (error) => error.code === 'holder_journal_compaction_not_ready');
    assert.equal(context.calls.some(({ sql }) => sql === 'BEGIN'), false);
  });
});
