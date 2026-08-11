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
    nextBlock: String(row.next_block),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash,
    barrierBlock: row.barrier_block == null ? null : String(row.barrier_block),
    barrierCheckpoint: row.barrier_checkpoint_block == null ? null : Object.freeze({
      number: String(row.barrier_checkpoint_block), hash: row.barrier_checkpoint_hash,
    }),
    cohortTokenCount: String(row.cohort_token_count),
    telemetry: Object.freeze(row.telemetry || {}), version: String(row.version),
  });
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

  async function loadCohort(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const result = await database.query(
      `SELECT token_address FROM robinhood_holder_global_backfill_tokens
        WHERE run_id = $1 AND chain = $2 AND status = 'active'
        ORDER BY token_address`, [runId, CHAIN]
    );
    return Object.freeze(result.rows.map((row) => row.token_address));
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

  return Object.freeze({
    attachToLive, createRun, getActiveRun, getMaterializationCandidate,
    loadCohort, materializeBatch, startRun,
  });
}

module.exports = {
  createRobinhoodHolderGlobalBackfillRepository,
  __private: { integer, runRow, timestamp },
};
