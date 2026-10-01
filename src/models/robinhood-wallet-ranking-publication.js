'use strict';

const db = require('./db');

const SOURCES = ['positions', 'transfers', 'swaps', 'prices', 'reorg'];
const WINDOWS = new Set(['24h', '7d', '30d', 'ALL']);
const MAX_BIGINT = 9223372036854775807n;
const REVISIONS = `current_revisions AS (
  SELECT jsonb_object_agg(source, COALESCE(version,0)::text) AS revisions
  FROM (VALUES ('positions'),('transfers'),('swaps'),('prices'),('reorg')) sources(source)
  LEFT JOIN robinhood_wallet_ranking_revisions USING (source)
)`;
const PUBLISH_SQL = `WITH ${REVISIONS}
  INSERT INTO robinhood_wallet_ranking_publications AS published (
    chain,projection_version,ranking_window,generation,as_of,checkpoint_block,
    checkpoint_hash,source_revisions,payload)
  SELECT 'robinhood',$1::varchar,$2::varchar,$3::bigint+1,
    $4::timestamptz,$5::bigint,$6::varchar,$7::jsonb,$8::jsonb
  FROM robinhood_wallet_position_cursors cursor
  JOIN robinhood_chain_blocks block ON block.chain=cursor.chain
    AND block.block_number=$5::bigint AND block.block_hash=$6 AND block.canonical
  JOIN robinhood_chain_blocks tip ON tip.chain=cursor.chain
    AND tip.block_number=cursor.checkpoint_block AND tip.block_hash=cursor.checkpoint_hash
    AND tip.canonical AND tip.block_timestamp=cursor.next_block_time
  CROSS JOIN current_revisions
  WHERE cursor.chain='robinhood' AND cursor.projection_version=$1
    AND cursor.stream='live' AND cursor.lifecycle_state='running'
    AND cursor.checkpoint_block >= $5::bigint AND cursor.next_block=cursor.checkpoint_block+1
    AND cursor.safe_head >= cursor.checkpoint_block
    AND cursor.next_block_time >= $4::timestamptz AND block.block_timestamp=$4::timestamptz
    AND current_revisions.revisions->>'reorg'=$7::jsonb->>'reorg'
    AND NOT EXISTS (SELECT 1 FROM jsonb_each_text($7::jsonb) offered
      JOIN jsonb_each_text(current_revisions.revisions) live USING (key)
      WHERE offered.value::bigint > live.value::bigint)
    AND ($3::bigint=0 OR EXISTS (
      SELECT 1 FROM robinhood_wallet_ranking_publications previous
      WHERE previous.chain='robinhood' AND previous.projection_version=$1
        AND previous.ranking_window=$2 AND previous.generation=$3::bigint))
  ON CONFLICT (chain,projection_version,ranking_window) DO UPDATE SET
    generation=EXCLUDED.generation,as_of=EXCLUDED.as_of,
    checkpoint_block=EXCLUDED.checkpoint_block,checkpoint_hash=EXCLUDED.checkpoint_hash,
    source_revisions=EXCLUDED.source_revisions,payload=EXCLUDED.payload,
    published_at=clock_timestamp()
  WHERE published.generation=$3::bigint
    AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(published.source_revisions) old
      JOIN jsonb_each_text(EXCLUDED.source_revisions) newer USING (key)
      WHERE newer.value::bigint < old.value::bigint)
    AND (published.source_revisions,published.payload,published.as_of)
      IS DISTINCT FROM (EXCLUDED.source_revisions,EXCLUDED.payload,EXCLUDED.as_of)
    AND (EXCLUDED.as_of>=published.as_of OR
      (EXCLUDED.source_revisions->>'reorg')::bigint > (published.source_revisions->>'reorg')::bigint)
  RETURNING generation::text`;
