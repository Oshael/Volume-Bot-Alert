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
          return { rows: [{
            token_address: TOKEN, deployment_block: '123',
            backfill_next_block: '123', ledger_status: 'backfilling',
          }] };
        },
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
    assert.match(calls[0].sql, /cursor\.buffer_floor_block IS NOT NULL/);
    assert.match(calls[0].sql, /candidate\.attribution_block >= GREATEST\([\s\S]*journal_floor_block/);
    assert.match(calls[0].sql, /THEN 'shadow' ELSE 'backfilling' END/);
    assert.doesNotMatch(calls[0].sql, /UPDATE robinhood_holder_cursors/);
    assert.match(calls[0].sql, /state\.token_address IS NULL/);
    assert.match(calls[0].sql, /robinhood_holder_global_backfill_tokens cohort/);
    assert.doesNotMatch(calls[0].sql, /run\.barrier_block IS NOT NULL/);
    assert.match(calls[0].sql, /FOR UPDATE OF attribution SKIP LOCKED/);
    assert.match(calls[0].sql, /ON CONFLICT \(chain, token_address\) DO NOTHING/);
    assert.deepEqual(calls[0].params, [
      'robinhood', '2026-08-10T00:00:00.000Z', [...EXACT_DEPLOYMENT_SOURCES], 12, 20_000,
    ]);
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
