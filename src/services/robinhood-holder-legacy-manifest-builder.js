'use strict';

const db = require('../models/db');
const { ZERO_ADDRESS } = require('../utils/db-init-stage233');

const CHAIN = 'robinhood';
const MANIFEST = 'robinhood_holder_legacy_coverage_manifest';
const PROGRESS = 'robinhood_holder_legacy_coverage_builds';

function eligibility(row) {
  if (row.deployment_block == null || row.backfill_next_block == null) return 'missing_baseline';
  const hasBlock = row.live_through_block != null;
  if (hasBlock !== (row.live_through_hash != null)) return 'incoherent_checkpoint';
  if (hasBlock) {
    if (row.checkpoint_canonical === true) return null;
    if (row.checkpoint_canonical === false) return 'noncanonical_checkpoint';
    if (row.raw_floor_block == null) return 'missing_raw_floor';
    return BigInt(row.live_through_block) < BigInt(row.raw_floor_block)
      ? null : 'missing_retained_checkpoint';
  }
  if (row.ledger_status !== 'shadow') return 'live_without_checkpoint';
  if (String(row.holder_count) !== '0') return 'shadow_nonzero_holders';
  if (String(row.backfill_next_block) !== String(row.deployment_block)) return 'shadow_cursor_moved';
  if (row.buffer_floor_block == null || row.journal_floor_block == null) return 'missing_coverage_floor';
  if (BigInt(row.deployment_block) < BigInt(row.buffer_floor_block)
      || BigInt(row.deployment_block) < BigInt(row.journal_floor_block)) return 'below_coverage_floor';
  if (BigInt(row.deployment_block) >= BigInt(row.next_block)) return 'deployment_not_captured';
  return row.pending_before_deployment ? 'pending_before_deployment' : null;
}

const CANDIDATES_SQL = `SELECT state.token_address, state.coverage_generation,
    state.ledger_status, state.deployment_block, state.backfill_next_block,
    state.live_through_block, state.live_through_hash, state.holder_count,
    cursor.next_block, cursor.journal_floor_block, cursor.buffer_floor_block,
    raw.raw_floor_block,
    block.canonical AS checkpoint_canonical,
    EXISTS (SELECT 1 FROM robinhood_holder_transfer_journal journal
      WHERE journal.chain=state.chain AND journal.token_address=state.token_address
        AND journal.applied=FALSE AND journal.block_number < state.deployment_block)
      AS pending_before_deployment
  FROM robinhood_holder_token_states state
  JOIN robinhood_holder_cursors cursor ON cursor.chain=state.chain AND cursor.stream='live'
  CROSS JOIN (SELECT MIN(block_number) AS raw_floor_block FROM robinhood_chain_blocks
    WHERE chain=$1 AND canonical=TRUE) raw
  LEFT JOIN robinhood_chain_blocks block ON block.chain=state.chain
    AND block.block_number=state.live_through_block AND block.block_hash=state.live_through_hash
 WHERE state.chain=$1 AND state.ledger_status IN ('live','shadow')
   AND state.tail_capture_from_block IS NULL AND state.token_address > $2
 ORDER BY state.token_address LIMIT $3`;

function manifestValues(row) {
  return [CHAIN, row.token_address, row.coverage_generation, row.ledger_status,
    row.deployment_block, row.backfill_next_block, row.live_through_block,
    row.live_through_hash, row.holder_count];
}

function sameManifest(row, state) {
  return String(row.coverage_generation) === String(state.coverage_generation)
    && row.baseline_status === state.ledger_status
    && String(row.baseline_deployment_block) === String(state.deployment_block)
    && String(row.baseline_backfill_next_block) === String(state.backfill_next_block)
    && String(row.baseline_live_through_block) === String(state.live_through_block)
    && row.baseline_live_through_hash === state.live_through_hash
    && String(row.baseline_holder_count) === String(state.holder_count);
}

