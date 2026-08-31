const db = require('./db');
const { RULE_VERSION } = require('../services/robinhood-fresh-wallet-rule');

const CHAIN = 'robinhood';

function createRobinhoodFreshWalletSignedOriginAuditRepository(options = {}) {
  const database = options.database || db;

  async function loadCoverage() {
    const row = (await database.query(`SELECT origin_block::text,
        safe_head::text AS through_block, lifecycle_state
      FROM robinhood_wallet_signed_origin_cursors
      WHERE chain = $1 AND stream = 'seed'`, [CHAIN])).rows[0];
    if (!row || row.lifecycle_state !== 'completed' || row.through_block == null) {
      throw Object.assign(new Error('signed-origin seed cursor is not completed'), {
        code: 'fresh_signed_origin_audit_not_ready',
      });
    }
    return Object.freeze({ originBlock: row.origin_block,
      throughBlock: row.through_block });
  }

  async function sampleCandidates(limit) {
    const { rows } = await database.query(`SELECT queue.token_address,
        queue.wallet_address, buy.transaction_hash, buy.transaction_index::text,
        buy.block_number::text, buy.block_hash, buy.block_time
      FROM robinhood_fresh_wallet_queue queue
      INNER JOIN robinhood_wallet_token_first_buys buy USING (
        chain, token_address, wallet_address
      )
      INNER JOIN robinhood_fresh_wallet_activations activation USING (chain, rule_version)
      INNER JOIN robinhood_wallet_signed_origin_cursors cursor
        ON cursor.chain = queue.chain AND cursor.stream = 'seed'
       AND cursor.lifecycle_state = 'completed'
      WHERE queue.chain = $1 AND queue.rule_version = $2
        AND queue.source_kind = 'live'
        AND buy.block_time >= activation.activation_at
        AND buy.block_number <= cursor.safe_head
      ORDER BY MD5(queue.token_address || queue.wallet_address)
      LIMIT $3`, [CHAIN, RULE_VERSION, limit]);
    return rows.map((row) => Object.freeze({
      tokenAddress: row.token_address, walletAddress: row.wallet_address,
      transactionHash: row.transaction_hash, transactionIndex: row.transaction_index,
      blockNumber: row.block_number, blockHash: row.block_hash,
      blockTime: row.block_time.toISOString(),
    }));
  }

  async function loadOrigins(walletAddresses) {
    if (!walletAddresses.length) return new Map();
    const { rows } = await database.query(`SELECT wallet_address,
        first_block_number::text, first_transaction_index::text, first_nonce::text,
        coverage_origin_block::text
      FROM robinhood_wallet_signed_origins
      WHERE chain = $1 AND wallet_address = ANY($2::varchar[])`, [CHAIN, walletAddresses]);
    return new Map(rows.map((row) => [row.wallet_address, Object.freeze({
      blockNumber: row.first_block_number, transactionIndex: row.first_transaction_index,
      nonce: row.first_nonce, coverageOriginBlock: row.coverage_origin_block,
    })]));
  }

  return Object.freeze({ loadCoverage, loadOrigins, sampleCandidates });
}

module.exports = { createRobinhoodFreshWalletSignedOriginAuditRepository };
