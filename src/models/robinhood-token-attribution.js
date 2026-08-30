const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const LIVE_SOURCES = new Set([
  'blockscout_internal', 'rpc_direct', 'rpc_trace', 'launchpad_event',
]);
const LIVE_STREAM = 'live';
const BACKFILL_STREAM = 'launchpad_backfill';

function boundedLimit(value, fallback = 1000) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10000) return fallback;
  return parsed;
}

function verificationCandidateOptions(input = {}) {
  const admittedBefore = new Date(input.admittedBefore);
  const retryBefore = new Date(input.retryBefore);
  if (!Number.isFinite(admittedBefore.getTime())) throw new Error('admittedBefore is invalid');
  if (!Number.isFinite(retryBefore.getTime())) throw new Error('retryBefore is invalid');
  const limit = input.limit == null ? 10 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('verification candidate limit is invalid');
  }
  return Object.freeze({
    admittedBefore: admittedBefore.toISOString(),
    retryBefore: retryBefore.toISOString(),
    limit,
  });
}

function createRobinhoodTokenAttributionRepository(options = {}) {
  const database = options.database || db;

  async function loadCreatorCursor(stream) {
    const { rows } = await database.query(
      `SELECT * FROM robinhood_direct_creator_cursors
       WHERE chain = '${CHAIN}' AND stream = $1`,
      [stream]
    );
    return rows[0] || null;
  }

  async function initializeCreatorCursor(stream, nextBlock, safeHead = nextBlock) {
    const normalizedNext = BigInt(String(nextBlock)).toString();
    const normalizedHead = BigInt(String(safeHead)).toString();
    await database.query(
      `INSERT INTO robinhood_direct_creator_cursors (chain, stream, next_block, safe_head)
       VALUES ('${CHAIN}', $1, $2::bigint, $3::bigint)
       ON CONFLICT (chain, stream) DO NOTHING`,
      [stream, normalizedNext, normalizedHead]
    );
    return loadCreatorCursor(stream);
  }

  const loadDirectCursor = () => loadCreatorCursor(LIVE_STREAM);
  const initializeDirectCursor = (nextBlock) => initializeCreatorCursor(LIVE_STREAM, nextBlock);
  const loadLaunchpadBackfillCursor = () => loadCreatorCursor(BACKFILL_STREAM);
  const initializeLaunchpadBackfillCursor = (nextBlock, safeHead) => (
    initializeCreatorCursor(BACKFILL_STREAM, nextBlock, safeHead)
  );

  async function listCreatorCandidates(input = {}) {
    const retryBefore = new Date(input.retryBefore || 0);
    if (!Number.isFinite(retryBefore.getTime())) throw new Error('retryBefore is invalid');
    const eligibleExpression = input.includeEligible === false ? 'NULL::bigint' : 'COUNT(*) OVER()';
    const { rows } = await database.query(
      `SELECT registry.token_address, MIN(registry.discovery_block) AS discovery_block,
              ${eligibleExpression} AS eligible_count
       FROM robinhood_pool_registry registry
       LEFT JOIN robinhood_token_attributions attribution
         ON attribution.chain = registry.chain
        AND attribution.token_address = registry.token_address
       WHERE registry.chain = '${CHAIN}'
         AND attribution.creator_address IS NULL
         AND (attribution.last_attempted_at IS NULL OR attribution.last_attempted_at < $1)
       GROUP BY registry.token_address
       ORDER BY MIN(registry.discovery_block), registry.token_address
       LIMIT $2::int`,
      [retryBefore.toISOString(), boundedLimit(input.limit)]
    );
    return Object.freeze({
      eligible: rows.length
        ? (rows[0].eligible_count == null ? null : Number(rows[0].eligible_count))
        : (input.includeEligible === false ? null : 0),
      candidates: Object.freeze(rows.map((row) => Object.freeze({
        tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
        discoveryBlock: String(row.discovery_block),
      }))),
    });
  }

  async function listHolderDirectVerificationCandidates(input = {}) {
    const normalized = verificationCandidateOptions(input);
    const { rows } = await database.query(
      `SELECT catalog.address AS token_address, attribution.creator_address
         FROM token_catalog catalog
         INNER JOIN robinhood_token_attributions attribution
           ON attribution.chain = catalog.chain
          AND attribution.token_address = catalog.address
         LEFT JOIN robinhood_holder_token_states state
           ON state.chain = catalog.chain AND state.token_address = catalog.address
        WHERE catalog.chain = '${CHAIN}'
          AND catalog.first_seen_at < $1::timestamptz
          AND attribution.source = 'blockscout'
          AND attribution.creator_address IS NOT NULL
          AND attribution.attribution_block IS NULL
          AND attribution.last_attempted_at < $2::timestamptz
          AND state.token_address IS NULL
        ORDER BY catalog.first_seen_at DESC, catalog.address
        LIMIT $3::int`,
      [normalized.admittedBefore, normalized.retryBefore, normalized.limit]
    );
    return Object.freeze(rows.map((row) => Object.freeze({
      tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
      creatorAddress: normalizeTokenAddress(CHAIN, row.creator_address),
    })));
  }

  async function recordDirectVerificationFailure(input = {}) {
    const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
    const error = String(input.error || 'direct_deployment_unverified').slice(0, 500);
    const result = await database.query(
      `UPDATE robinhood_token_attributions
          SET last_attempted_at = NOW(), last_error = $2, updated_at = NOW()
        WHERE chain = '${CHAIN}' AND token_address = $1
          AND source = 'blockscout' AND attribution_block IS NULL`,
      [tokenAddress, error]
    );
    return Object.freeze({ recorded: result.rowCount === 1 });
  }

  async function recordAttempts(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    const normalized = inputs.map((input) => {
      const creatorAddress = input.creatorAddress == null
        ? null : normalizeTokenAddress(CHAIN, input.creatorAddress);
      return {
        tokenAddress: normalizeTokenAddress(CHAIN, input.tokenAddress),
        creatorAddress,
        lastError: creatorAddress
          ? null : String(input.error || 'creator_unavailable').slice(0, 500),
      };
    });
    const { rows } = await database.query(
      `INSERT INTO robinhood_token_attributions (
         chain, token_address, creator_address, source,
         last_attempted_at, last_resolved_at, last_error
       ) SELECT '${CHAIN}', input.token_address, input.creator_address,
                'blockscout', NOW(),
                CASE WHEN input.creator_address IS NULL THEN NULL ELSE NOW() END,
                input.last_error
         FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[])
           AS input(token_address, creator_address, last_error)
       ON CONFLICT (chain, token_address) DO UPDATE SET
         creator_address = COALESCE(EXCLUDED.creator_address, robinhood_token_attributions.creator_address),
         last_attempted_at = NOW(),
         last_resolved_at = COALESCE(EXCLUDED.last_resolved_at, robinhood_token_attributions.last_resolved_at),
         last_error = CASE
           WHEN COALESCE(EXCLUDED.creator_address, robinhood_token_attributions.creator_address) IS NULL
             THEN EXCLUDED.last_error
           ELSE NULL
       END,
         updated_at = NOW()
       WHERE robinhood_token_attributions.source = 'blockscout'
       RETURNING *`,
      [
        normalized.map((item) => item.tokenAddress),
        normalized.map((item) => item.creatorAddress),
        normalized.map((item) => item.lastError),
      ]
    );
    return rows;
  }

  async function recordAttempt(input = {}) {
    return (await recordAttempts([input]))[0];
  }

  function normalizeDeployments(inputs, fallbackBlock) {
    const deployments = (inputs || []).map((item) => ({
      tokenAddress: normalizeTokenAddress(CHAIN, item.tokenAddress),
      creatorAddress: normalizeTokenAddress(CHAIN, item.creatorAddress),
      transactionHash: String(item.transactionHash).toLowerCase(),
      source: String(item.source || 'rpc_direct'),
      factoryAddress: item.factoryAddress == null
        ? null : normalizeTokenAddress(CHAIN, item.factoryAddress),
      blockNumber: BigInt(String(item.blockNumber ?? fallbackBlock)).toString(),
    }));
    for (const item of deployments) {
      if (!LIVE_SOURCES.has(item.source)) throw new Error('live creator source is unsupported');
      const requiresFactory = [
        'blockscout_internal', 'rpc_trace', 'launchpad_event',
      ].includes(item.source);
      if (requiresFactory !== (item.factoryAddress !== null)) {
        throw new Error('factory deployment source requires its factory address');
      }
    }
    return deployments;
  }

  async function upsertDeployments(client, deployments) {
    if (!deployments.length) return;
    await client.query(
      `INSERT INTO robinhood_token_attributions (
         chain, token_address, creator_address, source, attribution_block,
         attribution_tx_hash, attribution_factory_address,
         last_attempted_at, last_resolved_at, last_error
       ) SELECT '${CHAIN}', item.token_address, item.creator_address, item.source,
                item.block_number, item.transaction_hash, item.factory_address, NOW(), NOW(), NULL
         FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[],
                     $5::varchar[], $6::bigint[])
           AS item(token_address, creator_address, transaction_hash, source,
                   factory_address, block_number)
       ON CONFLICT (chain, token_address) DO UPDATE SET
         creator_address = EXCLUDED.creator_address,
         source = EXCLUDED.source,
         attribution_block = EXCLUDED.attribution_block,
         attribution_tx_hash = EXCLUDED.attribution_tx_hash,
         attribution_factory_address = EXCLUDED.attribution_factory_address,
         last_attempted_at = NOW(), last_resolved_at = NOW(), last_error = NULL,
         updated_at = NOW()
       WHERE CASE robinhood_token_attributions.source
               WHEN 'blockscout' THEN 0 WHEN 'rpc_code_transition' THEN 0
               WHEN 'rpc_direct' THEN 1
               WHEN 'rpc_trace' THEN 1 WHEN 'blockscout_internal' THEN 1 ELSE 2 END
             <= CASE EXCLUDED.source
                  WHEN 'rpc_direct' THEN 1
                  WHEN 'rpc_trace' THEN 1 WHEN 'blockscout_internal' THEN 1 ELSE 2 END`,
      [
        deployments.map((item) => item.tokenAddress),
        deployments.map((item) => item.creatorAddress),
        deployments.map((item) => item.transactionHash),
        deployments.map((item) => item.source),
        deployments.map((item) => item.factoryAddress),
        deployments.map((item) => item.blockNumber),
      ]
    );
  }

  async function recordCodeTransitions(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length === 0) return Object.freeze({ attributed: 0 });
    const transitions = inputs.map((input) => ({
      tokenAddress: normalizeTokenAddress(CHAIN, input.tokenAddress),
      blockNumber: BigInt(String(input.blockNumber)).toString(),
    }));
    const result = await database.query(
      `INSERT INTO robinhood_token_attributions (
         chain, token_address, creator_address, source, attribution_block,
         attribution_tx_hash, attribution_factory_address,
         last_attempted_at, last_resolved_at, last_error
       ) SELECT '${CHAIN}', item.token_address, NULL, 'rpc_code_transition',
                item.block_number, NULL, NULL, NOW(), NULL, NULL
           FROM UNNEST($1::varchar[], $2::bigint[]) AS item(token_address, block_number)
       ON CONFLICT (chain, token_address) DO UPDATE SET
         creator_address = NULL, source = EXCLUDED.source,
         attribution_block = EXCLUDED.attribution_block,
         attribution_tx_hash = NULL, attribution_factory_address = NULL,
         last_attempted_at = NOW(), last_resolved_at = NULL,
         last_error = NULL, updated_at = NOW()
       WHERE robinhood_token_attributions.source IN ('blockscout', 'rpc_code_transition')
         AND (robinhood_token_attributions.attribution_block IS NULL
           OR robinhood_token_attributions.attribution_block = EXCLUDED.attribution_block)
       RETURNING token_address`,
      [transitions.map((item) => item.tokenAddress), transitions.map((item) => item.blockNumber)]
    );
    return Object.freeze({ attributed: result.rowCount });
  }

  async function recordCreatorBlock(input = {}) {
    const blockNumber = BigInt(String(input.blockNumber)).toString();
    const nextBlock = (BigInt(blockNumber) + 1n).toString();
    const safeHead = BigInt(String(input.safeHead)).toString();
    const deployments = normalizeDeployments(input.deployments, blockNumber);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await upsertDeployments(client, deployments);
      const advanced = await client.query(
        `UPDATE robinhood_direct_creator_cursors
         SET next_block = $1::bigint, safe_head = GREATEST(safe_head, $2::bigint),
             checkpoint_block = $3::bigint, checkpoint_hash = $4,
             checkpoint_timestamp = $5::timestamptz, updated_at = NOW()
         WHERE chain = '${CHAIN}' AND stream = 'live' AND next_block = $3::bigint
         RETURNING *`,
        [nextBlock, safeHead, blockNumber, input.blockHash, input.blockTimestamp]
      );
      if (advanced.rowCount !== 1) throw Object.assign(new Error('direct creator cursor conflict'), {
        code: 'cursor_conflict', retryable: true,
      });
      await client.query('COMMIT');
      return { cursor: advanced.rows[0], attributed: deployments.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordVerifiedDirectDeployments(inputs = []) {
    const deployments = normalizeDeployments(inputs);
    if (deployments.some((item) => (
      !['blockscout_internal', 'rpc_direct', 'rpc_trace', 'launchpad_event'].includes(item.source)
      || (['blockscout_internal', 'rpc_trace', 'launchpad_event'].includes(item.source)
        !== (item.factoryAddress !== null))
    ))) {
      throw new Error('verified deployment evidence has invalid provenance');
    }
    if (!deployments.length) return Object.freeze({ attributed: 0 });
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await upsertDeployments(client, deployments);
      await client.query('COMMIT');
      return Object.freeze({ attributed: deployments.length });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function recordLaunchpadBackfillRange(input = {}) {
    const fromBlock = BigInt(String(input.fromBlock));
    const toBlock = BigInt(String(input.toBlock));
    const safeHead = BigInt(String(input.safeHead)).toString();
    if (toBlock < fromBlock) throw new Error('launchpad backfill range is invalid');
    const deployments = normalizeDeployments(input.deployments);
    if (deployments.some((item) => (
      BigInt(item.blockNumber) < fromBlock || BigInt(item.blockNumber) > toBlock
    ))) throw new Error('launchpad deployment is outside its backfill range');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await upsertDeployments(client, deployments);
      const advanced = await client.query(
        `UPDATE robinhood_direct_creator_cursors
         SET next_block = $1::bigint + 1, safe_head = GREATEST(safe_head, $2::bigint),
             checkpoint_block = $1, checkpoint_hash = $3,
             checkpoint_timestamp = $4::timestamptz, updated_at = NOW()
         WHERE chain = '${CHAIN}' AND stream = '${BACKFILL_STREAM}' AND next_block = $5::bigint
         RETURNING *`,
        [toBlock.toString(), safeHead, input.checkpointHash, input.checkpointTimestamp, fromBlock.toString()]
      );
      if (advanced.rowCount !== 1) throw Object.assign(new Error('launchpad backfill cursor conflict'), {
        code: 'cursor_conflict', retryable: true,
      });
      await client.query('COMMIT');
      return { cursor: advanced.rows[0], attributed: deployments.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({
    initializeDirectCursor, initializeLaunchpadBackfillCursor,
    listCreatorCandidates, listHolderDirectVerificationCandidates,
    loadDirectCursor, loadLaunchpadBackfillCursor,
    recordAttempt, recordAttempts, recordCodeTransitions, recordCreatorBlock,
    recordDirectVerificationFailure,
    recordLaunchpadBackfillRange,
    recordVerifiedDirectDeployments,
  });
}

module.exports = {
  createRobinhoodTokenAttributionRepository,
  __private: { boundedLimit, verificationCandidateOptions },
};
