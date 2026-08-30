const db = require('../models/db');
const { inferPriorSignedActivity } = require('./robinhood-wallet-signed-origin-domain');

const CHAIN = 'robinhood';

function unavailable(reason) {
  return Object.assign(new Error(`FRESH signed-origin evidence unavailable: ${reason}`), {
    code: 'fresh_signed_origin_unavailable', reason,
  });
}

function originFrom(row) {
  if (row.first_block_number == null) return null;
  return Object.freeze({
    blockNumber: String(row.first_block_number), blockHash: row.first_block_hash,
    blockTime: row.first_block_time?.toISOString?.() || String(row.first_block_time),
    transactionHash: row.first_transaction_hash,
    transactionIndex: String(row.first_transaction_index), nonce: String(row.first_nonce),
    sourceStream: row.source_stream,
  });
}

function createRobinhoodFreshWalletSignedOriginSource(options = {}) {
  const database = options.database || db;
  const canonicalSource = options.canonicalSource;
  if (typeof canonicalSource?.readCanonicalEvidence !== 'function') {
    throw new TypeError('FRESH canonical RPC source is required');
  }

  async function readEvidence(input = {}) {
    const canonical = await canonicalSource.readCanonicalEvidence(input);
    const { rows } = await database.query(`SELECT cursor.origin_block::text,
        cursor.checkpoint_block::text AS through_block,
        origin.first_block_number::text, origin.first_block_hash,
        origin.first_block_time, origin.first_transaction_hash,
        origin.first_transaction_index::text, origin.first_nonce::text,
        origin.source_stream
      FROM robinhood_wallet_signed_origin_cursors cursor
      LEFT JOIN robinhood_wallet_signed_origins origin
        ON origin.chain = cursor.chain AND origin.wallet_address = $2
      WHERE cursor.chain = $1 AND cursor.stream = 'live'
        AND cursor.lifecycle_state IN ('running', 'caught_up')`, [
      CHAIN, canonical.firstBuy.walletAddress,
    ]);
    const row = rows[0];
    if (!row || row.through_block == null) throw unavailable('coverage_missing');
    const coverage = Object.freeze({
      originBlock: String(row.origin_block), throughBlock: String(row.through_block),
    });
    const origin = originFrom(row);
    const inference = inferPriorSignedActivity({
      cutoffBlock: canonical.cutoff.number, coverage,
      firstBuy: { blockNumber: canonical.firstBuy.blockNumber,
        transactionIndex: input.transactionIndex },
      signedOrigin: origin && { blockNumber: origin.blockNumber,
        transactionIndex: origin.transactionIndex, nonce: origin.nonce },
    });
    if (inference.status !== 'ready') throw unavailable(inference.reason);
    return Object.freeze({ ...canonical, source: 'robinhood-signed-origin-index',
      sourceKind: 'live', signedActivity: Object.freeze({
        priorSignedActivity: inference.priorSignedActivity,
        reason: inference.reason, coverage, origin,
      }),
    });
  }

  return Object.freeze({ sourceKind: 'live', readEvidence });
}

module.exports = { createRobinhoodFreshWalletSignedOriginSource };
