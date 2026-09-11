'use strict';

const db = require('./db');
const {
  createRobinhoodWalletSwapRealtimeOutboxRepository,
} = require('./robinhood-wallet-swap-realtime-outbox');
const { createRobinhoodMarketReorgRollback } = require('./robinhood-market-reorg-rollback');
const { createRobinhoodWalletReorgRollback } = require('./robinhood-wallet-reorg-rollback');
const {
  createRobinhoodWalletTransferReorgRollback,
} = require('./robinhood-wallet-transfer-reorg-rollback');
const { createRobinhoodLiquidityReorgRollback } = require('./robinhood-liquidity-reorg-rollback');
const {
  ROLLBACK_DOMAINS, ROLLBACK_MANIFEST_VERSION,
} = require('../services/robinhood-chain-recovery-planner');

const CHAIN = 'robinhood';
const NOTIFY_CHANNEL = 'robinhood_chain_recovery_outbox';
const DOMAIN_IDS = Object.freeze(ROLLBACK_DOMAINS.map(({ id }) => id));

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
function domain(value) {
  const normalized = String(value || '').trim();
  if (!DOMAIN_IDS.includes(normalized)) throw new Error('recovery domain is invalid');
  return normalized;
}
function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recovery domain evidence is required');
  }
  return value;
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
  if (value.rollbackManifestVersion !== ROLLBACK_MANIFEST_VERSION) {
    throw recoveryError(
      'capture_recovery_manifest_changed', 'recovery rollback manifest changed'
    );
  }
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
  const alreadyApplied = ['rewound', 'awaiting_domains'].includes(current.status)
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

async function appendDomainReady(client, recoveryGeneration, domainId, proof) {
  const payload = {
    type: 'chain:reorg:domain_ready', generation: recoveryGeneration,
    domain: domainId, evidence: proof,
  };
  const result = await client.query(
    `INSERT INTO robinhood_chain_recovery_outbox(
       chain, generation, event_kind, event_key, payload
     ) VALUES ($1,$2::bigint,'domain_ready',$3,$4::jsonb)
     ON CONFLICT (chain, generation, event_kind, event_key) DO UPDATE
       SET updated_at=NOW()
     WHERE robinhood_chain_recovery_outbox.payload=EXCLUDED.payload
     RETURNING event_key`,
    [CHAIN, recoveryGeneration, domainId, JSON.stringify(payload)]
  );
  if (result.rowCount !== 1) {
    throw recoveryError(
      'capture_recovery_domain_conflict', `${domainId} recovery evidence changed`
    );
  }
  await client.query('SELECT pg_notify($1,$2)', [NOTIFY_CHANNEL, recoveryGeneration]);
}

async function readiness(client, recoveryGeneration) {
  const result = await client.query(
    `SELECT event_key FROM robinhood_chain_recovery_outbox
      WHERE chain=$1 AND generation=$2::bigint AND event_kind='domain_ready'
      ORDER BY event_key`, [CHAIN, recoveryGeneration]
  );
  const readyDomains = result.rows.map(({ event_key: value }) => value);
  return {
    readyDomains,
    pendingDomains: DOMAIN_IDS.filter((value) => !readyDomains.includes(value)),
  };
}

