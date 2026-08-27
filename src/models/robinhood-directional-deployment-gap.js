const db = require('./db');

const CHAIN = 'robinhood';
const EXACT_SOURCES = Object.freeze([
  'blockscout_internal', 'rpc_direct', 'rpc_trace', 'launchpad_event',
]);

function runId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error('runId must be a non-negative integer');
  return normalized;
}

function limit(value) {
  const parsed = Number(value ?? 1000);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('limit must be between 1 and 5000');
  }
  return parsed;
}

function createRobinhoodDirectionalDeploymentGapRepository(options = {}) {
  const database = options.database || db;

  async function plan(runIdValue) {
    const id = runId(runIdValue);
    const result = await database.query(
      `WITH gap_tokens AS MATERIALIZED (
         SELECT DISTINCT gap.token_address
           FROM robinhood_directional_transfer_deployment_gaps gap
           JOIN robinhood_directional_transfer_replay_ranges range ON range.id = gap.range_id
          WHERE range.run_id = $1::bigint
       ), classified AS MATERIALIZED (
         SELECT gap.token_address,
                state.deployment_block > 0
                  OR (attribution.source = ANY($3::varchar[])
                    AND attribution.attribution_block > 0) AS exact,
                attribution.source = 'blockscout'
                  AND attribution.creator_address IS NOT NULL AS verifiable
           FROM gap_tokens gap
           LEFT JOIN robinhood_holder_token_states state
             ON state.chain = $2 AND state.token_address = gap.token_address
           LEFT JOIN robinhood_token_attributions attribution
             ON attribution.chain = $2 AND attribution.token_address = gap.token_address
       )
       SELECT EXISTS(
                SELECT 1 FROM robinhood_directional_transfer_replay_runs
                 WHERE id = $1::bigint AND chain = $2
              ) AS run_exists,
              COUNT(*) FILTER (WHERE NOT COALESCE(exact, false))::integer AS unresolved,
              COUNT(*) FILTER (WHERE NOT COALESCE(exact, false)
                AND verifiable)::integer AS verifiable
         FROM classified`,
      [id, CHAIN, EXACT_SOURCES]
    );
    const row = result.rows[0];
    if (!row?.run_exists) throw new Error('directional replay run was not found');
    const unresolved = Number(row.unresolved || 0);
    const verifiable = Number(row.verifiable || 0);
    return Object.freeze({ unresolved, verifiable, unsupported: unresolved - verifiable });
  }

  async function listVerificationCandidates(input = {}) {
    const id = runId(input.runId);
    const result = await database.query(
      `WITH gap_tokens AS MATERIALIZED (
         SELECT gap.token_address, MAX(range.range_end_block) AS upper_block
           FROM robinhood_directional_transfer_deployment_gaps gap
           JOIN robinhood_directional_transfer_replay_ranges range ON range.id = gap.range_id
          WHERE range.run_id = $1::bigint
          GROUP BY gap.token_address
       )
       SELECT gap.token_address, attribution.creator_address, gap.upper_block
         FROM gap_tokens gap
         JOIN robinhood_holder_token_states state
           ON state.chain = $2 AND state.token_address = gap.token_address
         JOIN robinhood_token_attributions attribution
           ON attribution.chain = $2 AND attribution.token_address = gap.token_address
        WHERE NOT COALESCE(state.deployment_block > 0, false)
          AND NOT COALESCE(attribution.source = ANY($3::varchar[])
            AND attribution.attribution_block > 0, false)
          AND attribution.source = 'blockscout'
          AND attribution.creator_address IS NOT NULL
        ORDER BY gap.token_address LIMIT $4::int`,
      [id, CHAIN, EXACT_SOURCES, limit(input.limit)]
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({
      tokenAddress: row.token_address, creatorAddress: row.creator_address,
      upperBlock: String(row.upper_block),
    })));
  }

  return Object.freeze({ listVerificationCandidates, plan });
}

module.exports = { createRobinhoodDirectionalDeploymentGapRepository };
