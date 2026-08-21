process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage144 = require('../src/utils/db-init-stage144');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'6'.repeat(40)}`;
const HASH = `0x${'7'.repeat(64)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_holder_distribution_metrics WHERE token_address = $1', [TOKEN]
  );
}

function insertMetric(overrides = {}) {
  const input = {
    metric: 'dev_hold', status: 'ready', statusReason: 'materialized',
    numerator: '25', denominator: '100', walletCount: '1', groupCount: null,
    evidence: { source: 'holder_ledger' }, blockNumber: '100', blockHash: HASH,
    ...overrides,
  };
  return db.query(
    `INSERT INTO robinhood_holder_distribution_metrics (
       chain, token_address, metric, classification_version, status, status_reason,
       value_numerator_raw, value_denominator_raw, wallet_count, group_count,
       evidence_json, through_block_number, through_block_hash, observed_at
     ) VALUES ('robinhood', $1, $2, 'rh_holder_v1', $3, $4, $5, $6, $7, $8,
       $9::jsonb, $10, $11, '2026-08-21T12:00:00Z')`,
    [
      TOKEN, input.metric, input.status, input.statusReason, input.numerator,
      input.denominator, input.walletCount, input.groupCount,
      JSON.stringify(input.evidence), input.blockNumber, input.blockHash,
    ]
  );
}

describe('Robinhood holder distribution metrics schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage144.init({ closePool: false });
    await stage144.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('stores exact DEV HOLD ratios and count-only bundled snapshots', async () => {
    await insertMetric();
    await insertMetric({
      metric: 'bundled', numerator: null, denominator: null,
      walletCount: '4', groupCount: '2',
    });
    await insertMetric({
      metric: 'lp_locked', status: 'unavailable', statusReason: 'source_unavailable',
      numerator: null, denominator: null, walletCount: null, groupCount: null,
      evidence: { reason: 'unsupported_locker' }, blockNumber: null, blockHash: null,
    });
    const result = await db.query(
      `SELECT metric, value_numerator_raw::text, value_denominator_raw::text,
              wallet_count::text, group_count::text, status
         FROM robinhood_holder_distribution_metrics
        WHERE token_address = $1 ORDER BY metric`,
      [TOKEN]
    );

    assert.deepEqual(result.rows, [{
      metric: 'bundled', value_numerator_raw: null, value_denominator_raw: null,
      wallet_count: '4', group_count: '2', status: 'ready',
    }, {
      metric: 'dev_hold', value_numerator_raw: '25', value_denominator_raw: '100',
      wallet_count: '1', group_count: null, status: 'ready',
    }, {
      metric: 'lp_locked', value_numerator_raw: null, value_denominator_raw: null,
      wallet_count: null, group_count: null, status: 'unavailable',
    }]);
  });

  it('rejects invented values and incoherent status/frontier payloads', async () => {
    await cleanup();
    await assert.rejects(
      insertMetric({ numerator: '101' }), /rh_holder_distribution_metrics_values_check/
    );
    await assert.rejects(
      insertMetric({ status: 'unavailable', blockNumber: null, blockHash: null }),
      /rh_holder_distribution_metrics_payload_check/
    );
    await assert.rejects(
      insertMetric({ blockNumber: null, blockHash: null }),
      /rh_holder_distribution_metrics_status_frontier_check/
    );
    await assert.rejects(
      insertMetric({ evidence: {} }), /rh_holder_distribution_metrics_evidence_check/
    );
    await assert.rejects(
      insertMetric({ metric: 'bundled', numerator: null, denominator: null }),
      /rh_holder_distribution_metrics_payload_check/
    );
  });
});