function createRobinhoodChainRecoveryJournal(options = {}) {
  const database = options.database || db;
  const tradeLifecycle = options.tradeLifecycle
    || createRobinhoodWalletSwapRealtimeOutboxRepository({ database });
  const marketRollback = options.marketRollback || createRobinhoodMarketReorgRollback();
  const walletRollback = options.walletRollback || createRobinhoodWalletReorgRollback();
  const transferRollback = options.transferRollback
    || createRobinhoodWalletTransferReorgRollback();
  const liquidityRollback = options.liquidityRollback || createRobinhoodLiquidityReorgRollback();

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

  async function recordDomainReady(input = {}) {
    const recoveryGeneration = generation(input.generation);
    const domainId = domain(input.domain);
    const proof = evidence(input.evidence);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const state = await client.query(
        `SELECT status FROM robinhood_chain_recoveries
          WHERE chain=$1 AND generation=$2::bigint FOR UPDATE`,
        [CHAIN, recoveryGeneration]
      );
      if (!state.rowCount || state.rows[0].status !== 'awaiting_domains') {
        throw recoveryError(
          'capture_recovery_phase_conflict', 'recovery is not awaiting domains'
        );
      }
      await appendDomainReady(client, recoveryGeneration, domainId, proof);
      const result = await readiness(client, recoveryGeneration);
      await client.query('COMMIT');
      return { status: result.pendingDomains.length ? 'awaiting-domains' : 'ready', ...result };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function resumeRecapture(input = {}) {
    const recoveryGeneration = generation(input.generation);
    const nextGeneration = (BigInt(recoveryGeneration) + 1n).toString();
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const state = await client.query(
        `SELECT recovery.status, recovery.plan,
                cursor.generation::text AS cursor_generation,
                cursor.recovery_state, cursor.recovery_plan,
                recovery.plan=cursor.recovery_plan AS same_plan
           FROM robinhood_chain_recoveries recovery
           INNER JOIN robinhood_chain_capture_cursor cursor ON cursor.chain=recovery.chain
          WHERE recovery.chain=$1 AND recovery.generation=$2::bigint
          FOR UPDATE OF recovery, cursor`, [CHAIN, recoveryGeneration]
      );
      const current = state.rows[0];
      if (current?.status === 'recapturing' && current.cursor_generation === nextGeneration
          && current.recovery_state === 'running') {
        await client.query('COMMIT');
        return { status: 'already-recapturing', generation: nextGeneration };
      }
      if (!current || current.status !== 'awaiting_domains'
          || current.cursor_generation !== nextGeneration
          || current.recovery_state !== 'recovery_required' || current.same_plan !== true) {
        throw recoveryError(
          'capture_recovery_phase_conflict', 'recovery cannot resume capture'
        );
      }
      const gates = await readiness(client, recoveryGeneration);
      if (gates.pendingDomains.length) {
        await client.query('COMMIT');
        return { status: 'awaiting-domains', generation: nextGeneration, ...gates };
      }
      const resumed = await client.query(
        `UPDATE robinhood_chain_capture_cursor SET
           recovery_state='running', recovery_plan=NULL, recovery_detected_at=NULL,
           version=version+1, updated_at=NOW()
         WHERE chain=$1 AND generation=$2::bigint AND recovery_state='recovery_required'
           AND recovery_plan=$3::jsonb`,
        [CHAIN, nextGeneration, JSON.stringify(current.plan)]
      );
      if (resumed.rowCount !== 1) {
        throw recoveryError('capture_recovery_fence_conflict', 'capture resume was rejected');
      }
      await client.query(
        `UPDATE robinhood_chain_recoveries SET status='recapturing', updated_at=NOW()
          WHERE chain=$1 AND generation=$2::bigint AND status='awaiting_domains'`,
        [CHAIN, recoveryGeneration]
      );
      await client.query('COMMIT');
      return { status: 'recapturing', generation: nextGeneration, ...gates };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
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
        `SELECT block_number::text, block_hash, parent_hash, finality, block_timestamp
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
      const wallet = await walletRollback.rollback(client, {
        generation: recoveryGeneration,
        ancestorBlock: rewind.ancestor.toString(), ancestorHash: rewind.ancestorHash,
        fromBlock: rewind.fromBlock.toString(), throughBlock: rewind.throughBlock.toString(),
        checkpointHash: rewind.checkpointHash,
      });
      const retained = new Map(branch.rows.map((row) => [row.block_number, row]));
      const walletTransfers = await transferRollback.rollback(client, {
        ancestorBlock: rewind.ancestor.toString(), ancestorHash: rewind.ancestorHash,
        ancestorTimestamp: retained.get(rewind.ancestor.toString()).block_timestamp,
        fromBlock: rewind.fromBlock.toString(), throughBlock: rewind.throughBlock.toString(),
        fromTimestamp: retained.get(rewind.fromBlock.toString()).block_timestamp,
        throughTimestamp: retained.get(rewind.throughBlock.toString()).block_timestamp,
      });
      const liquidity = await liquidityRollback.rollback(client, {
        ancestorBlock: rewind.ancestor.toString(), ancestorHash: rewind.ancestorHash,
        ancestorTimestamp: retained.get(rewind.ancestor.toString()).block_timestamp,
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
      await appendDomainReady(client, recoveryGeneration, 'canonical-journal', {
        orphanedBlocks: Number(rewind.depth), nextGeneration: disposition.nextGeneration,
      });
      await appendDomainReady(client, recoveryGeneration, 'market', market);
      await appendDomainReady(client, recoveryGeneration, 'wallet', wallet);
      await appendDomainReady(client, recoveryGeneration, 'liquidity', liquidity);
      await appendDomainReady(client, recoveryGeneration, 'publication-alerts', {
        tradeInvalidations, finalizedBoundaryPreserved: true,
      });
      await client.query(
        `UPDATE robinhood_chain_recoveries
            SET status='awaiting_domains', rewound_at=NOW(), updated_at=NOW()
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
        orphanedBlocks: Number(rewind.depth), tradeInvalidations, market, wallet,
        walletTransfers, liquidity,
        domainReady: ['canonical-journal', 'liquidity', 'market', 'publication-alerts', 'wallet'],
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    get, recordDetected, recordDomainReady, resumeRecapture, rewindCanonical,
  });
}

module.exports = {
  NOTIFY_CHANNEL, createRobinhoodChainRecoveryJournal,
  __private: {
    appendDomainReady, assertRetainedBranch, canonicalRewindPlan,
    domain, generation, readiness, recoveryPlan, timestamp,
  },
};
