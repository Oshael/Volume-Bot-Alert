const db = require('./db');

const CHAIN = 'robinhood';

function timestamp(value, label) {
  if (value == null || String(value).trim() === '') throw new Error(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function integer(value, label, minimum = 0) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is invalid`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} is invalid`);
  return parsed;
}

function runRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id), status: row.status,
    catalogCutoff: row.catalog_cutoff?.toISOString?.() || row.catalog_cutoff,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    nextBlock: String(row.next_block),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash,
    barrierBlock: row.barrier_block == null ? null : String(row.barrier_block),
    barrierCheckpoint: row.barrier_checkpoint_block == null ? null : Object.freeze({
      number: String(row.barrier_checkpoint_block), hash: row.barrier_checkpoint_hash,
    }),
    cohortTokenCount: String(row.cohort_token_count),
    completedAt: row.completed_at?.toISOString?.() || row.completed_at || null,
    telemetry: Object.freeze(row.telemetry || {}), version: String(row.version),
  });
}

function normalizeHandoffInput(input = {}) {
  const limit = integer(input.limit ?? 1000, 'limit', 1);
  if (limit > 5000) throw new Error('limit must not exceed 5000');
  const checkpointHash = String(input.verifiedCheckpoint?.hash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(checkpointHash)) throw new Error('checkpoint.hash is invalid');
  return Object.freeze({
    runId: integer(input.runId, 'runId', 1),
    version: integer(input.version, 'version'), limit,
    checkpointNumber: integer(input.verifiedCheckpoint?.number, 'checkpoint.number'),
    checkpointHash, finalizedThrough: integer(input.finalizedThrough, 'finalizedThrough'),
  });
}

function assertVerifiedBarrier(run, input) {
  if (run && String(run.next_block) === String(run.barrier_block)
      && String(run.checkpoint_block) === String(run.barrier_checkpoint_block)
      && run.checkpoint_hash === run.barrier_checkpoint_hash
      && String(input.checkpointNumber) === String(run.barrier_checkpoint_block)
      && input.checkpointHash === run.barrier_checkpoint_hash
      && BigInt(input.finalizedThrough) >= BigInt(run.barrier_checkpoint_block)) return;
  const error = new Error('Robinhood holder global barrier is not verified and final');
  error.code = 'holder_global_backfill_barrier_unverified';
  throw error;
}

function assertLiveCoverage(run, cursor) {
  const exactCursor = String(run.barrier_block) !== String(cursor?.next_block)
    || (String(run.barrier_checkpoint_block) === String(cursor?.checkpoint_block)
      && run.barrier_checkpoint_hash === cursor?.checkpoint_hash);
  if (cursor?.journal_floor_block != null
      && BigInt(run.barrier_block) >= BigInt(cursor.journal_floor_block)
      && BigInt(run.barrier_block) <= BigInt(cursor.next_block) && exactCursor) return;
  const error = new Error('Robinhood holder global handoff is outside live coverage');
  error.code = 'holder_global_backfill_handoff_unavailable';
  throw error;
}

