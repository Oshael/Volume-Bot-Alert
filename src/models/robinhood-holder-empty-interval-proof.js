'use strict';

const { readLocalEvidence, gap } = require('./robinhood-holder-local-proof');
const { lockRobinhoodCanonicalProjection } = require('./robinhood-canonical-projection-fence');
const { TRANSFER_TOPIC } = require('../services/evm-erc20-supply-delta');
const { RULE_VERSION } = require('../utils/db-init-stage188');

const MAX_BLOCKS = 1000n;
const EXPECTED_FAILURES = new Set([
  'canonical_holder_source_gap', 'canonical_projection_fence_conflict', '57014', '55P03',
]);

// This proves absence from complete capture digests, never from a filtered log count.
async function proveEmptyHolderInterval(database, input) {
  const from = BigInt(input.live_through_block) + 1n;
  const to = BigInt(input.event_through_block);
  if (to < from || to - from + 1n > MAX_BLOCKS) return null;
  const client = await database.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='1000ms'");
    await client.query("SET LOCAL lock_timeout='25ms'");
    await lockRobinhoodCanonicalProjection(client, null, 'empty holder interval');
    const { rows } = await client.query(`SELECT target.block_hash, target.block_timestamp,
        first.parent_hash
      FROM robinhood_holder_token_states holder
      JOIN robinhood_chain_blocks previous ON previous.chain=holder.chain
        AND previous.block_hash=holder.live_through_hash AND previous.canonical
        AND previous.block_number=holder.live_through_block
      JOIN robinhood_chain_blocks first ON first.chain=holder.chain AND first.canonical
        AND first.block_number=$4::bigint
      JOIN robinhood_chain_blocks target ON target.chain=holder.chain AND target.canonical
        AND target.block_number=$5::bigint
      JOIN robinhood_chain_capture_cursor capture ON capture.chain=holder.chain
      JOIN robinhood_holder_cursors cursor ON cursor.chain=holder.chain AND cursor.stream='live'
      WHERE holder.chain='robinhood' AND holder.token_address=$1
        AND holder.ledger_status='live' AND holder.live_through_block=$2::bigint
        AND holder.live_through_hash=$3 AND first.parent_hash=$3
        AND capture.recovery_state='running' AND capture.checkpoint_block >= $5::bigint
        AND cursor.next_block > $5::bigint AND cursor.safe_head >= $5::bigint
        AND NOT EXISTS (SELECT 1 FROM robinhood_holder_transfer_journal journal
          WHERE journal.chain=holder.chain AND journal.token_address=holder.token_address
            AND NOT journal.applied)`, [input.token_address, input.live_through_block,
      input.live_through_hash, from.toString(), to.toString()]);
    const target = rows[0];
    if (!target || (input.source_through_hash && input.source_through_hash !== target.block_hash)) {
      throw gap('checkpoint-unproven');
    }
    const events = await readLocalEvidence(client, from, to);
    if (events.some((event) => event.address === input.token_address
        && event.topic0 === TRANSFER_TOPIC)) throw gap('transfer-present');
    await client.query('COMMIT');
    return { ...input, through_block: to.toString(), through_hash: target.block_hash,
      through_time: new Date(target.block_timestamp).toISOString() };
  } catch (error) {
    await client.query('ROLLBACK');
    if (EXPECTED_FAILURES.has(error.code)) return null;
    throw error;
  } finally { client.release(); }
}

function createEmptyHolderFrontierReader(database) {
  let afterToken = '';
  const deferred = new Map();
  return async function findEmptyFrontiers() {
    const sql = `SELECT holder.token_address, holder.live_through_block::text,
        holder.live_through_hash, holder.version::text AS holder_version,
        queue.event_through_block::text, queue.requested_version::text
      FROM robinhood_bundle_redistribution_queue queue
      JOIN robinhood_bundle_redistribution_activations activation USING(chain,rule_version)
      JOIN robinhood_holder_token_states holder USING(chain,token_address)
      WHERE queue.chain='robinhood' AND queue.rule_version=$1 AND activation.status='active'
        AND queue.next_attempt_at <= NOW() AND (queue.status='pending'
          OR (queue.status='leased' AND queue.lease_until <= NOW()))
        AND holder.ledger_status='live' AND holder.token_address > $2
        AND queue.event_through_block > holder.live_through_block
        AND queue.event_through_block-holder.live_through_block <= $3::bigint
        AND NOT (COALESCE(queue.source_requested_version=queue.requested_version
          AND queue.source_through_block >= queue.event_through_block
          AND queue.source_through_hash IS NOT NULL AND queue.source_through_time IS NOT NULL,FALSE))
      ORDER BY holder.token_address LIMIT 3`;
    const params = [RULE_VERSION, afterToken, MAX_BLOCKS.toString()];
    let rows;
    try {
      ({ rows } = await (database.queryWithStatementTimeout
        ? database.queryWithStatementTimeout(sql, params, 1000) : database.query(sql, params)));
    } catch (error) {
      if (EXPECTED_FAILURES.has(error.code)) return [];
      throw error;
    }
    if (!rows.length) { afterToken = ''; return []; }
    const proofs = [];
    const deadline = Date.now() + 750;
    for (const row of rows) {
      afterToken = row.token_address;
      if ((deferred.get(row.token_address) || 0) > Date.now()) continue;
      const proof = await proveEmptyHolderInterval(database, row);
      if (proof) { proofs.push(proof); deferred.delete(row.token_address); }
      else {
        deferred.set(row.token_address, Date.now() + 5000);
        if (deferred.size > 256) deferred.delete(deferred.keys().next().value);
      }
      if (Date.now() >= deadline) break;
    }
    return proofs;
  };
}

module.exports = { createEmptyHolderFrontierReader, proveEmptyHolderInterval };
