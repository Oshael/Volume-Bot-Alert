'use strict';

const db = require('../models/db');

function numberOrNull(value) {
  return value == null ? null : BigInt(value);
}

function text(value) {
  return value == null ? null : String(value);
}

function evaluate(row = {}) {
  const blockers = [];
  const add = (condition, code) => { if (condition) blockers.push(code); };
  const from = numberOrNull(row.cutover_next_block);
  const holderNext = numberOrNull(row.holder_next_block);
  const holderCheckpoint = numberOrNull(row.holder_checkpoint_block);
  const cutoverCheckpoint = numberOrNull(row.cutover_checkpoint_block);
  const captureCheckpoint = numberOrNull(row.capture_checkpoint_block);
  const rawFloor = numberOrNull(row.raw_floor_block);
  const tracked = row.capture_mode === 'tracked';

  add(!tracked, 'tracked_policy_required');
  add(from == null || cutoverCheckpoint == null || from !== cutoverCheckpoint + 1n
    || !row.cutover_checkpoint_hash, 'cutover_anchor_invalid');
  add(holderNext == null || holderCheckpoint == null
    || holderNext !== holderCheckpoint + 1n || !row.holder_checkpoint_hash,
  'holder_cursor_invalid');
  add(from != null && holderNext != null && from > holderNext, 'cutover_ahead_of_holder');
  add(rawFloor == null || (from != null && rawFloor > from), 'raw_coverage_unavailable');
  add(captureCheckpoint == null || holderCheckpoint != null
    && captureCheckpoint < holderCheckpoint, 'canonical_capture_behind_holder');
  add(row.cutover_anchor_canonical !== true, 'cutover_anchor_not_canonical');
  add(row.holder_checkpoint_canonical !== true, 'holder_checkpoint_not_canonical');

  return Object.freeze({
    mode: 'read-only', readyForReconstruction: blockers.length === 0, blockers,
    // This is a feasibility check, not proof that every intermediate raw block
    // and Transfer event can be reconstructed or that rollback may be committed.
    reconstruction: {
      fromBlock: text(from), throughBlock: holderCheckpoint != null && from != null
        && holderCheckpoint >= from ? text(holderCheckpoint) : null,
      rawFloorBlock: text(rawFloor), captureCheckpointBlock: text(captureCheckpoint),
    },
    policy: {
      mode: row.capture_mode || null, version: text(row.policy_version),
      cutoverCheckpointBlock: text(cutoverCheckpoint),
    },
    holder: { nextBlock: text(holderNext), checkpointBlock: text(holderCheckpoint) },
  });
}

function createRobinhoodHolderRollbackPreflight(options = {}) {
  const database = options.database || db;
  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const result = await client.query(
        `SELECT policy.capture_mode, policy.version AS policy_version,
                policy.cutover_next_block, policy.cutover_checkpoint_block,
                policy.cutover_checkpoint_hash,
                holder.next_block AS holder_next_block,
                holder.checkpoint_block AS holder_checkpoint_block,
                holder.checkpoint_hash AS holder_checkpoint_hash,
                capture.checkpoint_block AS capture_checkpoint_block,
                floor.block_number AS raw_floor_block,
                anchor.block_hash IS NOT NULL AS cutover_anchor_canonical,
                current_block.block_hash IS NOT NULL AS holder_checkpoint_canonical
           FROM (VALUES (1)) seed(value)
           LEFT JOIN robinhood_holder_capture_policy policy ON policy.chain='robinhood'
           LEFT JOIN robinhood_holder_cursors holder
             ON holder.chain='robinhood' AND holder.stream='live'
           LEFT JOIN robinhood_chain_capture_cursor capture
             ON capture.chain='robinhood'
           LEFT JOIN LATERAL (
             SELECT block_number FROM robinhood_chain_blocks
              WHERE chain='robinhood' AND canonical=TRUE
              ORDER BY block_number LIMIT 1
           ) floor ON TRUE
           LEFT JOIN robinhood_chain_blocks anchor
             ON anchor.chain='robinhood' AND anchor.canonical=TRUE
            AND anchor.block_number=policy.cutover_checkpoint_block
            AND anchor.block_hash=policy.cutover_checkpoint_hash
           LEFT JOIN robinhood_chain_blocks current_block
             ON current_block.chain='robinhood' AND current_block.canonical=TRUE
            AND current_block.block_number=holder.checkpoint_block
            AND current_block.block_hash=holder.checkpoint_hash`
      );
      await client.query('ROLLBACK');
      return evaluate(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ inspect });
}

module.exports = { createRobinhoodHolderRollbackPreflight, evaluate };
