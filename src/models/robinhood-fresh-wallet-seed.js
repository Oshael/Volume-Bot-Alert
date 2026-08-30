const db = require('./db');
const { RULE_VERSION } = require('../services/robinhood-fresh-wallet-rule');

const CHAIN = 'robinhood';
const COHORT_CTES_SQL = `WITH activation AS MATERIALIZED (
  SELECT * FROM robinhood_fresh_wallet_activations
   WHERE chain = $1 AND rule_version = $2 AND status = 'active'
), candidate_tokens AS MATERIALIZED (
  SELECT DISTINCT anchor.token_address, anchor.first_pool_block
    FROM robinhood_token_launch_anchors anchor
    INNER JOIN activation ON activation.chain = anchor.chain
   WHERE anchor.launch_block_time BETWEEN activation.seed_cutoff_at
                                      AND activation.activation_at
     AND anchor.first_pool_block <= activation.activation_block
     AND EXISTS (
       SELECT 1 FROM robinhood_wallet_token_first_buys buy
        WHERE buy.chain = anchor.chain AND buy.token_address = anchor.token_address
          AND buy.block_number <= activation.activation_block
          AND buy.block_number < activation.first_buy_source_next_block
     )
), launch_points AS MATERIALIZED (
  SELECT candidate.token_address, point.block_number
    FROM candidate_tokens candidate
    CROSS JOIN activation
    LEFT JOIN LATERAL (
      SELECT swap.block_number
        FROM robinhood_wallet_swaps swap
        INNER JOIN robinhood_pool_registry registry
          ON registry.chain = swap.chain AND registry.protocol = swap.protocol
         AND registry.market_key = swap.market_key
         AND registry.token_address = swap.token_address
         AND registry.discovery_block <= swap.block_number
       WHERE swap.chain = $1 AND swap.token_address = candidate.token_address
         AND swap.block_number BETWEEN candidate.first_pool_block
                                   AND activation.activation_block
       ORDER BY swap.block_time, swap.block_number, swap.action_index,
                swap.transaction_hash
       LIMIT 1
    ) point ON true
), launch_rows AS MATERIALIZED (
  SELECT candidate.token_address, swap.wallet_address, swap.transaction_hash,
         swap.action_index, swap.block_number, swap.block_time, swap.side,
         position.transaction_index, position.block_hash
    FROM launch_points candidate
    INNER JOIN robinhood_wallet_swaps swap
      ON swap.chain = $1 AND swap.token_address = candidate.token_address
     AND swap.block_number = candidate.block_number
    INNER JOIN robinhood_pool_registry registry
      ON registry.chain = swap.chain AND registry.protocol = swap.protocol
     AND registry.market_key = swap.market_key
     AND registry.token_address = swap.token_address
     AND registry.discovery_block <= swap.block_number
    LEFT JOIN robinhood_transaction_positions position
      ON position.chain = swap.chain
     AND position.transaction_hash = swap.transaction_hash
     AND position.block_number = swap.block_number
), anchor_quality AS MATERIALIZED (
  SELECT token_address, COUNT(*) FILTER (
           WHERE transaction_index IS NULL OR block_hash IS NULL
         )::bigint AS missing_positions
    FROM launch_rows GROUP BY token_address
), canonical_anchors AS MATERIALIZED (
  SELECT DISTINCT ON (token_address) token_address, wallet_address,
         transaction_hash, transaction_index, action_index, block_number,
         block_hash, block_time, side
    FROM launch_rows
   WHERE transaction_index IS NOT NULL AND block_hash IS NOT NULL
   ORDER BY token_address, transaction_index, action_index, transaction_hash
), eligible_tokens AS MATERIALIZED (
  SELECT anchor.token_address FROM canonical_anchors anchor
  INNER JOIN anchor_quality quality USING (token_address)
  CROSS JOIN activation
  WHERE quality.missing_positions = 0
    AND anchor.block_time BETWEEN activation.seed_cutoff_at AND activation.activation_at
)`;