const READ_SQL = `WITH ${REVISIONS}
  SELECT published.*,published.generation::text AS generation,
    published.checkpoint_block::text AS checkpoint_block,
    published.source_revisions=current_revisions.revisions AS is_fresh
  FROM robinhood_wallet_ranking_publications published
  JOIN robinhood_chain_blocks block ON block.chain=published.chain
    AND block.block_number=published.checkpoint_block
    AND block.block_hash=published.checkpoint_hash AND block.canonical
    AND block.block_timestamp=published.as_of
  CROSS JOIN current_revisions
  WHERE published.chain='robinhood' AND published.projection_version=$1
    AND published.ranking_window=$2
    AND published.source_revisions->>'reorg'=current_revisions.revisions->>'reorg'`;

function integer(value, label, maximum = MAX_BIGINT) {
  const text = String(value ?? '');
  if ((typeof value === 'number' && !Number.isSafeInteger(value))
      || !/^\d+$/.test(text) || BigInt(text) > maximum) throw new Error(`${label} is invalid`);
  return BigInt(text).toString();
}

function identity(input) {
  const projectionVersion = input.projectionVersion ?? 'unified_transfer_v1';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(projectionVersion)) {
    throw new Error('projectionVersion is invalid');
  }
  if (!WINDOWS.has(input.window)) throw new Error('window is invalid');
  return [projectionVersion, input.window];
}

function revisions(input) {
  if (!input || Object.keys(input).length !== SOURCES.length) {
    throw new Error('sourceRevisions must contain all five sources');
  }
  return Object.fromEntries(SOURCES.map((source) => [source, integer(input[source], source)]));
}

function payload(result) {
  if (result?.candidateUniverseComplete !== true || !Array.isArray(result.ranked)
      || result.ranked.length > 100) throw new Error('publication requires a complete candidate universe');
  const seen = new Set();
  for (const [index, row] of result.ranked.entries()) {
    if (row.rank !== index + 1 || !/^0x[0-9a-f]{40}$/.test(row.walletAddress)
        || typeof row.gainUsd !== 'string' || !/^-?\d+(\.\d{1,36})?$/.test(row.gainUsd)
        || !Number.isSafeInteger(row.openPositionCount) || row.openPositionCount < 1
        || seen.has(row.walletAddress)) throw new Error('ranked row is invalid');
    seen.add(row.walletAddress);
  }
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > 65536) throw new Error('publication payload exceeds 64 KiB');
  return serialized;
}

function publication(input) {
  const result = input.result;
  const serialized = payload(result);
  const id = identity({ ...input, window: result.window });
  const asOf = new Date(result.asOf);
  if (result.asOf == null || !Number.isFinite(asOf.getTime())) throw new Error('asOf is invalid');
  if (!/^0x[0-9a-f]{64}$/.test(input.checkpointHash)) throw new Error('checkpointHash is invalid');
  return [...id, integer(input.expectedGeneration, 'expectedGeneration', MAX_BIGINT - 1n),
    asOf.toISOString(), integer(input.checkpointBlock, 'checkpointBlock', MAX_BIGINT - 1n),
    input.checkpointHash, JSON.stringify(revisions(input.sourceRevisions)), serialized];
}

function createRobinhoodWalletRankingPublicationRepository(options = {}) {
  const database = options.database || db;
  return {
    async getRevisions() {
      const result = await database.queryWithStatementTimeout(
        `WITH ${REVISIONS} SELECT revisions FROM current_revisions`, [], 5000
      );
      return result.rows[0].revisions;
    },
    async publish(input = {}) {
      const result = await database.queryWithStatementTimeout(PUBLISH_SQL, publication(input), 5000);
      return { published: result.rows.length === 1, generation: result.rows[0]?.generation ?? null };
    },
    async getCurrent(input = {}) {
      const result = await database.queryWithStatementTimeout(READ_SQL, identity(input), 5000);
      const row = result.rows[0];
      return row ? { generation: row.generation, asOf: row.as_of.toISOString(),
        checkpointBlock: row.checkpoint_block, checkpointHash: row.checkpoint_hash,
        sourceRevisions: row.source_revisions, result: row.payload,
        isFresh: row.is_fresh, publishedAt: row.published_at.toISOString() } : null;
    },
  };
}

module.exports = { createRobinhoodWalletRankingPublicationRepository };
