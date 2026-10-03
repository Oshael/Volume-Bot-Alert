'use strict';

const { normalizeTokenAddress } = require('../utils/token-identity');
const { lockRobinhoodCanonicalProjection, __private: { normalizeFrontiers } } = require('./robinhood-canonical-projection-fence');

// Aliases/expressions are internal SQL constants, never caller-supplied values.
function anchorSurvivedRecoveriesSql(anchor, number) {
  return `NOT EXISTS (SELECT 1 FROM robinhood_chain_recoveries recovery
    WHERE recovery.chain=${anchor}.chain AND recovery.detected_at >= ${anchor}.created_at
      AND ${number} >= COALESCE((recovery.plan #>> '{affectedRange,fromBlock}')::bigint,0))`;
}
function legacyHolderSql(frontier) {
  return `FROM robinhood_holder_token_states holder
    JOIN robinhood_holder_legacy_coverage_manifest manifest
      ON manifest.chain=holder.chain AND manifest.token_address=holder.token_address
      AND manifest.coverage_generation=holder.coverage_generation
    WHERE holder.chain=${frontier}.chain AND holder.token_address=${frontier}.token_address
      AND holder.ledger_status='live' AND holder.tail_capture_from_block IS NULL
      AND holder.live_through_block=${frontier}.live_through_block
      AND holder.live_through_hash=${frontier}.live_through_hash`;
}
function holderCanonicalReadySql(frontier = 'state') {
  return `(EXISTS (SELECT 1 FROM robinhood_chain_blocks block
    WHERE block.chain=${frontier}.chain AND block.canonical
      AND block.block_number=${frontier}.live_through_block
      AND block.block_hash=${frontier}.live_through_hash)
    OR EXISTS (SELECT 1 ${legacyHolderSql(frontier)}
      AND EXISTS (SELECT 1 FROM robinhood_chain_capture_cursor cursor
        WHERE cursor.chain=holder.chain AND cursor.recovery_state='running'
          AND cursor.checkpoint_block >= holder.live_through_block)
      AND EXISTS (SELECT 1 FROM robinhood_chain_block_anchors anchor
        WHERE anchor.chain=holder.chain AND anchor.block_number=holder.live_through_block
          AND anchor.block_hash=holder.live_through_hash
          AND ${anchorSurvivedRecoveriesSql('anchor', 'holder.live_through_block')}
          AND NOT EXISTS (SELECT 1 FROM robinhood_chain_block_anchors other
            WHERE other.chain=anchor.chain AND other.block_number=anchor.block_number
              AND other.block_hash<>anchor.block_hash))
      AND NOT EXISTS (SELECT 1 FROM robinhood_chain_blocks block
        WHERE block.chain=holder.chain AND block.block_number=holder.live_through_block
          AND ((block.canonical AND block.block_hash<>holder.live_through_hash)
            OR (block.block_hash=holder.live_through_hash AND NOT block.canonical)))))`;
}

async function refreshVerifiedHolderAnchor(client, block) {
  // The caller holds the recovery fence and has just verified this exact header.
  await client.query(`UPDATE robinhood_chain_block_anchors anchor SET created_at=clock_timestamp()
    WHERE anchor.chain='robinhood' AND anchor.block_number=$1::bigint
      AND anchor.block_hash=$2 AND anchor.block_timestamp=$3::timestamptz
      AND NOT (${anchorSurvivedRecoveriesSql('anchor', 'anchor.block_number')})`,
  [block.blockNumber, block.blockHash, block.blockTime]);
}

async function lockRobinhoodHolderCanonicalProjection(client, frontiers, label, context = {}) {
  if (!context.legacyLedger) return lockRobinhoodCanonicalProjection(client, frontiers, label);
  await lockRobinhoodCanonicalProjection(client, null, label);
  const normalized = normalizeFrontiers(frontiers);
  if (!normalized.length) return;
  if (normalized.length !== 1) throw new Error('holder projection requires one ledger frontier');
  const [frontier] = normalized;
  const token = normalizeTokenAddress('robinhood', context.tokenAddress);
  const { rows } = await client.query(`WITH frontier AS (
    SELECT 'robinhood'::text AS chain,$1::bigint AS live_through_block,
      $2::text AS live_through_hash,$3::text AS token_address
  ) SELECT ${holderCanonicalReadySql('frontier')} AS ready, raw.block_timestamp,
    EXISTS (SELECT 1 ${legacyHolderSql('frontier')}
      FOR SHARE OF holder, manifest) AS legacy_eligible,
    EXISTS (SELECT 1 FROM robinhood_chain_block_anchors anchor
      WHERE anchor.chain=frontier.chain AND anchor.block_number=frontier.live_through_block
        AND anchor.block_hash=frontier.live_through_hash
        AND ${anchorSurvivedRecoveriesSql('anchor', 'frontier.live_through_block')}) AS preserved
    FROM frontier LEFT JOIN robinhood_chain_blocks raw ON raw.chain=frontier.chain
      AND raw.canonical AND raw.block_number=frontier.live_through_block
      AND raw.block_hash=frontier.live_through_hash`,
  [frontier.block_number, frontier.block_hash, token]);
  const row = rows[0];
  if (!row.ready || (row.block_timestamp == null && !row.legacy_eligible)) {
    throw Object.assign(new Error(`${label} write is not anchored to the canonical branch`), {
      code: 'canonical_projection_fence_conflict',
    });
  }
  if (row.block_timestamp != null && row.legacy_eligible && !row.preserved) {
    const block = { blockNumber: frontier.block_number,
      blockHash: frontier.block_hash, blockTime: row.block_timestamp };
    await client.query(`INSERT INTO robinhood_chain_block_anchors
      (chain,block_number,block_hash,block_timestamp,created_at)
      VALUES ('robinhood',$1::bigint,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING`,
    [block.blockNumber, block.blockHash, block.blockTime]);
    await refreshVerifiedHolderAnchor(client, block);
  }
}

module.exports = { holderCanonicalReadySql, refreshVerifiedHolderAnchor,
  lockRobinhoodHolderCanonicalProjection };
