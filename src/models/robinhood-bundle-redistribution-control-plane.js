const db = require('./db');
const {
  EVIDENCE_VERSION, PROJECTION_VERSION, RULE_VERSION,
} = require('../utils/db-init-stage188');

const CHAIN = 'robinhood';
const HASH = /^0x[0-9a-f]{64}$/;

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function activation(row) {
  if (!row) return null;
  return Object.freeze({
    status: row.status,
    activationAt: new Date(row.activation_at).toISOString(),
    activationBlock: String(row.activation_block),
    checkpointBlock: row.activation_checkpoint_block == null
      ? null : String(row.activation_checkpoint_block),
    checkpointHash: row.activation_checkpoint_hash || null,
    activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
  });
}

function frontier(row) {
  return Object.freeze({
    source: row.source,
    lifecycleState: row.lifecycle_state,
    nextBlock: row.next_block == null ? null : String(row.next_block),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash || null,
  });
}

function assess(current, frontiers) {
  const reasons = [];
  for (const name of ['wallet_swaps', 'wallet_transfers']) {
    const source = frontiers.find((item) => item.source === name);
    if (!source) reasons.push(`${name}_cursor_missing`);
    else if (source.lifecycleState !== 'running') reasons.push(`${name}_not_running`);
    else if (source.nextBlock == null) reasons.push(`${name}_frontier_missing`);
    else if (current && BigInt(source.nextBlock) <= BigInt(current.activationBlock)) {
      reasons.push(`${name}_before_activation`);
    }
  }
  const checkpoints = current ? frontiers.filter((item) => (
    item.checkpointBlock != null && HASH.test(item.checkpointHash || '')
      && BigInt(item.checkpointBlock) >= BigInt(current.activationBlock)
  )) : [];
  if (current && !checkpoints.length) reasons.push('canonical_checkpoint_after_activation_missing');
  checkpoints.sort((left, right) => (
    BigInt(left.checkpointBlock) < BigInt(right.checkpointBlock) ? -1 : 1
  ));
  return Object.freeze({ ready: reasons.length === 0, reasons, checkpoint: checkpoints[0] || null });
}

async function loadFrontiers(queryable) {
  const { rows } = await queryable.query(`SELECT 'wallet_swaps' source, lifecycle_state,
      next_block, checkpoint_block, checkpoint_hash
    FROM robinhood_wallet_swap_cursors
    WHERE chain = $1 AND stream = 'live'
    UNION ALL
    SELECT 'wallet_transfers' source, lifecycle_state, next_block,
      checkpoint_block, checkpoint_hash
    FROM robinhood_wallet_transfer_cursors
    WHERE chain = $1 AND projection_version = $2 AND stream = 'live'`,
  [CHAIN, PROJECTION_VERSION]);
  return rows.map(frontier);
}

async function loadActivation(queryable, lock = false) {
  const { rows } = await queryable.query(`SELECT status, activation_at, activation_block,
      activation_checkpoint_block, activation_checkpoint_hash, activated_at
    FROM robinhood_bundle_redistribution_activations
    WHERE chain = $1 AND rule_version = $2${lock ? ' FOR UPDATE' : ''}`,
  [CHAIN, RULE_VERSION]);
  return activation(rows[0]);
}

function createRobinhoodBundleRedistributionControlPlane(options = {}) {
  const database = options.database || db;

  async function inspect() {
    const [current, frontiers] = await Promise.all([
      loadActivation(database), loadFrontiers(database),
    ]);
    const assessment = assess(current, frontiers);
    return Object.freeze({ mode: 'read-only', activation: current, frontiers,
      ready: assessment.ready, reasons: assessment.reasons });
  }

  async function apply(input = {}) {
    const leadBlocks = bounded(input.leadBlocks, 1000, 100, 100_000, 'leadBlocks');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      let current = await loadActivation(client, true);
      const frontiers = await loadFrontiers(client);
      const assessment = assess(current, frontiers);
      if (!current) {
        if (!assessment.ready) {
          await client.query('ROLLBACK');
          return Object.freeze({ mode: 'apply', action: 'none', activation: null,
            frontiers, ready: false, reasons: assessment.reasons });
        }
        const activationBlock = frontiers.reduce((maximum, item) => {
          const candidate = BigInt(item.nextBlock);
          return candidate > maximum ? candidate : maximum;
        }, 0n) + BigInt(leadBlocks);
        const { rows } = await client.query(`INSERT INTO
          robinhood_bundle_redistribution_activations(
            chain, rule_version, evidence_version, status, activation_at, activation_block
          ) VALUES ($1, $2, $3, 'planned', NOW(), $4::bigint)
          ON CONFLICT (chain, rule_version) DO NOTHING
          RETURNING status, activation_at, activation_block,
            activation_checkpoint_block, activation_checkpoint_hash, activated_at`,
        [CHAIN, RULE_VERSION, EVIDENCE_VERSION, activationBlock.toString()]);
        current = activation(rows[0]) || await loadActivation(client, true);
        if (!current) throw new Error('redistribution activation changed concurrently');
        await client.query('COMMIT');
        return Object.freeze({ mode: 'apply', action: rows[0] ? 'reserved' : 'none',
          activation: current,
          frontiers, ready: false, reasons: ['frontiers_have_not_crossed_activation'] });
      }
      if (current.status !== 'planned' || !assessment.ready) {
        await client.query('ROLLBACK');
        return Object.freeze({ mode: 'apply', action: 'none', activation: current,
          frontiers, ready: current.status === 'active' || assessment.ready,
          reasons: current.status === 'active' ? [] : assessment.reasons });
      }
      const { rows } = await client.query(`UPDATE
        robinhood_bundle_redistribution_activations SET status = 'active',
          activation_checkpoint_block = $3::bigint, activation_checkpoint_hash = $4,
          activated_at = NOW(), updated_at = NOW()
        WHERE chain = $1 AND rule_version = $2 AND status = 'planned'
        RETURNING status, activation_at, activation_block,
          activation_checkpoint_block, activation_checkpoint_hash, activated_at`,
      [CHAIN, RULE_VERSION, assessment.checkpoint.checkpointBlock,
        assessment.checkpoint.checkpointHash]);
      if (!rows[0]) throw new Error('redistribution activation changed concurrently');
      current = activation(rows[0]);
      await client.query('COMMIT');
      return Object.freeze({ mode: 'apply', action: 'activated', activation: current,
        frontiers, ready: true, reasons: [] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ apply, inspect });
}

module.exports = { createRobinhoodBundleRedistributionControlPlane, __private: { assess } };
