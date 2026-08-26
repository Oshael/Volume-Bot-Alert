const db = require('./db');

const CHAIN = 'robinhood';
const VERSION = 'rh_launch_anchor_v1';
const MAX_TARGETS = 250_000;

const COVERAGE_SQL = `SELECT cursor.source_next_block::text,
       cursor.next_time = cursor.source_through AS caught_up,
       seed.status AS seed_status
  FROM robinhood_first_buy_live_cursors cursor
  LEFT JOIN robinhood_first_buy_backfill_runs seed
    ON seed.id = cursor.seed_run_id AND seed.chain = cursor.chain
 WHERE cursor.chain = $1`;

const TARGETS_SQL = `WITH candidates AS MATERIALIZED (
  SELECT state.token_address, state.live_through_block AS source_through_block,
         state.live_through_hash AS source_through_hash,
         pool.first_pool_block
    FROM robinhood_holder_token_states state
    LEFT JOIN LATERAL (
      SELECT MIN(registry.discovery_block) AS first_pool_block
        FROM robinhood_pool_registry registry
       WHERE registry.chain = state.chain
         AND registry.token_address = state.token_address
         AND registry.discovery_block <= state.live_through_block
    ) pool ON true
    LEFT JOIN robinhood_token_launch_anchors anchor
      ON anchor.chain = state.chain AND anchor.token_address = state.token_address
   WHERE state.chain = $1 AND state.ledger_status = 'live'
     AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
     AND state.live_through_block <= $2::bigint
     AND EXISTS (
       SELECT 1 FROM robinhood_wallet_token_first_buys buy
        WHERE buy.chain = state.chain AND buy.token_address = state.token_address
          AND buy.block_number <= state.live_through_block
     )
     AND (anchor.token_address IS NULL
       OR anchor.first_pool_block <> pool.first_pool_block
       OR anchor.launch_block > state.live_through_block)
) SELECT token_address, first_pool_block::text, source_through_block::text,
         source_through_hash
    FROM candidates ORDER BY token_address LIMIT $3::int`;

const FIND_ANCHORS_SQL = `WITH requested AS MATERIALIZED (
  SELECT * FROM UNNEST($1::varchar[], $2::bigint[], $3::bigint[])
    AS item(token_address, first_pool_block, source_through_block)
)
SELECT requested.token_address, requested.first_pool_block::text,
       requested.source_through_block::text,
       anchor.block_number::text AS launch_block, anchor.block_time AS launch_block_time
  FROM requested
  LEFT JOIN LATERAL (
    SELECT swap.block_number, swap.block_time
      FROM robinhood_wallet_swaps swap
      INNER JOIN robinhood_pool_registry registry
        ON registry.chain = swap.chain AND registry.protocol = swap.protocol
       AND registry.market_key = swap.market_key
       AND registry.token_address = swap.token_address
       AND registry.discovery_block <= swap.block_number
     WHERE swap.chain = $4 AND swap.token_address = requested.token_address
       AND swap.block_number BETWEEN requested.first_pool_block
                                 AND requested.source_through_block
     ORDER BY swap.block_time, swap.block_number, swap.action_index,
              swap.transaction_hash
     LIMIT 1
  ) anchor ON true ORDER BY requested.token_address`;

const UPSERT_SQL = `INSERT INTO robinhood_token_launch_anchors (
  chain, token_address, first_pool_block, launch_block, launch_block_time,
  source_through_block, evidence_version
) SELECT $1, item.token_address, item.first_pool_block, item.launch_block,
         item.launch_block_time, item.source_through_block, $7
    FROM UNNEST($2::varchar[], $3::bigint[], $4::bigint[],
                $5::timestamptz[], $6::bigint[])
      AS item(token_address, first_pool_block, launch_block,
              launch_block_time, source_through_block)
ON CONFLICT (chain, token_address) DO UPDATE SET
  first_pool_block = EXCLUDED.first_pool_block,
  launch_block = EXCLUDED.launch_block,
  launch_block_time = EXCLUDED.launch_block_time,
  source_through_block = GREATEST(
    robinhood_token_launch_anchors.source_through_block,
    EXCLUDED.source_through_block
  ), evidence_version = EXCLUDED.evidence_version,
  anchor_wallet_address = NULL, anchor_transaction_hash = NULL,
  anchor_transaction_index = NULL, anchor_action_index = NULL,
  anchor_block_hash = NULL, anchor_side = NULL, anchor_volume_usd = NULL,
  updated_at = NOW()`;

