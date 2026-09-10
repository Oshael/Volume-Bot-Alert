'use strict';

const db = require('./db');
const {
  createRobinhoodWalletSwapRealtimeOutboxRepository,
} = require('./robinhood-wallet-swap-realtime-outbox');
const { createRobinhoodMarketReorgRollback } = require('./robinhood-market-reorg-rollback');

const CHAIN = 'robinhood';
const NOTIFY_CHANNEL = 'robinhood_chain_recovery_outbox';

function generation(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error('recovery generation is invalid');
  return BigInt(raw).toString();
}
function blockNumber(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}
function blockHash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}
function recoveryError(code, message) {
  const error = new Error(message); error.code = code; return error;
}
function timestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('recovery detectedAt is invalid');
  return parsed.toISOString();
}
function recoveryPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recovery plan is required');
  }
  const normalizedGeneration = generation(value.generation);
  return { plan: value, generation: normalizedGeneration };
}
function assertRollbackGate(value) {
  if (value.executable !== true || !Array.isArray(value.pendingRollbackDomains)
      || value.pendingRollbackDomains.length !== 0) {
    throw recoveryError(
      'capture_recovery_not_executable', 'recovery rollback gate is not satisfied'
    );
  }
  if (value.recoverable !== true || value.reason !== 'parent_hash_mismatch') {
    throw recoveryError('capture_recovery_not_recoverable', 'recovery plan cannot be rewound');
  }
}
function rewindRange(value) {
  const ancestor = blockNumber(value.ancestor?.blockNumber, 'recovery.ancestor.blockNumber');
  const checkpoint = blockNumber(
    value.checkpoint?.blockNumber, 'recovery.checkpoint.blockNumber'
  );
  const incoming = blockNumber(value.incoming?.blockNumber, 'recovery.incoming.blockNumber');
  const fromBlock = blockNumber(value.affectedRange?.fromBlock, 'recovery.range.fromBlock');
  const throughBlock = blockNumber(
    value.affectedRange?.throughBlock, 'recovery.range.throughBlock'
  );
  const depth = blockNumber(value.affectedRange?.depth, 'recovery.range.depth');
  const maxDepth = blockNumber(value.maxDepth, 'recovery.maxDepth');
  const checkpointHash = blockHash(
    value.checkpoint.blockHash, 'recovery.checkpoint.blockHash'
  );
  const replacementCheckpointHash = blockHash(
    value.incoming.parentHash, 'recovery.incoming.parentHash'
  );
  return {
    ancestor, checkpoint, incoming, fromBlock, throughBlock, depth, maxDepth,
    ancestorHash: blockHash(value.ancestor.blockHash, 'recovery.ancestor.blockHash'),
    checkpointHash, replacementCheckpointHash,
  };
}
function assertRewindRange(range) {
  const { ancestor, checkpoint, incoming, fromBlock, throughBlock, depth, maxDepth,
    checkpointHash, replacementCheckpointHash } = range;
  if (fromBlock !== ancestor + 1n || throughBlock !== checkpoint
      || depth !== checkpoint - ancestor || depth < 1n || depth > maxDepth
      || maxDepth < 1n || maxDepth > 1000n || incoming !== checkpoint + 1n
      || replacementCheckpointHash === checkpointHash) {
    throw recoveryError('capture_recovery_range_invalid', 'recovery range is inconsistent');
  }
}
function canonicalRewindPlan(value, expectedGeneration) {
  const normalized = recoveryPlan(value);
  if (normalized.generation !== expectedGeneration) {
    throw recoveryError('capture_recovery_fence_conflict', 'recovery generation changed');
  }
  assertRollbackGate(value);
  const range = rewindRange(value);
  assertRewindRange(range);
  return { plan: value, ...range };
}
function rewindDisposition(current, rewind, recoveryGeneration) {
  const nextGeneration = (BigInt(recoveryGeneration) + 1n).toString();
  const alreadyApplied = current.status === 'rewound'
    && current.same_plan === true
    && current.cursor_generation === nextGeneration
    && current.recovery_state === 'recovery_required'
    && current.checkpoint_block === rewind.ancestor.toString()
    && current.checkpoint_hash === rewind.ancestorHash;
  if (alreadyApplied) return { alreadyApplied, nextGeneration };
  if (current.status !== 'detected' || current.cursor_generation !== recoveryGeneration
      || current.recovery_state !== 'recovery_required'
      || current.checkpoint_block !== rewind.checkpoint.toString()
      || current.checkpoint_hash !== rewind.checkpointHash || current.same_plan !== true) {
    throw recoveryError(
      'capture_recovery_fence_conflict', 'durable recovery lost its capture fence'
    );
  }
  return { alreadyApplied, nextGeneration };
}
function assertRetainedBranch(rows, rewind) {
  if (rows.length !== Number(rewind.depth + 1n)) {
    throw recoveryError(
      'capture_recovery_below_retention', 'canonical recovery range is not retained'
    );
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expectedNumber = rewind.ancestor + BigInt(index);
    const expectedParent = index === 0 ? null : rows[index - 1].block_hash;
    if (row.block_number !== expectedNumber.toString()
        || (expectedParent && row.parent_hash !== expectedParent)) {
      throw recoveryError(
        'capture_recovery_below_retention', 'canonical recovery range is discontinuous'
      );
    }
  }
  if (rows[0].block_hash !== rewind.ancestorHash
      || rows.at(-1).block_hash !== rewind.checkpointHash
      || rows.slice(1).some(({ finality }) => finality !== 'observed')) {
    throw recoveryError(
      'capture_recovery_fence_conflict', 'canonical recovery evidence changed'
    );
  }
}

