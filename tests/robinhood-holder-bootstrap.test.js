const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  EXACT_DEPLOYMENT_SOURCES,
  createRobinhoodHolderBootstrapRepository,
  __private,
} = require('../src/models/robinhood-holder-bootstrap');

const TOKEN = `0x${'a'.repeat(40)}`;

describe('Robinhood holder bootstrap repository', () => {
  it('requires a durable admission cutoff and bounded batch', () => {
    assert.deepEqual(__private.normalizeOptions({
      admittedAfter: '2026-08-10T00:00:00.000Z', limit: 25,
    }), {
      admittedAfter: '2026-08-10T00:00:00.000Z', limit: 25,
      maxInitialGapBlocks: 20_000,
    });
    assert.throws(() => __private.normalizeOptions({ admittedAfter: 'invalid' }), /admittedAfter/);
    assert.throws(() => __private.normalizeOptions({
      admittedAfter: '2026-08-10T00:00:00.000Z', limit: 1001,
    }), /limit/);
    assert.deepEqual(__private.normalizeColdOptions({
      admittedBefore: '2026-08-10T00:00:00.000Z', limit: 10,
    }), { admittedBefore: '2026-08-10T00:00:00.000Z', limit: 10 });
    assert.throws(() => __private.normalizeColdOptions({ admittedBefore: 'invalid' }), /admittedBefore/);
  });

  it('seeds only catalog tokens with exact on-chain deployment provenance', async () => {
    const calls = [];
    const repository = createRobinhoodHolderBootstrapRepository({
      database: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [{ token_address: TOKEN }] };
        },
        getClient: async () => ({
          query: async (sql, params) => {
            calls.push({ sql, params });
            if (!sql.includes('INSERT INTO robinhood_holder_token_states')) {
              return { rows: sql.includes('SKIP LOCKED') ? [{}] : [] };
            }
            return { rows: [{
              token_address: TOKEN, deployment_block: '123',
              backfill_next_block: '123', ledger_status: 'backfilling',
            }] };
          },
          release() {},
        }),
      },
    });
    assert.deepEqual(await repository.seedNewTokens({
      admittedAfter: '2026-08-10T00:00:00.000Z', limit: 12,
    }), [{
      tokenAddress: TOKEN, deploymentBlock: '123',
      backfillNextBlock: '123', ledgerStatus: 'backfilling',
    }]);
    assert.match(calls[0].sql, /catalog\.first_seen_at >= \$2::timestamptz/);
    assert.match(calls[0].sql, /attribution\.source = ANY\(\$3::varchar\[\]\)/);
    assert.match(calls[0].sql, /attribution\.attribution_block IS NOT NULL/);
    assert.match(calls[0].sql, /cursor\.safe_head - \$5::bigint/);
    assert.doesNotMatch(calls[0].sql, /FOR UPDATE|INSERT INTO/);
    const admission = calls.find(({ sql }) => sql.includes('INSERT INTO robinhood_holder_token_states'));
    assert.match(admission.sql, /catalog\.address = ANY\(\$6::varchar\[\]\)/);
    assert.deepEqual(admission.params.at(-1), [TOKEN]);
    assert.match(admission.sql, /cursor\.buffer_floor_block IS NOT NULL/);
    assert.match(admission.sql, /candidate\.attribution_block >= GREATEST\([\s\S]*journal_floor_block/);
    assert.match(admission.sql, /THEN 'shadow' ELSE 'backfilling' END/);
    assert.doesNotMatch(calls[0].sql, /UPDATE robinhood_holder_cursors/);
    assert.match(calls[0].sql, /state\.token_address IS NULL/);
    assert.match(calls[0].sql, /robinhood_holder_global_backfill_tokens cohort/);
    assert.doesNotMatch(calls[0].sql, /run\.barrier_block IS NOT NULL/);
    assert.match(admission.sql, /FOR UPDATE OF attribution SKIP LOCKED/);
    assert.match(admission.sql, /ON CONFLICT \(chain, token_address\) DO NOTHING/);
    assert.deepEqual(calls[0].params, [
      'robinhood', '2026-08-10T00:00:00.000Z', [...EXACT_DEPLOYMENT_SOURCES], 12, 20_000,
    ]);
  });

  it('does not acquire a writer connection when discovery is empty', async () => {
    const repository = createRobinhoodHolderBootstrapRepository({ database: {
      query: async () => ({ rows: [] }),
      getClient: async () => assert.fail('empty discovery must not lock the cursor'),
    } });
    assert.deepEqual(await repository.seedNewTokens({ admittedAfter: '2026-08-10' }), []);
  });

  it('defers a busy cursor and rolls back a failed admission', async () => {
    for (const busy of [true, false]) {
      const calls = [];
      let released = false;
      const repository = createRobinhoodHolderBootstrapRepository({ database: {
        query: async () => ({ rows: [{ token_address: TOKEN }] }),
        getClient: async () => ({
          async query(sql) {
            calls.push(sql);
            if (sql.includes('INSERT INTO robinhood_holder_token_states')) throw new Error('write failed');
            return { rows: busy ? [] : [{}] };
          },
          release() { released = true; },
        }),
      } });
      const result = repository.seedNewTokens({ admittedAfter: '2026-08-10' });
      if (busy) {
        assert.deepEqual(await result, []);
        assert.ok(!calls.some((sql) => sql.includes('INSERT INTO')));
        assert.equal(calls.at(-1), 'COMMIT');
      } else {
        await assert.rejects(result, /write failed/);
        assert.equal(calls.at(-1), 'ROLLBACK');
      }
      assert.match(calls[1], /FOR UPDATE SKIP LOCKED/);
      assert.ok(released);
    }
  });

  it('admits an old cohort only from exact deployment evidence', async () => {
    const calls = [];
    const repository = createRobinhoodHolderBootstrapRepository({
      database: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [{
            token_address: TOKEN, deployment_block: '99',
            backfill_next_block: '99', ledger_status: 'backfilling',
          }] };
        },
      },
    });
    assert.deepEqual(await repository.seedColdTokens({
      admittedBefore: '2026-08-10T00:00:00.000Z', limit: 5,
    }), [{
      tokenAddress: TOKEN, deploymentBlock: '99',
      backfillNextBlock: '99', ledgerStatus: 'backfilling',
    }]);
    assert.match(calls[0].sql, /catalog\.first_seen_at < \$2::timestamptz/);
    assert.match(calls[0].sql, /attribution\.source = ANY\(\$3::varchar\[\]\)/);
    assert.match(calls[0].sql, /attribution\.attribution_block IS NOT NULL/);
    assert.match(calls[0].sql, /ORDER BY catalog\.first_seen_at DESC, catalog\.address/);
    assert.match(calls[0].sql, /state\.token_address IS NULL/);
    assert.match(calls[0].sql, /robinhood_holder_global_backfill_tokens cohort/);
    assert.match(calls[0].sql, /cohort\.status = 'active'/);
    assert.deepEqual(calls[0].params, [
      'robinhood', '2026-08-10T00:00:00.000Z', [...EXACT_DEPLOYMENT_SOURCES], 5,
    ]);
  });
});
