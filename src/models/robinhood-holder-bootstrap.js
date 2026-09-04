const db = require('./db');

const CHAIN = 'robinhood';
const EXACT_DEPLOYMENT_SOURCES = Object.freeze([
  'blockscout_internal', 'rpc_code_transition', 'rpc_direct', 'rpc_trace', 'launchpad_event',
]);

function normalizeOptions(input = {}) {
  const admittedAfter = new Date(input.admittedAfter);
  if (!Number.isFinite(admittedAfter.getTime())) {
    throw new Error('holderBootstrap.admittedAfter is invalid');
  }
  const limit = input.limit == null ? 100 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('holderBootstrap.limit is invalid');
  }
  const maxInitialGapBlocks = input.maxInitialGapBlocks == null
    ? 20_000 : Number(input.maxInitialGapBlocks);
  if (!Number.isSafeInteger(maxInitialGapBlocks)
      || maxInitialGapBlocks < 1 || maxInitialGapBlocks > 100_000_000) {
    throw new Error('holderBootstrap.maxInitialGapBlocks is invalid');
  }
  return Object.freeze({
    admittedAfter: admittedAfter.toISOString(), limit, maxInitialGapBlocks,
  });
}

function normalizeColdOptions(input = {}) {
  const admittedBefore = new Date(input.admittedBefore);
  if (!Number.isFinite(admittedBefore.getTime())) {
    throw new Error('holderBootstrap.admittedBefore is invalid');
  }
  const limit = input.limit == null ? 25 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('holderBootstrap.limit is invalid');
  }
  return Object.freeze({ admittedBefore: admittedBefore.toISOString(), limit });
}

function normalizeSeededRow(row) {
  return Object.freeze({
    tokenAddress: row.token_address,
    deploymentBlock: String(row.deployment_block),
    backfillNextBlock: String(row.backfill_next_block),
    ledgerStatus: row.ledger_status,
  });
}

function liveCandidatesSql(revalidate = false) {
  return `SELECT catalog.address AS token_address, attribution.attribution_block
    FROM token_catalog catalog
    INNER JOIN robinhood_token_attributions attribution
      ON attribution.chain = catalog.chain AND attribution.token_address = catalog.address
    CROSS JOIN robinhood_holder_cursors cursor
    LEFT JOIN robinhood_holder_token_states state
      ON state.chain = catalog.chain AND state.token_address = catalog.address
   WHERE catalog.chain = $1 AND cursor.chain = $1 AND cursor.stream = 'live'
     ${revalidate ? 'AND catalog.address = ANY($6::varchar[])' : ''}
     AND catalog.first_seen_at >= $2::timestamptz
     AND attribution.source = ANY($3::varchar[])
     AND attribution.attribution_block IS NOT NULL
     AND cursor.safe_head IS NOT NULL
     AND attribution.attribution_block >= GREATEST(cursor.safe_head - $5::bigint + 1, 0)
     AND state.token_address IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM robinhood_holder_global_backfill_tokens cohort
       INNER JOIN robinhood_holder_global_backfill_runs run
         ON run.id = cohort.run_id AND run.chain = cohort.chain
       WHERE cohort.chain = catalog.chain AND cohort.token_address = catalog.address
         AND cohort.status = 'active' AND run.status <> 'completed'
     )
   ORDER BY catalog.first_seen_at, catalog.address
   LIMIT $4::int
   ${revalidate ? 'FOR UPDATE OF attribution SKIP LOCKED' : ''}`;
}