const COHORT_SELECT_SQL = `SELECT buy.token_address, buy.wallet_address
  FROM robinhood_wallet_token_first_buys buy
  INNER JOIN eligible_tokens eligible USING (token_address)
  CROSS JOIN activation
 WHERE buy.chain = $1 AND buy.block_number <= activation.activation_block
   AND buy.block_number < activation.first_buy_source_next_block`;

const COHORT_SQL = `${COHORT_CTES_SQL} ${COHORT_SELECT_SQL}`;
const PLAN_SQL = `${COHORT_CTES_SQL}, cohort AS MATERIALIZED (${COHORT_SELECT_SQL})
SELECT COUNT(*)::text AS pair_count,
       COUNT(DISTINCT cohort.token_address)::text AS token_count,
       (SELECT COUNT(*) FROM candidate_tokens candidate
         LEFT JOIN eligible_tokens eligible USING (token_address)
        WHERE eligible.token_address IS NULL)::text AS incomplete_token_count,
       (SELECT COUNT(DISTINCT transaction_hash) FROM launch_rows
          WHERE transaction_index IS NULL OR block_hash IS NULL)::text
          AS missing_position_count,
       (SELECT MIN(block_time) FROM launch_rows
          WHERE transaction_index IS NULL OR block_hash IS NULL) AS missing_position_from,
       (SELECT MAX(block_time) + INTERVAL '1 second' FROM launch_rows
          WHERE transaction_index IS NULL OR block_hash IS NULL) AS missing_position_through
  FROM cohort`;

function sourceReady(source, activation) {
  return source?.seed_status === 'completed' && source.source_next_block != null
    && BigInt(source.source_next_block) >= BigInt(activation.first_buy_source_next_block)
    && new Date(source.next_time) >= new Date(activation.first_buy_source_through);
}

function frozenPlan(existing) {
  if (!existing || existing.status === 'planned') return null;
  return Object.freeze({ ready: true, frozen: true, runId: existing.id,
    status: existing.status, tokenCount: Number(existing.expected_token_count),
    pairCount: Number(existing.expected_pair_count) });
}

function cohortPlan(counts, existing) {
  const incompleteTokenCount = Number(counts.incomplete_token_count);
  if (incompleteTokenCount) return Object.freeze({
    ready: false, reason: Number(counts.missing_position_count)
      ? 'launch_anchor_position_incomplete' : 'launch_anchor_evidence_incomplete',
    incompleteTokenCount, missingPositionCount: Number(counts.missing_position_count),
    missingPositionFrom: counts.missing_position_from?.toISOString?.() || null,
    missingPositionThrough: counts.missing_position_through?.toISOString?.() || null,
  });
  const tokenCount = Number(counts.token_count); const pairCount = Number(counts.pair_count);
  if (!tokenCount || !pairCount) return Object.freeze({
    ready: false, reason: 'seed_cohort_empty',
  });
  return Object.freeze({ ready: true, frozen: false,
    runId: existing?.id, status: existing?.status, tokenCount, pairCount });
}