async function prepare(client, apply, restart) {
  const lock = apply ? ' FOR UPDATE' : '';
  const policy = (await client.query(
    `SELECT capture_mode FROM robinhood_holder_capture_policy WHERE chain=$1${lock}`, [CHAIN]
  )).rows[0];
  if (policy?.capture_mode !== 'legacy') throw new Error('legacy capture policy is required');
  let progress = (await client.query(
    `SELECT * FROM ${PROGRESS} WHERE chain=$1${lock}`, [CHAIN]
  )).rows[0];
  if (!progress) throw new Error('legacy manifest build progress is missing; apply Stage 233');
  if (!restart) return progress;
  if (!apply || progress.completed_at == null) {
    throw new Error('--restart requires a completed applied pass');
  }
  progress = (await client.query(`UPDATE ${PROGRESS} SET pass=pass+1,
    after_token_address=$2, scanned=0, inserted=0, rejected=0,
    completed_at=NULL, updated_at=NOW() WHERE chain=$1 RETURNING *`,
  [CHAIN, ZERO_ADDRESS])).rows[0];
  return progress;
}

async function persist(client, states, accepted, byToken, progress) {
  const missing = accepted.filter((row) => !byToken.has(row.token_address));
  let inserted = 0;
  if (missing.length) {
    const values = missing.map((_, index) => `(${Array.from({ length: 9 },
      (__, offset) => `$${index * 9 + offset + 1}`).join(',')})`).join(',');
    inserted = (await client.query(`INSERT INTO ${MANIFEST} (
      chain,token_address,coverage_generation,baseline_status,
      baseline_deployment_block,baseline_backfill_next_block,
      baseline_live_through_block,baseline_live_through_hash,baseline_holder_count
    ) VALUES ${values} ON CONFLICT DO NOTHING RETURNING token_address`,
    missing.flatMap(manifestValues))).rowCount;
    if (inserted !== missing.length) throw new Error('concurrent manifest conflict');
  }
  const after = states.at(-1)?.token_address || progress.after_token_address;
  const updated = (await client.query(`UPDATE ${PROGRESS} SET after_token_address=$2,
    scanned=scanned+$3, inserted=inserted+$4, rejected=rejected+$5,
    completed_at=CASE WHEN $6 THEN NOW() ELSE NULL END, updated_at=NOW()
    WHERE chain=$1 RETURNING *`, [CHAIN, after, states.length, inserted,
    states.length - accepted.length, states.length === 0])).rows[0];
  return { inserted, progress: updated };
}

function summarize(states, accepted, existing, inserted, progress, apply) {
  const reasons = {};
  for (const row of states) {
    const reason = eligibility(row);
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return { mode: apply ? 'apply' : 'preview', pass: Number(progress.pass),
    scanned: states.length, eligible: accepted.length, inserted,
    alreadyPresent: existing.length, rejected: states.length - accepted.length,
    rejectionReasons: reasons, nextTokenAddress: states.at(-1)?.token_address || null,
    complete: apply ? progress.completed_at != null : states.length === 0 };
}

function createRobinhoodHolderLegacyManifestBuilder(options = {}) {
  const database = options.database || db;
  async function batch({ limit = 100, apply = false, restart = false } = {}) {
    const client = await database.getClient();
    try {
      await client.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      let progress = await prepare(client, apply, restart);
      const lock = apply ? ' FOR UPDATE OF state' : '';
      const states = (await client.query(`${CANDIDATES_SQL}${lock}`,
        [CHAIN, progress.after_token_address, limit])).rows;
      const accepted = states.filter((row) => eligibility(row) == null);
      const addresses = accepted.map((row) => row.token_address);
      const existing = addresses.length ? (await client.query(
        `SELECT * FROM ${MANIFEST} WHERE chain=$1 AND token_address=ANY($2::varchar[])`,
        [CHAIN, addresses]
      )).rows : [];
      const byToken = new Map(existing.map((row) => [row.token_address, row]));
      const conflict = accepted.find((row) => {
        const found = byToken.get(row.token_address);
        return found && !sameManifest(found, row);
      });
      if (conflict) throw new Error(`manifest conflict for ${conflict.token_address}`);
      let inserted = 0;
      if (apply) {
        ({ inserted, progress } = await persist(client, states, accepted, byToken, progress));
        await client.query('COMMIT');
      } else await client.query('ROLLBACK');
      return summarize(states, accepted, existing, inserted, progress, apply);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ batch });
}

module.exports = { CANDIDATES_SQL, createRobinhoodHolderLegacyManifestBuilder, eligibility };
