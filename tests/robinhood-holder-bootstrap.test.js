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
    }), { admittedAfter: '2026-08-10T00:00:00.000Z', limit: 25 });
    assert.throws(() => __private.normalizeOptions({ admittedAfter: 'invalid' }), /admittedAfter/);
    assert.throws(() => __private.normalizeOptions({
      admittedAfter: '2026-08-10T00:00:00.000Z', limit: 1001,
    }), /limit/);
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
    assert.match(calls[0].sql, /state\.token_address IS NULL/);
    assert.match(calls[0].sql, /FOR UPDATE OF attribution SKIP LOCKED/);
    assert.match(calls[0].sql, /ON CONFLICT \(chain, token_address\) DO NOTHING/);
    assert.deepEqual(calls[0].params, [
      'robinhood', '2026-08-10T00:00:00.000Z', [...EXACT_DEPLOYMENT_SOURCES], 12,
    ]);
  });
});