function createRobinhoodFreshWalletSeedRepository(options = {}) {
  const database = options.database || db;

  async function seedQueue(client, runId) {
    await client.query(`WITH cohort AS MATERIALIZED (${COHORT_SQL})
      INSERT INTO robinhood_fresh_wallet_queue(
        chain, token_address, wallet_address, rule_version, source_kind, seed_run_id
      ) SELECT $1, token_address, wallet_address, $2, 'seed', $3 FROM cohort`,
    [CHAIN, RULE_VERSION, runId]);
    await client.query(`WITH counts AS (SELECT token_address, COUNT(*)::bigint pair_count
      FROM robinhood_fresh_wallet_queue WHERE seed_run_id = $1 GROUP BY token_address)
      INSERT INTO robinhood_fresh_wallet_token_coverage(
        chain, token_address, rule_version, coverage_scope, status, status_reason,
        seed_run_id, required_pair_count
      ) SELECT $2, token_address, $3, 'seed', 'pending', 'seed_running', $1, pair_count
        FROM counts`, [runId, CHAIN, RULE_VERSION]);
  }

  async function loadPlan() {
    const activation = (await database.query(`SELECT *, activation_block::text,
      first_buy_source_next_block::text FROM robinhood_fresh_wallet_activations
      WHERE chain = $1 AND rule_version = $2 AND status = 'active'`,
    [CHAIN, RULE_VERSION])).rows[0];
    if (!activation) return Object.freeze({ ready: false, reason: 'activation_unavailable' });
    const source = (await database.query(`SELECT cursor.source_next_block::text,
      cursor.next_time, cursor.source_through, seed.status AS seed_status
      FROM robinhood_first_buy_live_cursors cursor
      LEFT JOIN robinhood_first_buy_backfill_runs seed
        ON seed.id = cursor.seed_run_id AND seed.chain = cursor.chain
      WHERE cursor.chain = $1`, [CHAIN])).rows[0];
    if (!sourceReady(source, activation)) {
      return Object.freeze({ ready: false, reason: 'first_buy_source_incomplete' });
    }
    const existing = (await database.query(`SELECT id::text, status,
      expected_token_count::text, expected_pair_count::text
      FROM robinhood_fresh_wallet_seed_runs WHERE chain = $1 AND rule_version = $2`,
    [CHAIN, RULE_VERSION])).rows[0];
    const frozen = frozenPlan(existing);
    if (frozen) return frozen;
    const counts = (await database.query(PLAN_SQL, [CHAIN, RULE_VERSION])).rows[0];
    return cohortPlan(counts, existing);
  }

  async function samplePairs(limit = 3) {
    const sampleLimit = Math.max(1, Math.min(Number(limit) || 3, 64));
    const existing = (await database.query(`SELECT id, status FROM robinhood_fresh_wallet_seed_runs
      WHERE chain = $1 AND rule_version = $2`, [CHAIN, RULE_VERSION])).rows[0];
    const sql = existing && existing.status !== 'planned'
      ? `SELECT queue.token_address, queue.wallet_address, buy.transaction_hash,
          buy.transaction_index::text, buy.block_number::text, buy.block_hash, buy.block_time
         FROM robinhood_fresh_wallet_queue queue
         INNER JOIN robinhood_wallet_token_first_buys buy USING (chain, token_address, wallet_address)
        WHERE queue.chain = $1 AND queue.rule_version = $2 AND queue.source_kind = 'seed'
        ORDER BY MD5(queue.token_address || queue.wallet_address) LIMIT $3`
      : `WITH cohort AS MATERIALIZED (${COHORT_SQL})
         SELECT cohort.token_address, cohort.wallet_address, buy.transaction_hash,
                buy.transaction_index::text, buy.block_number::text, buy.block_hash, buy.block_time
           FROM cohort INNER JOIN robinhood_wallet_token_first_buys buy USING (
             token_address, wallet_address
           ) ORDER BY MD5(cohort.token_address || cohort.wallet_address) LIMIT $3`;
    return (await database.query(sql, [CHAIN, RULE_VERSION, sampleLimit])).rows.map((row) => ({
      tokenAddress: row.token_address, walletAddress: row.wallet_address,
      sourceKind: 'seed', transactionHash: row.transaction_hash,
      transactionIndex: row.transaction_index, blockNumber: row.block_number,
      blockHash: row.block_hash,
      blockTime: row.block_time?.toISOString?.() || String(row.block_time),
    }));
  }

  async function createOrResume(plan) {
    if (!plan?.ready || !plan.pairCount) throw new Error('FRESH seed plan has no cohort');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE robinhood_fresh_wallet_seed_runs IN SHARE ROW EXCLUSIVE MODE');
      let run = (await client.query(`SELECT id, status, expected_token_count::text,
        expected_pair_count::text FROM robinhood_fresh_wallet_seed_runs
        WHERE chain = $1 AND rule_version = $2 FOR UPDATE`, [CHAIN, RULE_VERSION])).rows[0];
      if (!run) {
        const counts = (await client.query(PLAN_SQL, [CHAIN, RULE_VERSION])).rows[0];
        if (Number(counts.incomplete_token_count)) {
          throw new Error('FRESH seed canonical launch-anchor evidence is incomplete');
        }
        if (Number(counts.pair_count) !== plan.pairCount
            || Number(counts.token_count) !== plan.tokenCount) {
          throw new Error('FRESH seed cohort changed after preflight');
        }
        run = (await client.query(`INSERT INTO robinhood_fresh_wallet_seed_runs(
          chain, rule_version, status, expected_token_count, expected_pair_count, started_at
        ) VALUES ($1, $2, 'running', $3, $4, NOW()) RETURNING id, status`,
        [CHAIN, RULE_VERSION, plan.tokenCount, plan.pairCount])).rows[0];
        await seedQueue(client, run.id);
      } else if (run.status === 'planned') {
        if (Number(run.expected_pair_count) !== plan.pairCount
            || Number(run.expected_token_count) !== plan.tokenCount) {
          throw new Error('planned FRESH seed counts do not match the preflight');
        }
        await client.query(`UPDATE robinhood_fresh_wallet_seed_runs SET status = 'running',
          started_at = NOW(), updated_at = NOW() WHERE id = $1`, [run.id]);
        await seedQueue(client, run.id); run.status = 'running';
      } else if (run.status === 'paused') {
        await client.query(`UPDATE robinhood_fresh_wallet_seed_runs SET status = 'running',
          updated_at = NOW() WHERE id = $1`, [run.id]); run.status = 'running';
      }
      await client.query('COMMIT');
      return Object.freeze({ runId: String(run.id), status: run.status });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function syncProgress(runId, pause = false) {
    const { rows } = await database.query(`WITH pair_counts AS MATERIALIZED (
      SELECT token_address, COUNT(*)::bigint required,
        COUNT(*) FILTER (WHERE status = 'complete')::bigint completed
      FROM robinhood_fresh_wallet_queue WHERE seed_run_id = $1 GROUP BY token_address
    ), coverage AS (
      UPDATE robinhood_fresh_wallet_token_coverage target SET
        completed_pair_count = pair_counts.completed,
        status = CASE WHEN pair_counts.completed = pair_counts.required THEN 'ready' ELSE 'pending' END,
        status_reason = CASE WHEN pair_counts.completed = pair_counts.required
          THEN 'seed_complete' ELSE 'seed_running' END,
        through_block_number = CASE WHEN pair_counts.completed = pair_counts.required
          THEN activation.activation_block ELSE NULL END,
        through_block_hash = CASE WHEN pair_counts.completed = pair_counts.required
          THEN activation.activation_block_hash ELSE NULL END, observed_at = NOW(), updated_at = NOW()
      FROM pair_counts, robinhood_fresh_wallet_activations activation
      WHERE target.seed_run_id = $1 AND target.token_address = pair_counts.token_address
        AND activation.chain = target.chain AND activation.rule_version = target.rule_version
    ), totals AS (SELECT COUNT(*)::bigint total,
      COUNT(*) FILTER (WHERE status = 'complete')::bigint completed
      FROM robinhood_fresh_wallet_queue WHERE seed_run_id = $1)
    UPDATE robinhood_fresh_wallet_seed_runs run SET
      completed_pair_count = totals.completed,
      status = CASE WHEN totals.completed = totals.total THEN 'completed'
        WHEN $2::boolean THEN 'paused' ELSE 'running' END,
      finished_at = CASE WHEN totals.completed = totals.total THEN NOW() ELSE NULL END,
      updated_at = NOW() FROM totals WHERE run.id = $1
    RETURNING run.status, run.started_at, totals.total::text, totals.completed::text`,
    [runId, pause]);
    const row = rows[0];
    const total = Number(row.total); const completed = Number(row.completed);
    const elapsedSeconds = Math.max(0.001, (Date.now() - new Date(row.started_at)) / 1000);
    const throughput = completed / elapsedSeconds;
    return Object.freeze({ runId: String(runId), status: row.status,
      total, completed, throughputPairsPerSecond: Number(throughput.toFixed(2)),
      etaSeconds: completed ? Math.ceil((total - completed) / throughput) : null });
  }

  return Object.freeze({ createOrResume, loadPlan, samplePairs, syncProgress });
}

module.exports = { createRobinhoodFreshWalletSeedRepository };
