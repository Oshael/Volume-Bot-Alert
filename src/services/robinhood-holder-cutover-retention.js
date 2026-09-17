'use strict';

const {
  DEFAULT_RETENTION_MS,
} = require('./robinhood-chain-event-pruner');

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CHECKPOINT_AGE_MS = 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

function unavailable(reason) {
  const error = new Error(`holder cutover raw retention unavailable: ${reason}`);
  error.code = 'holder_cutover_retention_unavailable';
  error.reason = reason;
  return error;
}

function createRobinhoodHolderCutoverRetention() {
  async function assertProtected(client, frontier) {
    if (DEFAULT_RETENTION_MS < RECOVERY_WINDOW_MS + MAX_CHECKPOINT_AGE_MS) {
      throw unavailable('pruner_minimum_too_short');
    }
    const result = await client.query(
      `SELECT block.block_timestamp, NOW() AS database_now
         FROM robinhood_chain_blocks block
        WHERE block.chain='robinhood' AND block.canonical=TRUE
          AND block.block_number=$1::bigint AND block.block_hash=$2`,
      [frontier.checkpointBlock, frontier.checkpointHash]
    );
    if (result.rowCount !== 1) throw unavailable('checkpoint_not_canonical');
    const now = new Date(result.rows[0].database_now).getTime();
    const timestamp = new Date(result.rows[0].block_timestamp).getTime();
    const age = now - timestamp;
    if (!Number.isFinite(age) || age > MAX_CHECKPOINT_AGE_MS
        || age < -MAX_FUTURE_SKEW_MS) {
      throw unavailable('checkpoint_not_recent');
    }
    return Object.freeze({ recoveryWindowUntil: new Date(now + RECOVERY_WINDOW_MS).toISOString(),
      checkpointAgeMs: age });
  }
  return Object.freeze({ assertProtected });
}

module.exports = { createRobinhoodHolderCutoverRetention, RECOVERY_WINDOW_MS };
