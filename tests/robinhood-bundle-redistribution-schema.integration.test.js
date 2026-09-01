process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage187 = require('../src/utils/db-init-stage187');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const SOURCE = `0x${'2'.repeat(40)}`;
const RECIPIENT_A = `0x${'3'.repeat(40)}`;
const RECIPIENT_B = `0x${'4'.repeat(40)}`;
const BUNDLE = `0x${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_bundle_redistribution_states');
}

describe('Robinhood BUNDLED redistribution snapshot schema', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await db.query(`DROP TABLE IF EXISTS
      robinhood_bundle_redistribution_members,
      robinhood_bundle_redistribution_groups,
      robinhood_bundle_redistribution_states CASCADE`);
    await stage187.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('persists one source plus two causal rapid sellers', async () => {
    await db.query(`INSERT INTO robinhood_bundle_redistribution_states (
      token_address, rule_version, evidence_version, status, status_reason,
      source_kind, source_run_id, through_block_number, through_block_hash,
      policy_json, observed_at
    ) VALUES ($1, 'rh_possible_bundle_redistribution_v1',
      'rh_token_redistribution_v1', 'ready', 'groups_found', 'seed', 1, 100,
      $2, '{"maximumRecipientSellDelayMs":300000}', NOW())`, [TOKEN, HASH]);
    await assert.rejects(db.query(`INSERT INTO robinhood_bundle_redistribution_groups (
      token_address, rule_version, bundle_id, source_wallet, member_count,
      connection_count, confirmation_block, confirmation_transaction_index,
      confirmation_action_index, confirmation_transaction_hash, evidence_json
    ) VALUES ($1, 'rh_possible_bundle_redistribution_v1', $2, $3, 2, 1,
      40, 0, 0, $4, '{"signal":"coordinated_token_redistribution"}')`,
    [TOKEN, `0x${'c'.repeat(64)}`, SOURCE, HASH]),
    /rh_bundle_redistribution_groups_counts_check/);
    await db.query(`INSERT INTO robinhood_bundle_redistribution_groups (
      token_address, rule_version, bundle_id, source_wallet, member_count,
      connection_count, confirmation_block, confirmation_transaction_index,
      confirmation_action_index, confirmation_transaction_hash,
      confirmation_fdv_usd, evidence_json
    ) VALUES ($1, 'rh_possible_bundle_redistribution_v1', $2, $3, 3, 2,
      40, 1, 2, $4, NULL, '{"signal":"coordinated_token_redistribution"}')`,
    [TOKEN, BUNDLE, SOURCE, HASH]);
    const insertMember = (wallet, kind, transferBlock, sellBlock, delayMs) => db.query(
      `INSERT INTO robinhood_bundle_redistribution_members (
         token_address, rule_version, bundle_id, wallet_address, connection_kind,
         source_buy_block, source_buy_transaction_index, source_buy_action_index,
         source_buy_transaction_hash, transfer_block, transfer_transaction_index,
         transfer_log_index, transfer_transaction_hash, transfer_amount_raw,
         sell_block, sell_transaction_index, sell_action_index,
         sell_transaction_hash, sell_delay_ms, evidence_json
       ) VALUES ($1, 'rh_possible_bundle_redistribution_v1', $2, $3, $4,
         10, 0, 1, $5, $6, $7, $7, $8, $9, $10, $7, $7, $11, $12,
         '{"causal":true}')`,
      [TOKEN, BUNDLE, wallet, kind, HASH, transferBlock,
        transferBlock == null ? null : 0, transferBlock == null ? null : HASH,
        transferBlock == null ? null : '100', sellBlock,
        sellBlock == null ? null : HASH, delayMs]
    );
    await insertMember(SOURCE, 'redistribution_source', null, null, null);
    await insertMember(RECIPIENT_A, 'rapid_sell_recipient', 20, 21, 300000);
    await insertMember(RECIPIENT_B, 'rapid_sell_recipient', 30, 31, 1);
    await assert.rejects(insertMember(
      `0x${'5'.repeat(40)}`, 'rapid_sell_recipient', 30, 31, 300001
    ), /rh_bundle_redistribution_members_causality_check/);
    assert.equal((await db.query(
      'SELECT COUNT(*)::integer count FROM robinhood_bundle_redistribution_members'
    )).rows[0].count, 3);
  });
});
