const db = require('./db');

const CHAIN = 'robinhood';
const EXACT_SOURCES = Object.freeze(['rpc_direct', 'launchpad_event']);
const CANDIDATES_SQL = `
  SELECT catalog.address AS token_address,
         COALESCE(state.deployment_block, attribution.attribution_block)::bigint
           AS deployment_block,
         state.token_address IS NOT NULL AS adopted
    FROM token_catalog catalog
    INNER JOIN robinhood_token_attributions attribution
      ON attribution.chain = catalog.chain AND attribution.token_address = catalog.address
    LEFT JOIN robinhood_holder_token_states state
      ON state.chain = catalog.chain AND state.token_address = catalog.address
   WHERE catalog.chain = $1 AND catalog.first_seen_at < $2::timestamptz
     AND attribution.source = ANY($3::varchar[])
     AND attribution.attribution_block IS NOT NULL
     AND (state.token_address IS NULL OR state.ledger_status = 'backfilling')
     AND NOT EXISTS (
       SELECT 1 FROM robinhood_holder_global_backfill_tokens prior
        WHERE prior.chain = catalog.chain AND prior.token_address = catalog.address
          AND prior.status = 'excluded'
     )
   ORDER BY catalog.address`;

function cutoffTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('delta catalogCutoff is invalid');
  return parsed.toISOString();
}

function summary(row) {
  if (!row) return null;
  return Object.freeze({
    candidateTokens: Number(row.candidate_tokens),
    unseededTokens: Number(row.unseeded_tokens),
    adoptedBackfillingTokens: Number(row.adopted_backfilling_tokens),
    startBlock: row.start_block == null ? null : String(row.start_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    scanBlocks: row.scan_blocks == null ? null : String(row.scan_blocks),
    balanceRows: Number(row.balance_rows),
    journalEvents: Number(row.journal_events),
  });
}

function createRobinhoodHolderGlobalDeltaRepository(options = {}) {
  const database = options.database || db;

  async function previewRun(input = {}) {
    const cutoff = cutoffTimestamp(input.catalogCutoff);
    const result = await database.query(
      `WITH candidates AS MATERIALIZED (${CANDIDATES_SQL})
       SELECT COUNT(*)::int AS candidate_tokens,
              COUNT(*) FILTER (WHERE NOT adopted)::int AS unseeded_tokens,
              COUNT(*) FILTER (WHERE adopted)::int AS adopted_backfilling_tokens,
              MIN(deployment_block) AS start_block,
              cursor.safe_head,
              CASE WHEN MIN(deployment_block) IS NULL OR cursor.safe_head IS NULL THEN NULL
                ELSE GREATEST(cursor.safe_head - MIN(deployment_block) + 1, 0) END AS scan_blocks,
              (SELECT COUNT(*) FROM robinhood_holder_balances balance
                INNER JOIN candidates item ON item.token_address = balance.token_address
               WHERE balance.chain = $1)::int AS balance_rows,
              (SELECT COUNT(*) FROM robinhood_holder_transfer_journal journal
                INNER JOIN candidates item ON item.token_address = journal.token_address
               WHERE journal.chain = $1)::int AS journal_events
         FROM candidates
         LEFT JOIN robinhood_holder_cursors cursor
           ON cursor.chain = $1 AND cursor.stream = 'live'
        GROUP BY cursor.safe_head`,
      [CHAIN, cutoff, [...EXACT_SOURCES]]
    );
    return summary(result.rows[0]);
  }

  async function createRun(input = {}) {
    const cutoff = cutoffTimestamp(input.catalogCutoff);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        'LOCK TABLE robinhood_holder_global_backfill_runs IN SHARE ROW EXCLUSIVE MODE'
      );
      const active = await client.query(
        `SELECT id FROM robinhood_holder_global_backfill_runs
          WHERE chain = $1 AND status <> 'completed' LIMIT 1`, [CHAIN]
      );
      if (active.rowCount) {
        const error = new Error('Robinhood holder global backfill already has an active run');
        error.code = 'holder_global_backfill_active_run_exists';
        throw error;
      }
      const cursor = await client.query(
        `SELECT safe_head FROM robinhood_holder_cursors
          WHERE chain = $1 AND stream = 'live' FOR UPDATE`, [CHAIN]
      );
      if (!cursor.rowCount) {
        const error = new Error('Robinhood holder live cursor is required for delta adoption');
        error.code = 'holder_global_delta_live_cursor_missing';
        throw error;
      }
      const candidates = await client.query(
        `${CANDIDATES_SQL} FOR UPDATE OF catalog, attribution`,
        [CHAIN, cutoff, [...EXACT_SOURCES]]
      );
      if (!candidates.rowCount) {
        const error = new Error('Robinhood holder global delta has no eligible tokens');
        error.code = 'holder_global_delta_empty';
        throw error;
      }
      const addresses = candidates.rows.map((row) => row.token_address);
      const adopted = candidates.rows.filter((row) => row.adopted).length;
      const startBlock = candidates.rows.reduce((minimum, row) => (
        minimum === null || BigInt(row.deployment_block) < minimum
          ? BigInt(row.deployment_block) : minimum
      ), null).toString();
      await client.query(
        `SELECT token_address FROM robinhood_holder_token_states
          WHERE chain = $1 AND token_address = ANY($2::varchar[]) FOR UPDATE`,
        [CHAIN, addresses]
      );
      const inserted = await client.query(
         `INSERT INTO robinhood_holder_global_backfill_runs (
           chain, catalog_cutoff, next_block, telemetry
         ) VALUES ($1, $2, $3::bigint,
                   jsonb_build_object('startBlock', ($3::bigint)::text))
         RETURNING id`, [CHAIN, cutoff, startBlock]
      );
      const runId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_tokens (run_id, chain, token_address)
         SELECT $1, $2, unnest($3::varchar[])`, [runId, CHAIN, addresses]
      );
      const journal = await client.query(
        `DELETE FROM robinhood_holder_transfer_journal
          WHERE chain = $1 AND token_address = ANY($2::varchar[])`, [CHAIN, addresses]
      );
      const balances = await client.query(
        `DELETE FROM robinhood_holder_balances
          WHERE chain = $1 AND token_address = ANY($2::varchar[])`, [CHAIN, addresses]
      );
      const states = await client.query(
        `DELETE FROM robinhood_holder_token_states
          WHERE chain = $1 AND token_address = ANY($2::varchar[])`, [CHAIN, addresses]
      );
      if (states.rowCount !== adopted) throw new Error('Delta holder state adoption changed while locked');
      await client.query(
        `UPDATE robinhood_holder_global_backfill_runs
            SET cohort_token_count = $2, updated_at = NOW()
          WHERE id = $1`, [runId, addresses.length]
      );
      await client.query(
        `UPDATE robinhood_holder_cursors
            SET version = version + 1, updated_at = NOW()
          WHERE chain = $1 AND stream = 'live'`, [CHAIN]
      );
      await client.query('COMMIT');
      return Object.freeze({
        runId: String(runId), status: 'frozen', catalogCutoff: cutoff,
        cohortTokens: addresses.length, adoptedBackfillingTokens: adopted,
        unseededTokens: addresses.length - adopted, startBlock,
        safeHead: cursor.rows[0].safe_head == null ? null : String(cursor.rows[0].safe_head),
        deletedBalances: balances.rowCount, deletedJournalEvents: journal.rowCount,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ createRun, previewRun });
}

module.exports = { createRobinhoodHolderGlobalDeltaRepository };