async function admitLiveCandidates(database, params, addresses) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const cursor = await client.query(
      `SELECT 1 FROM robinhood_holder_cursors
        WHERE chain = $1 AND stream = 'live' FOR UPDATE SKIP LOCKED`, [CHAIN]
    );
    if (!cursor.rows.length) {
      await client.query('COMMIT');
      return [];
    }
    // Discovery is only a hint. Re-read every admission condition in a new
    // statement after locking the current cursor; never trust the old floor.
    const result = await client.query(
      `WITH candidates AS MATERIALIZED (${liveCandidatesSql(true)})
       INSERT INTO robinhood_holder_token_states (
         chain, token_address, holder_count, ledger_status,
         deployment_block, backfill_next_block
       )
       SELECT $1, candidate.token_address, 0,
              CASE WHEN cursor.journal_floor_block IS NOT NULL
                         AND cursor.buffer_floor_block IS NOT NULL
                         AND candidate.attribution_block >= GREATEST(
                           cursor.journal_floor_block, cursor.buffer_floor_block
                         )
                   THEN 'shadow' ELSE 'backfilling' END,
              candidate.attribution_block, candidate.attribution_block
         FROM candidates candidate CROSS JOIN robinhood_holder_cursors cursor
        WHERE cursor.chain = $1 AND cursor.stream = 'live'
       ON CONFLICT (chain, token_address) DO NOTHING
       RETURNING token_address, deployment_block, backfill_next_block, ledger_status`,
      [...params, addresses]
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function createRobinhoodHolderBootstrapRepository(options = {}) {
  const database = options.database || db;

  async function seedNewTokens(input = {}) {
    const normalized = normalizeOptions(input);
    const params = [CHAIN, normalized.admittedAfter,
      [...EXACT_DEPLOYMENT_SOURCES], normalized.limit, normalized.maxInitialGapBlocks];
    const candidates = await database.query(liveCandidatesSql(), params);
    if (!candidates.rows.length) return Object.freeze([]);
    const rows = await admitLiveCandidates(
      database, params, candidates.rows.map((row) => row.token_address)
    );
    return Object.freeze(rows.map(normalizeSeededRow));
  }

  async function seedColdTokens(input = {}) {
    const normalized = normalizeColdOptions(input);
    const result = await database.query(
      `WITH candidates AS MATERIALIZED (
         SELECT catalog.address AS token_address, attribution.attribution_block
           FROM token_catalog catalog
           INNER JOIN robinhood_token_attributions attribution
             ON attribution.chain = catalog.chain
            AND attribution.token_address = catalog.address
           LEFT JOIN robinhood_holder_token_states state
             ON state.chain = catalog.chain AND state.token_address = catalog.address
          WHERE catalog.chain = $1
            AND catalog.first_seen_at < $2::timestamptz
            AND attribution.source = ANY($3::varchar[])
            AND attribution.attribution_block IS NOT NULL
            AND state.token_address IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM robinhood_holder_global_backfill_tokens cohort
              INNER JOIN robinhood_holder_global_backfill_runs run
                ON run.id = cohort.run_id AND run.chain = cohort.chain
              WHERE cohort.chain = catalog.chain AND cohort.token_address = catalog.address
                AND cohort.status = 'active' AND run.status <> 'completed'
            )
          ORDER BY catalog.first_seen_at DESC, catalog.address
          LIMIT $4::int
          FOR UPDATE OF attribution SKIP LOCKED
       )
       INSERT INTO robinhood_holder_token_states (
         chain, token_address, holder_count, ledger_status,
         deployment_block, backfill_next_block
       )
       SELECT $1, token_address, 0, 'backfilling',
              attribution_block, attribution_block
         FROM candidates
       ON CONFLICT (chain, token_address) DO NOTHING
       RETURNING token_address, deployment_block, backfill_next_block, ledger_status`,
      [
        CHAIN, normalized.admittedBefore,
        [...EXACT_DEPLOYMENT_SOURCES], normalized.limit,
      ]
    );
    return Object.freeze(result.rows.map(normalizeSeededRow));
  }

  return Object.freeze({ seedColdTokens, seedNewTokens });
}

module.exports = {
  EXACT_DEPLOYMENT_SOURCES,
  createRobinhoodHolderBootstrapRepository,
  __private: { normalizeColdOptions, normalizeOptions },
};