function createRobinhoodHolderGlobalBackfillRepository(options = {}) {
  const database = options.database || db;

  async function createRun(input = {}) {
    const catalogCutoff = timestamp(input.catalogCutoff, 'catalogCutoff');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE robinhood_holder_global_backfill_runs IN SHARE ROW EXCLUSIVE MODE');
      const active = await client.query(
        `SELECT id FROM robinhood_holder_global_backfill_runs
          WHERE chain = $1 AND status <> 'completed' LIMIT 1`, [CHAIN]
      );
      if (active.rowCount) {
        const error = new Error('Robinhood holder global backfill already has an active run');
        error.code = 'holder_global_backfill_active_run_exists';
        throw error;
      }
      const inserted = await client.query(
        `INSERT INTO robinhood_holder_global_backfill_runs (chain, catalog_cutoff)
         VALUES ($1, $2) RETURNING *`, [CHAIN, catalogCutoff]
      );
      const runId = inserted.rows[0].id;
      const cohort = await client.query(
        `INSERT INTO robinhood_holder_global_backfill_tokens (run_id, chain, token_address)
         SELECT $1, catalog.chain, catalog.address
           FROM token_catalog catalog
          WHERE catalog.chain = $2 AND catalog.first_seen_at < $3
            AND NOT EXISTS (
              SELECT 1 FROM robinhood_holder_token_states state
               WHERE state.chain = catalog.chain AND state.token_address = catalog.address
            )
          ORDER BY catalog.address
         RETURNING token_address`,
        [runId, CHAIN, catalogCutoff]
      );
      const updated = await client.query(
        `UPDATE robinhood_holder_global_backfill_runs
            SET cohort_token_count = $2, updated_at = NOW()
          WHERE id = $1 RETURNING *`, [runId, cohort.rowCount]
      );
      await client.query('COMMIT');
      return runRow(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function getActiveRun() {
    const result = await database.query(
      `SELECT * FROM robinhood_holder_global_backfill_runs
        WHERE chain = $1 AND status <> 'completed' ORDER BY id DESC LIMIT 1`, [CHAIN]
    );
    return runRow(result.rows[0]);
  }

  async function getLatestRun() {
    const result = await database.query(
      `SELECT * FROM robinhood_holder_global_backfill_runs
        WHERE chain = $1 ORDER BY id DESC LIMIT 1`, [CHAIN]
    );
    return runRow(result.rows[0]);
  }

  async function loadCohort(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const result = await database.query(
      `SELECT token_address FROM robinhood_holder_global_backfill_tokens
        WHERE run_id = $1 AND chain = $2 AND status = 'active'
        ORDER BY token_address`, [runId, CHAIN]
    );
    return Object.freeze(result.rows.map((row) => row.token_address));
  }

  async function loadCohortSchedule(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const result = await database.query(
      `SELECT token.token_address, attribution.attribution_block AS deployment_block,
              attribution.source AS attribution_source
         FROM robinhood_holder_global_backfill_tokens token
         LEFT JOIN robinhood_token_attributions attribution
           ON attribution.chain = token.chain
          AND attribution.token_address = token.token_address
        WHERE token.run_id = $1 AND token.chain = $2 AND token.status = 'active'
        ORDER BY attribution.attribution_block, token.token_address`,
      [runId, CHAIN]
    );
    const unavailable = result.rows.find((row) => (
      ![
        'blockscout_internal', 'rpc_code_transition', 'rpc_direct', 'rpc_trace',
        'launchpad_event',
      ].includes(row.attribution_source)
        || !/^\d+$/.test(String(row.deployment_block ?? ''))
    ));
    if (unavailable) {
      const error = new Error(`global holder cohort deployment unavailable for ${unavailable.token_address}`);
      error.code = 'holder_global_backfill_deployment_unavailable';
      throw error;
    }
    return Object.freeze(result.rows.map((row) => Object.freeze({
      tokenAddress: row.token_address,
      deploymentBlock: String(row.deployment_block),
    })));
  }

  async function startRun(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const version = integer(input.version, 'version');
    const result = await database.query(
      `UPDATE robinhood_holder_global_backfill_runs
          SET status = 'scanning', version = version + 1, updated_at = NOW()
        WHERE id = $1 AND chain = $2 AND status = 'frozen' AND version = $3
        RETURNING *`, [runId, CHAIN, version]
    );
    if (!result.rowCount) {
      const error = new Error('Robinhood holder global backfill run is stale or unavailable');
      error.code = 'holder_global_backfill_run_stale';
      throw error;
    }
    return runRow(result.rows[0]);
  }

  async function attachToLive(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const version = integer(input.version, 'version');
    const attachWindow = integer(input.attachWindow ?? 10_000, 'attachWindow', 1);
    if (attachWindow >= 20_000) throw new Error('attachWindow must be below journal retention');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const cursorResult = await client.query(
        `SELECT next_block, checkpoint_block, checkpoint_hash, version
           FROM robinhood_holder_cursors
          WHERE chain = $1 AND stream = 'live' FOR UPDATE`, [CHAIN]
      );
      const cursor = cursorResult.rows[0];
      if (!cursor || cursor.checkpoint_block == null || cursor.checkpoint_hash == null
          || BigInt(cursor.checkpoint_block) + 1n !== BigInt(cursor.next_block)) {
        const error = new Error('Robinhood holder live cursor is unavailable or inconsistent');
        error.code = 'holder_global_backfill_live_cursor_unavailable';
        throw error;
      }
      const runResult = await client.query(
        `SELECT * FROM robinhood_holder_global_backfill_runs
          WHERE id = $1 AND chain = $2 AND status = 'scanning' AND version = $3
          FOR UPDATE`, [runId, CHAIN, version]
      );
      const run = runResult.rows[0];
      const distance = run ? BigInt(cursor.next_block) - BigInt(run.next_block) : -1n;
      if (!run || distance < 0n || distance > BigInt(attachWindow)) {
        const error = new Error('Robinhood holder global backfill is stale or outside attach window');
        error.code = 'holder_global_backfill_attach_unavailable';
        throw error;
      }
      const attached = await client.query(
        `UPDATE robinhood_holder_global_backfill_runs
            SET status = 'attached', barrier_block = $4,
                barrier_checkpoint_block = $5, barrier_checkpoint_hash = $6,
                barrier_attached_at = NOW(), version = version + 1, updated_at = NOW()
          WHERE id = $1 AND chain = $2 AND version = $3 RETURNING *`,
        [runId, CHAIN, version, cursor.next_block,
          cursor.checkpoint_block, cursor.checkpoint_hash]
      );
      const fenced = await client.query(
        `UPDATE robinhood_holder_cursors
            SET version = version + 1, updated_at = NOW()
          WHERE chain = $1 AND stream = 'live' AND version = $2 RETURNING version`,
        [CHAIN, cursor.version]
      );
      if (!fenced.rowCount) throw new Error('Robinhood holder live cursor changed while locked');
      await client.query('COMMIT');
      return Object.freeze({
        ...runRow(attached.rows[0]), liveCursorVersion: Number(fenced.rows[0].version),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function getMaterializationCandidate() {
    const result = await database.query(
      `SELECT * FROM robinhood_holder_global_backfill_runs
        WHERE chain = $1 AND status IN ('attached', 'materializing')
          AND EXISTS (
            SELECT 1 FROM robinhood_holder_global_backfill_tokens token
             WHERE token.run_id = robinhood_holder_global_backfill_runs.id
               AND token.chain = $1 AND token.status = 'active'
          )
        ORDER BY id DESC LIMIT 1`, [CHAIN]
    );
    return runRow(result.rows[0]);
  }

  async function getMaterializedHandoffCandidate() {
    const result = await database.query(
      `SELECT * FROM robinhood_holder_global_backfill_runs run
        WHERE run.chain = $1 AND run.status = 'materializing'
          AND EXISTS (
            SELECT 1 FROM robinhood_holder_global_backfill_tokens token
            INNER JOIN robinhood_holder_token_states state
              ON state.chain = token.chain AND state.token_address = token.token_address
            WHERE token.run_id = run.id AND token.chain = $1
              AND token.status = 'materialized' AND state.ledger_status = 'backfilling'
          )
        ORDER BY run.id DESC LIMIT 1`, [CHAIN]
    );
    return runRow(result.rows[0]);
  }

  async function materializeBatch(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const version = integer(input.version, 'version');
    const limit = integer(input.limit ?? 1000, 'limit', 1);
    if (limit > 5000) throw new Error('limit must not exceed 5000');
    const checkpointNumber = integer(input.verifiedCheckpoint?.number, 'checkpoint.number');
    const checkpointHash = String(input.verifiedCheckpoint?.hash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(checkpointHash)) throw new Error('checkpoint.hash is invalid');
    const finalizedThrough = integer(input.finalizedThrough, 'finalizedThrough');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT * FROM robinhood_holder_global_backfill_runs
          WHERE id = $1 AND chain = $2 AND status IN ('attached', 'materializing')
            AND version = $3 FOR UPDATE`, [runId, CHAIN, version]
      );
      const run = locked.rows[0];
      if (!run || String(run.next_block) !== String(run.barrier_block)
          || String(run.checkpoint_block) !== String(run.barrier_checkpoint_block)
          || run.checkpoint_hash !== run.barrier_checkpoint_hash
          || String(checkpointNumber) !== String(run.barrier_checkpoint_block)
          || checkpointHash !== run.barrier_checkpoint_hash
          || BigInt(finalizedThrough) < BigInt(run.barrier_checkpoint_block)) {
        const error = new Error('Robinhood holder global barrier is not verified and final');
        error.code = 'holder_global_backfill_barrier_unverified';
        throw error;
      }
      const tokens = await client.query(
        `SELECT token_address FROM robinhood_holder_global_backfill_tokens
          WHERE run_id = $1 AND chain = $2 AND status = 'active'
          ORDER BY token_address LIMIT $3 FOR UPDATE`, [runId, CHAIN, limit]
      );
      const addresses = tokens.rows.map((row) => row.token_address);
      if (addresses.length) {
        const conflicts = await client.query(
          `SELECT token_address FROM robinhood_holder_token_states
            WHERE chain = $1 AND token_address = ANY($2::varchar[]) LIMIT 1`,
          [CHAIN, addresses]
        );
        if (conflicts.rowCount) {
          const error = new Error('Global cohort token already has holder state');
          error.code = 'holder_global_backfill_state_conflict';
          throw error;
        }
        await client.query(
          `INSERT INTO robinhood_holder_token_states (
             chain, token_address, holder_count, ledger_status, deployment_block,
             backfill_next_block, live_through_block, live_through_hash
           ) SELECT chain, token_address, holder_count, 'backfilling', 0,
                    $3, $4, $5
               FROM robinhood_holder_global_backfill_tokens
              WHERE run_id = $1 AND chain = $2 AND token_address = ANY($6::varchar[])
                AND status = 'active'`,
          [runId, CHAIN, run.barrier_block, run.barrier_checkpoint_block,
            run.barrier_checkpoint_hash, addresses]
        );
        await client.query(
          `UPDATE robinhood_holder_global_backfill_tokens
              SET status = 'materialized', updated_at = NOW()
            WHERE run_id = $1 AND chain = $2 AND token_address = ANY($3::varchar[])
              AND status = 'active'`, [runId, CHAIN, addresses]
        );
      }
      const updated = await client.query(
        `UPDATE robinhood_holder_global_backfill_runs
            SET status = 'materializing', version = version + 1, updated_at = NOW()
          WHERE id = $1 RETURNING version`, [runId]
      );
      const remaining = await client.query(
        `SELECT COUNT(*)::int AS count FROM robinhood_holder_global_backfill_tokens
          WHERE run_id = $1 AND chain = $2 AND status = 'active'`, [runId, CHAIN]
      );
      await client.query('COMMIT');
      return Object.freeze({
        status: 'materializing', runId: String(runId), materializedTokens: addresses.length,
        remainingTokens: Number(remaining.rows[0].count), version: String(updated.rows[0].version),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function promoteMaterializedBatch(input = {}) {
    const normalized = normalizeHandoffInput(input);
    const { runId, version, limit } = normalized;
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT * FROM robinhood_holder_global_backfill_runs
          WHERE id = $1 AND chain = $2 AND status = 'materializing'
            AND version = $3 FOR UPDATE`, [runId, CHAIN, version]
      );
      const run = locked.rows[0];
      assertVerifiedBarrier(run, normalized);
      const cursorResult = await client.query(
        `SELECT next_block, checkpoint_block, checkpoint_hash, journal_floor_block
           FROM robinhood_holder_cursors
          WHERE chain = $1 AND stream = 'live' FOR UPDATE`, [CHAIN]
      );
      const cursor = cursorResult.rows[0];
      assertLiveCoverage(run, cursor);
      const candidates = await client.query(
        `SELECT token.token_address
           FROM robinhood_holder_global_backfill_tokens token
           INNER JOIN robinhood_holder_token_states state
             ON state.chain = token.chain AND state.token_address = token.token_address
          WHERE token.run_id = $1 AND token.chain = $2 AND token.status = 'materialized'
            AND state.ledger_status = 'backfilling'
            AND state.backfill_next_block = $3
            AND state.live_through_block = $4 AND state.live_through_hash = $5
            AND NOT EXISTS (
              SELECT 1 FROM robinhood_holder_transfer_journal journal
               WHERE journal.chain = state.chain AND journal.token_address = state.token_address
                 AND journal.block_number < $3 AND journal.applied = true
            )
          ORDER BY token.token_address LIMIT $6
          FOR UPDATE OF token, state SKIP LOCKED`,
        [runId, CHAIN, run.barrier_block, run.barrier_checkpoint_block,
          run.barrier_checkpoint_hash, limit]
      );
      const addresses = candidates.rows.map((row) => row.token_address);
      if (addresses.length) {
        await client.query(
          `DELETE FROM robinhood_holder_transfer_journal
            WHERE chain = $1 AND token_address = ANY($2::varchar[])
              AND block_number < $3 AND applied = false`,
          [CHAIN, addresses, run.barrier_block]
        );
        const promoted = await client.query(
          `UPDATE robinhood_holder_token_states
              SET ledger_status = 'shadow', version = version + 1, updated_at = NOW()
            WHERE chain = $1 AND token_address = ANY($2::varchar[])
              AND ledger_status = 'backfilling' AND backfill_next_block = $3
              AND live_through_block = $4 AND live_through_hash = $5
            RETURNING token_address`,
          [CHAIN, addresses, run.barrier_block, run.barrier_checkpoint_block,
            run.barrier_checkpoint_hash]
        );
        if (promoted.rowCount !== addresses.length) {
          throw new Error('Global holder handoff batch changed while locked');
        }
      }
      const updated = await client.query(
        `UPDATE robinhood_holder_global_backfill_runs
            SET version = version + 1, updated_at = NOW()
          WHERE id = $1 RETURNING version`, [runId]
      );
      await client.query('COMMIT');
      return Object.freeze({
        status: addresses.length ? 'handed-off' : 'idle', runId: String(runId),
        handedOffTokens: addresses.length, version: String(updated.rows[0].version),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function syncCompletion(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const result = await database.query(
      `WITH promoted AS (
         UPDATE robinhood_holder_global_backfill_tokens token
            SET status = 'completed', updated_at = NOW()
           FROM robinhood_holder_token_states state
          WHERE token.run_id = $1 AND token.chain = $2 AND token.status = 'materialized'
            AND state.chain = token.chain AND state.token_address = token.token_address
            AND state.ledger_status IN ('shadow', 'live')
         RETURNING token.token_address
       ), counts AS MATERIALIZED (
        SELECT COUNT(*) FILTER (WHERE token.status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE token.status = 'materialized'
                  AND (state.ledger_status IS NULL
                    OR state.ledger_status NOT IN ('shadow', 'live')))::int AS materialized,
                COUNT(*) FILTER (WHERE token.status = 'completed' OR token.status = 'materialized'
                  AND state.ledger_status IN ('shadow', 'live'))::int AS completed,
                COUNT(*) FILTER (WHERE token.status = 'excluded')::int AS excluded,
                COUNT(*) FILTER (WHERE token.status = 'materialized'
                  AND state.ledger_status IN ('drifted', 'resyncing'))::int AS failed
           FROM robinhood_holder_global_backfill_tokens token
           LEFT JOIN robinhood_holder_token_states state
             ON state.chain = token.chain AND state.token_address = token.token_address
          WHERE token.run_id = $1 AND token.chain = $2
       )
       UPDATE robinhood_holder_global_backfill_runs run
          SET status = CASE WHEN counts.active = 0 AND counts.materialized = 0
                 THEN 'completed' ELSE run.status END,
              completed_at = CASE WHEN counts.active = 0 AND counts.materialized = 0
                 THEN NOW() ELSE NULL END,
              version = version + 1, updated_at = NOW()
         FROM counts
        WHERE run.id = $1 AND run.chain = $2 AND run.status = 'materializing'
       RETURNING run.status, counts.*, (SELECT COUNT(*)::int FROM promoted) AS promoted`,
      [runId, CHAIN]
    );
    if (!result.rowCount) throw new Error('Global holder run is unavailable for completion');
    const row = result.rows[0];
    return Object.freeze({
      status: row.status, runId: String(runId), promotedTokens: Number(row.promoted),
      activeTokens: Number(row.active), materializedTokens: Number(row.materialized),
      completedTokens: Number(row.completed), excludedTokens: Number(row.excluded),
      failedTokens: Number(row.failed),
    });
  }

  async function recordTelemetry(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    if (!input.telemetry || typeof input.telemetry !== 'object' || Array.isArray(input.telemetry)) {
      throw new Error('telemetry is invalid');
    }
    await database.query(
      `UPDATE robinhood_holder_global_backfill_runs
          SET telemetry = $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND chain = $2`, [runId, CHAIN, JSON.stringify(input.telemetry)]
    );
  }

  return Object.freeze({
    attachToLive, createRun, getActiveRun, getLatestRun, getMaterializationCandidate,
    getMaterializedHandoffCandidate, loadCohort, loadCohortSchedule, materializeBatch,
    promoteMaterializedBatch, recordTelemetry, startRun, syncCompletion,
  });
}

module.exports = {
  createRobinhoodHolderGlobalBackfillRepository,
  __private: { integer, runRow, timestamp },
};
