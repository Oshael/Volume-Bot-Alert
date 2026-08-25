const db = require('./db');

const CHAIN = 'robinhood';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function fixedHex(value, label, bytes) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(result)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return result;
}

function uint(value, label) {
  const result = String(value ?? '').trim();
  if (!/^\d+$/.test(result)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(result).toString();
}

function normalize(event) {
  const date = new Date(event.blockTime);
  if (!Number.isFinite(date.getTime())) throw new Error('blockTime must be a timestamp');
  const tokenAddress = fixedHex(event.tokenAddress, 'tokenAddress', 20);
  const fromWallet = fixedHex(event.fromWallet, 'fromWallet', 20);
  const toWallet = fixedHex(event.toWallet, 'toWallet', 20);
  if (tokenAddress === ZERO_ADDRESS || fromWallet === ZERO_ADDRESS
    || toWallet === ZERO_ADDRESS || fromWallet === toWallet) {
    throw new Error('directional evidence addresses are invalid');
  }
  const logIndex = BigInt(uint(event.logIndex, 'logIndex'));
  if (logIndex > 2_147_483_647n) throw new Error('logIndex exceeds PostgreSQL integer');
  return {
    token_address: tokenAddress, from_wallet: fromWallet, to_wallet: toWallet,
    block_number: uint(event.blockNumber, 'blockNumber'),
    log_index: Number(logIndex),
    block_time: date.toISOString(),
    transaction_hash: fixedHex(event.transactionHash, 'transactionHash', 32),
    amount_raw: uint(event.amountRaw, 'amountRaw'),
  };
}

function version(value) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) throw new Error('projectionVersion is invalid');
  return result;
}

function createRobinhoodDirectionalTransferEvidenceRepository(options = {}) {
  const database = options.database || db;

  async function applyEvidence(input = {}) {
    if (!Array.isArray(input.events)) throw new Error('events must be a list');
    const projectionVersion = version(input.projectionVersion);
    const rows = input.events.map(normalize);
    if (!rows.length) return Object.freeze({ edgesConsidered: 0, edgesWritten: 0 });
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH candidates AS MATERIALIZED (
           SELECT DISTINCT ON (item.token_address, item.from_wallet, item.to_wallet)
             item.* FROM jsonb_to_recordset($3::jsonb) AS item(
               token_address text, from_wallet text, to_wallet text,
               block_number bigint, log_index integer, block_time timestamptz,
               transaction_hash text, amount_raw numeric
             ) ORDER BY item.token_address, item.from_wallet, item.to_wallet,
               item.block_number, item.log_index
         ), matched AS MATERIALIZED (
           SELECT candidate.*, edge.first_wallet_transfer_block AS current_block,
             edge.first_wallet_transfer_log_index AS current_log,
             edge.first_wallet_transfer_at AS current_at,
             edge.first_wallet_transfer_transaction_hash AS current_hash,
             edge.first_wallet_transfer_amount_raw AS current_amount
           FROM candidates candidate
           JOIN robinhood_wallet_transfer_edges edge
             ON edge.chain = $1 AND edge.classification_version = $2
            AND edge.token_address = candidate.token_address
            AND edge.from_wallet = candidate.from_wallet AND edge.to_wallet = candidate.to_wallet
            AND edge.wallet_transfer_count > 0
            AND (candidate.block_number, candidate.log_index)
              BETWEEN (edge.first_block, edge.first_log_index)
                  AND (edge.last_block, edge.last_log_index)
            AND candidate.block_time BETWEEN edge.first_seen_at AND edge.last_seen_at
         ), unmatched AS MATERIALIZED (
           SELECT candidate.* FROM candidates candidate
           WHERE NOT EXISTS (
             SELECT 1 FROM matched
              WHERE matched.token_address = candidate.token_address
                AND matched.from_wallet = candidate.from_wallet
                AND matched.to_wallet = candidate.to_wallet
           )
         ), updated AS (
           UPDATE robinhood_wallet_transfer_edges edge SET
             first_wallet_transfer_block = matched.block_number,
             first_wallet_transfer_log_index = matched.log_index,
             first_wallet_transfer_at = matched.block_time,
             first_wallet_transfer_transaction_hash = matched.transaction_hash,
             first_wallet_transfer_amount_raw = matched.amount_raw,
             updated_at = NOW()
           FROM matched WHERE edge.chain = $1 AND edge.classification_version = $2
             AND edge.token_address = matched.token_address
             AND edge.from_wallet = matched.from_wallet AND edge.to_wallet = matched.to_wallet
             AND (edge.first_wallet_transfer_block IS NULL OR
               (matched.block_number, matched.log_index) <
               (edge.first_wallet_transfer_block, edge.first_wallet_transfer_log_index))
           RETURNING 1
         ) SELECT
           (SELECT COUNT(*)::integer FROM candidates) AS considered,
           (SELECT COUNT(*)::integer FROM matched) AS matched,
           (SELECT COUNT(*)::integer FROM updated) AS written,
           (SELECT ARRAY_AGG(DISTINCT token_address ORDER BY token_address)
              FROM unmatched) AS missing_tokens,
           (SELECT COUNT(*)::integer FROM matched WHERE current_block = block_number
             AND current_log = log_index
             AND (current_at <> block_time OR current_hash <> transaction_hash
               OR current_amount <> amount_raw)) AS conflicts`,
        [CHAIN, projectionVersion, JSON.stringify(rows)]
      );
      const outcome = result.rows[0];
      if (outcome.matched !== outcome.considered || outcome.conflicts) {
        const error = new Error(outcome.conflicts
          ? 'directional evidence conflicts with the stored canonical position'
          : 'directional evidence has no matching historical edge');
        error.code = outcome.conflicts
          ? 'directional_replay_evidence_conflict' : 'directional_replay_edge_missing';
        if (!outcome.conflicts) error.tokenAddresses = Object.freeze(outcome.missing_tokens || []);
        throw error;
      }
      await client.query('COMMIT');
      return Object.freeze({
        edgesConsidered: outcome.considered, edgesWritten: outcome.written,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ applyEvidence });
}

module.exports = { createRobinhoodDirectionalTransferEvidenceRepository };
