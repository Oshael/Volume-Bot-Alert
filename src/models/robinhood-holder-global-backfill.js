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

  return Object.freeze({ createRun, getActiveRun, loadCohort, startRun });
}

module.exports = {
  createRobinhoodHolderGlobalBackfillRepository,
  __private: { integer, runRow, timestamp },
};