function integer(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeTarget(row) {
  return Object.freeze({
    tokenAddress: row.token_address,
    firstPoolBlock: row.first_pool_block,
    sourceThroughBlock: row.source_through_block,
    sourceThroughHash: row.source_through_hash,
  });
}

function arrays(targets) {
  return [
    targets.map((item) => item.tokenAddress),
    targets.map((item) => item.firstPoolBlock),
    targets.map((item) => item.sourceThroughBlock),
  ];
}

function createRobinhoodLaunchAnchorBackfillRepository(options = {}) {
  const database = options.database || db;
  const timeoutMs = integer(options.statementTimeoutMs ?? 120_000,
    'statementTimeoutMs', 1_000, 900_000);
  const query = (sql, params) => (database.queryWithStatementTimeout
    ? database.queryWithStatementTimeout(sql, params, timeoutMs)
    : database.query(sql, params));

  async function loadPlan() {
    const coverage = (await query(COVERAGE_SQL, [CHAIN])).rows[0];
    if (!coverage || coverage.seed_status !== 'completed' || coverage.caught_up !== true
      || coverage.source_next_block == null || BigInt(coverage.source_next_block) < 1n) {
      return Object.freeze({ ready: false, reason: 'first_buy_coverage_incomplete' });
    }
    const sourceThroughBlock = (BigInt(coverage.source_next_block) - 1n).toString();
    const rows = (await query(TARGETS_SQL, [
      CHAIN, sourceThroughBlock, MAX_TARGETS + 1,
    ])).rows;
    if (rows.length > MAX_TARGETS) {
      return Object.freeze({ ready: false, reason: 'launch_anchor_target_cap_exceeded' });
    }
    const unavailableWithoutPool = rows.filter((row) => row.first_pool_block == null).length;
    const targets = rows.filter((row) => row.first_pool_block != null).map(normalizeTarget);
    return Object.freeze({
      ready: true, reason: null, sourceThroughBlock,
      unavailableWithoutPool, targets: Object.freeze(targets),
    });
  }

  async function probeTargets(targets) {
    if (!targets.length) return Object.freeze({ targets: 0, anchors: 0, unavailable: 0 });
    const rows = (await query(FIND_ANCHORS_SQL, [...arrays(targets), CHAIN])).rows;
    const anchors = rows.filter((row) => row.launch_block != null).length;
    return Object.freeze({ targets: rows.length, anchors, unavailable: rows.length - anchors });
  }

  async function createRun(preflight) {
    if (!preflight?.report?.approved) throw new Error('launch-anchor preflight is not approved');
    const plan = preflight.plan;
    if (!plan?.ready || !plan.targets?.length) throw new Error('launch-anchor plan has no targets');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE robinhood_launch_anchor_backfill_runs IN SHARE ROW EXCLUSIVE MODE');
      const run = await client.query(
        `INSERT INTO robinhood_launch_anchor_backfill_runs(
           chain, evidence_version, source_through_block, status,
           target_count, started_at
         ) VALUES ($1, $2, $3, 'running', $4, NOW()) RETURNING id`,
        [CHAIN, VERSION, plan.sourceThroughBlock, plan.targets.length]
      );
      const values = arrays(plan.targets);
      await client.query(
        `INSERT INTO robinhood_launch_anchor_backfill_targets(
           run_id, chain, token_address, first_pool_block,
           source_through_block, source_through_hash
         ) SELECT $1, $2, item.* FROM UNNEST(
           $3::varchar[], $4::bigint[], $5::bigint[], $6::varchar[]
         ) AS item(token_address, first_pool_block,
                   source_through_block, source_through_hash)`,
        [run.rows[0].id, CHAIN, ...values, plan.targets.map((item) => item.sourceThroughHash)]
      );
      await client.query('COMMIT');
      return Object.freeze({ id: String(run.rows[0].id), targetCount: plan.targets.length });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadRunPlan(runIdValue) {
    const runId = integer(runIdValue, 'runId');
    const run = (await query(
      `SELECT id, status, source_through_block::text, target_count
         FROM robinhood_launch_anchor_backfill_runs
        WHERE id = $1 AND chain = $2`, [runId, CHAIN]
    )).rows[0];
    if (!run) throw new Error('launch-anchor backfill run was not found');
    if (!['running', 'completed'].includes(run.status)) {
      throw new Error(`launch-anchor backfill run cannot resume from ${run.status}`);
    }
    const rows = (await query(
      `SELECT token_address, first_pool_block::text, source_through_block::text,
              source_through_hash
         FROM robinhood_launch_anchor_backfill_targets
        WHERE run_id = $1 AND chain = $2 AND status = 'pending'
        ORDER BY token_address`, [runId, CHAIN]
    )).rows;
    return Object.freeze({
      ready: true, reason: null, runId: String(run.id), status: run.status,
      sourceThroughBlock: run.source_through_block, unavailableWithoutPool: 0,
      targets: Object.freeze(rows.map(normalizeTarget)),
    });
  }

  async function getProgress(runIdValue) {
    const runId = integer(runIdValue, 'runId');
    const row = (await query(
      `SELECT run.status, run.target_count, run.started_at, run.finished_at,
              COUNT(*) FILTER (WHERE target.status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE target.status = 'leased') AS leased,
              COUNT(*) FILTER (WHERE target.status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE target.status = 'unavailable') AS unavailable,
              COUNT(*) FILTER (WHERE target.status = 'failed') AS failed,
              COALESCE(SUM(target.anchors_written), 0) AS anchors_written
         FROM robinhood_launch_anchor_backfill_runs run
         LEFT JOIN robinhood_launch_anchor_backfill_targets target
           ON target.run_id = run.id
        WHERE run.id = $1 AND run.chain = $2 GROUP BY run.id`, [runId, CHAIN]
    )).rows[0];
    if (!row) return null;
    const total = Number(row.target_count);
    const completed = Number(row.completed);
    const unavailable = Number(row.unavailable);
    const failed = Number(row.failed);
    const terminal = completed + unavailable + failed;
    const elapsedSeconds = row.started_at ? Math.max(0.001, (
      new Date(row.finished_at || Date.now()) - new Date(row.started_at)
    ) / 1000) : 0.001;
    const remaining = Math.max(0, total - terminal);
    return Object.freeze({
      status: row.status, total, pending: Number(row.pending), leased: Number(row.leased),
      completed, unavailable, failed, anchorsWritten: Number(row.anchors_written),
      progressPct: total ? Number(((terminal / total) * 100).toFixed(2)) : 100,
      elapsedSeconds: Math.ceil(elapsedSeconds),
      etaSeconds: terminal ? Math.ceil((elapsedSeconds * remaining) / terminal) : null,
    });
  }

  async function materializeBatch(input = {}) {
    const runId = integer(input.runId, 'runId');
    const limit = integer(input.limit ?? 500, 'limit', 1, 5_000);
    const leaseMs = integer(input.leaseMs ?? Math.max(180_000, timeoutMs + 60_000),
      'leaseMs', timeoutMs + 1, 1_200_000);
    const leaseOwner = String(input.owner || '').trim();
    if (!leaseOwner || leaseOwner.length > 128) throw new Error('owner is invalid');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
      const claimed = await client.query(
        `WITH claimable AS (
           SELECT target.token_address
             FROM robinhood_launch_anchor_backfill_targets target
             INNER JOIN robinhood_launch_anchor_backfill_runs run
               ON run.id = target.run_id
            WHERE target.run_id = $1 AND run.status = 'running'
              AND target.status = 'pending' AND target.next_attempt_at <= NOW()
            ORDER BY target.token_address LIMIT $4
            FOR UPDATE OF target SKIP LOCKED
         ) UPDATE robinhood_launch_anchor_backfill_targets target SET
             status = 'leased', lease_owner = $2,
             lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, NOW()), updated_at = NOW()
            FROM claimable
           WHERE target.run_id = $1
             AND target.token_address = claimable.token_address
         RETURNING target.token_address, target.first_pool_block::text,
                   target.source_through_block::text, target.source_through_hash`,
        [runId, leaseOwner, leaseMs, limit]
      );
      const targets = claimed.rows.map(normalizeTarget);
      let anchors = [];
      if (targets.length) {
        anchors = (await client.query(FIND_ANCHORS_SQL, [...arrays(targets), CHAIN])).rows;
        const proven = anchors.filter((row) => row.launch_block != null);
        if (proven.length) {
          await client.query(UPSERT_SQL, [
            CHAIN, proven.map((row) => row.token_address),
            proven.map((row) => row.first_pool_block),
            proven.map((row) => row.launch_block),
            proven.map((row) => row.launch_block_time),
            proven.map((row) => row.source_through_block), VERSION,
          ]);
        }
        const completed = await client.query(
          `UPDATE robinhood_launch_anchor_backfill_targets target SET
             status = CASE WHEN item.anchor_block IS NULL
               THEN 'unavailable' ELSE 'completed' END,
             lease_owner = NULL, lease_until = NULL,
             anchor_block = item.anchor_block,
             swaps_considered = CASE WHEN item.anchor_block IS NULL THEN 0 ELSE 1 END,
             anchors_written = CASE WHEN item.anchor_block IS NULL THEN 0 ELSE 1 END,
             last_error_code = CASE WHEN item.anchor_block IS NULL
               THEN 'anchor_not_found' END,
             last_error_message = CASE WHEN item.anchor_block IS NULL
               THEN 'No registered swap exists inside the frozen frontier' END,
             completed_at = NOW(), updated_at = NOW()
            FROM UNNEST($3::varchar[], $4::bigint[])
              AS item(token_address, anchor_block)
           WHERE target.run_id = $1 AND target.status = 'leased'
             AND target.lease_owner = $2 AND target.lease_until > NOW()
             AND target.token_address = item.token_address`,
          [runId, leaseOwner, anchors.map((row) => row.token_address),
            anchors.map((row) => row.launch_block)]
        );
        if (completed.rowCount !== targets.length) {
          throw new Error('launch-anchor batch lease became stale');
        }
      }
      await client.query(
        `UPDATE robinhood_launch_anchor_backfill_runs run SET
           status = 'completed', finished_at = NOW(), updated_at = NOW()
         WHERE run.id = $1 AND run.status = 'running' AND NOT EXISTS (
           SELECT 1 FROM robinhood_launch_anchor_backfill_targets target
            WHERE target.run_id = run.id
              AND target.status IN ('pending', 'leased')
         )`, [runId]
      );
      const run = await client.query(
        `SELECT status FROM robinhood_launch_anchor_backfill_runs WHERE id = $1`, [runId]
      );
      await client.query('COMMIT');
      const written = anchors.filter((row) => row.launch_block != null).length;
      return Object.freeze({
        status: run.rows[0]?.status || null, claimed: targets.length,
        anchorsWritten: written, unavailable: targets.length - written,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    loadPlan, loadRunPlan, probeTargets, createRun, materializeBatch, getProgress,
  });
}

module.exports = {
  createRobinhoodLaunchAnchorBackfillRepository,
  __private: { COVERAGE_SQL, FIND_ANCHORS_SQL, TARGETS_SQL, UPSERT_SQL },
};
