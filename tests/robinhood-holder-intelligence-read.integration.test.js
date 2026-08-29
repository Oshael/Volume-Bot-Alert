process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderIntelligenceReadRepository,
} = require('../src/models/robinhood-holder-intelligence-read');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const HIGH_WALLET = `0x${'2'.repeat(40)}`;
const LEGACY_WALLET = `0x${'3'.repeat(40)}`;
const INSIDER_WALLET = `0x${'6'.repeat(40)}`;
const HASH = `0x${'4'.repeat(64)}`;
const TX = `0x${'5'.repeat(64)}`;

after(() => db.pool.end());

describe('Robinhood public holder intelligence read integration', () => {
  it('derives public live ratios and rejects non-public evidence', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of [
        'robinhood_holder_classification_states',
        'robinhood_holder_classifications',
        'robinhood_holder_distribution_metrics',
        'robinhood_holder_balances',
      ]) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      }
      await client.query(`CREATE TEMP TABLE robinhood_market_observations (
        chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
        status varchar(16) NOT NULL, token_total_supply_raw numeric(78, 0),
        observed_at timestamptz NOT NULL
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_possible_bundle_states (
        chain varchar(16), token_address varchar(42), rule_version varchar(64),
        status varchar(16), through_block_number bigint, through_block_hash varchar(66),
        observed_at timestamptz
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_possible_bundle_members (
        chain varchar(16), token_address varchar(42), rule_version varchar(64),
        bundle_id varchar(66), wallet_address varchar(42)
      )`);
      await client.query(
        `INSERT INTO robinhood_holder_classification_states (
           token_address, classifier, classification_version, status, status_reason,
           through_block_number, through_block_hash, observed_at
         ) VALUES
           ($1, 'sniper', 'rh_holder_v1', 'ready', 'materialized',
            100, $2, '2026-08-24T01:00:00Z'),
           ($1, 'insider', 'rh_holder_v1', 'ready', 'materialized',
            100, $2, '2026-08-24T01:00:00Z')`,
        [TOKEN, HASH]
      );
      await client.query(
        `INSERT INTO robinhood_holder_classifications (
           token_address, wallet_address, tag, classification_version, confidence,
           reason_code, evidence_json, through_block_number, through_block_hash, observed_at
         ) VALUES
           ($1, $2, 'sniper', 'rh_holder_v1', 'high', 'early_launch_buy',
            $4::jsonb, 100, $5, '2026-08-24T01:00:00Z'),
           ($1, $3, 'sniper', 'rh_holder_v1', 'heuristic', 'early_launch_buy',
            $6::jsonb, 100, $5, '2026-08-24T01:00:00Z'),
           ($1, $7, 'insider', 'rh_holder_v1', 'high', 'creator_token_distribution',
            $8::jsonb, 100, $5, '2026-08-24T01:00:00Z')`,
        [
          TOKEN, HIGH_WALLET, LEGACY_WALLET,
          JSON.stringify({ rule: { evidenceVersion: 'rh_sniper_high_v2' } }), HASH,
          JSON.stringify({ rule: { evidenceVersion: 'rh_sniper_high_v1' } }),
          INSIDER_WALLET, JSON.stringify({ rule: { evidenceVersion: 'rh_insider_direct_v1' } }),
        ]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES
           ($1, $2, 25, 100, $5, 1), ($1, $3, 75, 100, $5, 2),
           ($1, $4, 15, 100, $5, 3)`,
        [TOKEN, HIGH_WALLET, LEGACY_WALLET, INSIDER_WALLET, TX]
      );
      await client.query(
        `INSERT INTO robinhood_market_observations VALUES
           ('robinhood', $1, 'accepted', 90, '2026-08-24T00:00:00Z'),
           ('robinhood', $1, 'accepted', 100, '2026-08-24T01:00:00Z')`,
        [TOKEN]
      );
      await client.query(
        `INSERT INTO robinhood_holder_distribution_metrics (
           token_address, metric, classification_version, status, status_reason,
           value_numerator_raw, value_denominator_raw, wallet_count, evidence_json,
           through_block_number, through_block_hash, observed_at
         ) VALUES ($1, 'snipers', 'rh_holder_v1', 'ready', 'materialized',
           90, 100, 1, $2::jsonb, 100, $3, '2026-08-24T01:00:00Z')`,
        [
          TOKEN, JSON.stringify({ rule: { evidenceVersion: 'rh_sniper_high_v1' } }), HASH,
        ]
      );

      let queryTail = Promise.resolve();
      const database = { query: (...args) => {
        const result = queryTail.then(() => client.query(...args));
        queryTail = result.then(() => undefined, () => undefined);
        return result;
      } };
      const repository = createRobinhoodHolderIntelligenceReadRepository({ database });
      const result = await repository.loadPage({
        tokenAddress: TOKEN, walletAddresses: [HIGH_WALLET, LEGACY_WALLET, INSIDER_WALLET],
      });

      assert.deepEqual(result.holders[0].tags, ['sniper']);
      assert.equal(result.holders[0].primaryTag, 'sniper');
      assert.deepEqual(result.holders[1].tags, []);
      assert.equal(result.holders[1].primaryTag, 'unknown');
      assert.deepEqual(result.holders[2].tags, ['insider']);
      assert.equal(result.holders[2].primaryTag, 'insider');
      const metric = result.distribution.find(({ metric: name }) => name === 'snipers');
      assert.equal(metric.status, 'ready');
      assert.deepEqual(metric.value, { numeratorRaw: '25', denominatorRaw: '100' });
      assert.equal(metric.walletCount, '1');
      const insiderMetric = result.distribution.find(({ metric: name }) => name === 'insiders');
      assert.equal(insiderMetric.status, 'ready');
      assert.deepEqual(insiderMetric.value, { numeratorRaw: '15', denominatorRaw: '100' });
      assert.equal(insiderMetric.walletCount, '1');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
