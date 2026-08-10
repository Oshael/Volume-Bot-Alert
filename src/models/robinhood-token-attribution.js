const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const LIVE_SOURCES = new Set(['rpc_direct', 'launchpad_event']);
const LIVE_STREAM = 'live';
const BACKFILL_STREAM = 'launchpad_backfill';

function boundedLimit(value, fallback = 1000) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10000) return fallback;
  return parsed;
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
      if ((item.source === 'launchpad_event') !== (item.factoryAddress !== null)) {
        throw new Error('launchpad creator source requires its factory address');
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
               WHEN 'blockscout' THEN 0 WHEN 'rpc_direct' THEN 1 ELSE 2 END
             <= CASE EXCLUDED.source WHEN 'rpc_direct' THEN 1 ELSE 2 END`,
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
    listCreatorCandidates, loadDirectCursor, loadLaunchpadBackfillCursor,
    recordAttempt, recordAttempts, recordCreatorBlock, recordLaunchpadBackfillRange,
  });
}

module.exports = { createRobinhoodTokenAttributionRepository, __private: { boundedLimit } };
