const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const LIVE_SOURCES = new Set(['rpc_direct', 'launchpad_event']);

function boundedLimit(value, fallback = 1000) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10000) return fallback;
  return parsed;
}

function createRobinhoodTokenAttributionRepository(options = {}) {
  const database = options.database || db;

  async function loadDirectCursor() {
    const { rows } = await database.query(
      `SELECT * FROM robinhood_direct_creator_cursors
       WHERE chain = '${CHAIN}' AND stream = 'live'`
    );
    return rows[0] || null;
  }

  async function initializeDirectCursor(nextBlock) {
    const normalized = BigInt(String(nextBlock)).toString();
    await database.query(
      `INSERT INTO robinhood_direct_creator_cursors (chain, stream, next_block, safe_head)
       VALUES ('${CHAIN}', 'live', $1::bigint, $1::bigint)
       ON CONFLICT (chain, stream) DO NOTHING`,
      [normalized]
    );
    return loadDirectCursor();
  }

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

  async function recordCreatorBlock(input = {}) {
    const blockNumber = BigInt(String(input.blockNumber)).toString();
    const nextBlock = (BigInt(blockNumber) + 1n).toString();
    const safeHead = BigInt(String(input.safeHead)).toString();
    const deployments = (input.deployments || []).map((item) => ({
      tokenAddress: normalizeTokenAddress(CHAIN, item.tokenAddress),
      creatorAddress: normalizeTokenAddress(CHAIN, item.creatorAddress),
      transactionHash: String(item.transactionHash).toLowerCase(),
      source: String(item.source || 'rpc_direct'),
      factoryAddress: item.factoryAddress == null
        ? null : normalizeTokenAddress(CHAIN, item.factoryAddress),
    }));
    for (const item of deployments) {
      if (!LIVE_SOURCES.has(item.source)) throw new Error('live creator source is unsupported');
      if ((item.source === 'launchpad_event') !== (item.factoryAddress !== null)) {
        throw new Error('launchpad creator source requires its factory address');
      }
    }
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      if (deployments.length) await client.query(
         `INSERT INTO robinhood_token_attributions (
           chain, token_address, creator_address, source, attribution_block,
           attribution_tx_hash, attribution_factory_address,
           last_attempted_at, last_resolved_at, last_error
         ) SELECT '${CHAIN}', item.token_address, item.creator_address, item.source,
                  $6::bigint, item.transaction_hash, item.factory_address, NOW(), NOW(), NULL
           FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::varchar[])
             AS item(token_address, creator_address, transaction_hash, source, factory_address)
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
          blockNumber,
        ]
      );
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

  return Object.freeze({
    initializeDirectCursor, listCreatorCandidates, loadDirectCursor,
    recordAttempt, recordAttempts, recordCreatorBlock,
  });
}

module.exports = { createRobinhoodTokenAttributionRepository, __private: { boundedLimit } };