function createRobinhoodChainRecoveryJournal(options = {}) {
  const database = options.database || db;
  const tradeLifecycle = options.tradeLifecycle
    || createRobinhoodWalletSwapRealtimeOutboxRepository({ database });
  const marketRollback = options.marketRollback || createRobinhoodMarketReorgRollback();

  async function recordDetected(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('transactional recovery journal client is required');
    }
    const normalized = recoveryPlan(input.plan);
    const detectedAt = timestamp(input.detectedAt);
    const recovery = await client.query(
      `INSERT INTO robinhood_chain_recoveries(
         chain, generation, status, plan, detected_at
       ) VALUES ($1,$2::bigint,'detected',$3::jsonb,$4::timestamptz)
       ON CONFLICT (chain, generation) DO UPDATE
         SET updated_at=NOW()
       WHERE robinhood_chain_recoveries.plan=EXCLUDED.plan
       RETURNING status`,
      [CHAIN, normalized.generation, JSON.stringify(normalized.plan), detectedAt]
    );
    if (recovery.rowCount !== 1) {
      const error = new Error('recovery generation already has a different durable plan');
      error.code = 'capture_recovery_journal_conflict';
      throw error;
    }
    const payload = {
      type: 'chain:reorg:detected', generation: normalized.generation,
      detectedAt, plan: normalized.plan,
    };
    const event = await client.query(
      `INSERT INTO robinhood_chain_recovery_outbox(
         chain, generation, event_kind, payload
       ) VALUES ($1,$2::bigint,'detected',$3::jsonb)
       ON CONFLICT (chain, generation, event_kind, event_key) DO NOTHING
       RETURNING generation`,
      [CHAIN, normalized.generation, JSON.stringify(payload)]
    );
    if (event.rowCount === 1) {
      await client.query('SELECT pg_notify($1,$2)', [NOTIFY_CHANNEL, normalized.generation]);
    }
    return { status: recovery.rows[0].status, eventInserted: event.rowCount === 1 };
  }

  async function get(recoveryGeneration) {
    const result = await database.query(
      `SELECT generation, status, plan, detected_at, rewound_at,
              completed_at, last_error, created_at, updated_at
         FROM robinhood_chain_recoveries
        WHERE chain=$1 AND generation=$2::bigint`, [CHAIN, generation(recoveryGeneration)]
    );
    return result.rows[0] || null;
  }

  async function rewindCanonical(input = {}) {
    const recoveryGeneration = generation(input.generation);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const state = await client.query(
        `SELECT recovery.status, recovery.plan,
                cursor.generation::text AS cursor_generation,
                cursor.recovery_state, cursor.recovery_plan,
                recovery.plan = cursor.recovery_plan AS same_plan,
                cursor.checkpoint_block::text, cursor.checkpoint_hash,
                cursor.finalized_head::text
           FROM robinhood_chain_recoveries recovery
           INNER JOIN robinhood_chain_capture_cursor cursor ON cursor.chain=recovery.chain
          WHERE recovery.chain=$1 AND recovery.generation=$2::bigint
          FOR UPDATE OF recovery, cursor`, [CHAIN, recoveryGeneration]
      );
      if (!state.rowCount) {
        throw recoveryError('capture_recovery_not_found', 'durable recovery was not found');
      }
      const current = state.rows[0];
      const rewind = canonicalRewindPlan(current.plan, recoveryGeneration);
      const disposition = rewindDisposition(current, rewind, recoveryGeneration);
      if (disposition.alreadyApplied) {
        await client.query('COMMIT');
        return { status: 'already-rewound', generation: recoveryGeneration,
          nextGeneration: disposition.nextGeneration };
      }
      if (current.finalized_head != null
          && rewind.ancestor < BigInt(current.finalized_head)) {
        throw recoveryError(
          'capture_recovery_finalized_boundary', 'recovery crosses the finalized boundary'
        );
      }
      const branch = await client.query(
        `SELECT block_number::text, block_hash, parent_hash, finality
           FROM robinhood_chain_blocks
          WHERE chain=$1 AND canonical=TRUE
            AND block_number BETWEEN $2::bigint AND $3::bigint
          ORDER BY block_number`,
        [CHAIN, rewind.ancestor.toString(), rewind.checkpoint.toString()]
      );
      assertRetainedBranch(branch.rows, rewind);
      const tradeInvalidations = await tradeLifecycle.appendOrphanInvalidations(client, {
        generation: recoveryGeneration,
        fromBlock: rewind.fromBlock.toString(), throughBlock: rewind.throughBlock.toString(),
      });
      const market = await marketRollback.rollback(client, {
        fromBlock: rewind.fromBlock.toString(), throughBlock: rewind.throughBlock.toString(),
      });
      const orphaned = await client.query(
        `UPDATE robinhood_chain_blocks SET canonical=FALSE
          WHERE chain=$1 AND canonical=TRUE
            AND block_number BETWEEN $2::bigint AND $3::bigint`,
        [CHAIN, rewind.fromBlock.toString(), rewind.throughBlock.toString()]
      );
      if (orphaned.rowCount !== Number(rewind.depth)) {
        throw recoveryError('capture_recovery_fence_conflict', 'orphan branch changed');
      }
      const cursor = await client.query(
        `UPDATE robinhood_chain_capture_cursor
            SET next_block=$3::bigint, checkpoint_block=$2::bigint, checkpoint_hash=$4,
                generation=generation + 1, version=version + 1, updated_at=NOW()
          WHERE chain=$1 AND generation=$5::bigint AND recovery_state='recovery_required'
            AND checkpoint_block=$6::bigint AND checkpoint_hash=$7
          RETURNING generation::text`,
        [CHAIN, rewind.ancestor.toString(), rewind.fromBlock.toString(), rewind.ancestorHash,
          recoveryGeneration, rewind.checkpoint.toString(), rewind.checkpointHash]
      );
      if (cursor.rowCount !== 1
          || cursor.rows[0].generation !== disposition.nextGeneration) {
        throw recoveryError('capture_recovery_fence_conflict', 'capture rewind was rejected');
      }
      const payload = {
        type: 'chain:reorg:rewound', generation: recoveryGeneration,
        nextGeneration: disposition.nextGeneration,
        status: 'rewound', orphanedRange: {
          fromBlock: rewind.fromBlock.toString(), throughBlock: rewind.throughBlock.toString(),
          depth: rewind.depth.toString(),
        },
        ancestor: current.plan.ancestor, oldCheckpoint: current.plan.checkpoint,
        replacementCheckpointHash: rewind.replacementCheckpointHash,
      };
      await client.query(
        `UPDATE robinhood_chain_recoveries
            SET status='rewound', rewound_at=NOW(), updated_at=NOW()
          WHERE chain=$1 AND generation=$2::bigint AND status='detected'`,
        [CHAIN, recoveryGeneration]
      );
      await client.query(
        `INSERT INTO robinhood_chain_recovery_outbox(
           chain, generation, event_kind, payload
         ) VALUES ($1,$2::bigint,'rewound',$3::jsonb)
         ON CONFLICT (chain, generation, event_kind, event_key) DO NOTHING`,
        [CHAIN, recoveryGeneration, JSON.stringify(payload)]
      );
      await client.query('SELECT pg_notify($1,$2)', [NOTIFY_CHANNEL, recoveryGeneration]);
      await client.query('COMMIT');
      return {
        status: 'rewound', generation: recoveryGeneration,
        nextGeneration: disposition.nextGeneration,
        orphanedBlocks: Number(rewind.depth), tradeInvalidations, market,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ get, recordDetected, rewindCanonical });
}

module.exports = {
  NOTIFY_CHANNEL, createRobinhoodChainRecoveryJournal,
  __private: {
    assertRetainedBranch, canonicalRewindPlan, generation, recoveryPlan, timestamp,
  },
};
