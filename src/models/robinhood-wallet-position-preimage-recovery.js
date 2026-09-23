'use strict';

const CHAIN = 'robinhood';
const TABLE = 'robinhood_wallet_position_reorg_preimages';

function archiveRequired(message) {
  return Object.assign(new Error(message), { code: 'archive_required' });
}

function coveredMarkers(rows, fromBlock, checkpointBlock) {
  let expected = BigInt(checkpointBlock);
  const floor = BigInt(fromBlock);
  const covered = [];
  for (const marker of rows) {
    if (expected < floor) break;
    if (BigInt(marker.through_block) !== expected
        || BigInt(marker.from_block) > expected) {
      throw archiveRequired(`position preimage gap at block ${expected}`);
    }
    covered.push(marker);
    expected = BigInt(marker.from_block) - 1n;
  }
  if (expected >= floor) throw archiveRequired(`position preimage gap at block ${expected}`);
  return covered;
}

async function loadCoveredMarkers(client, range, cursor) {
  const result = await client.query(
    `SELECT marker.from_block::text, marker.through_block::text,
            marker.checkpoint_hash, start.block_timestamp AS from_time
       FROM ${TABLE} marker
       INNER JOIN robinhood_chain_blocks start
         ON start.chain=marker.chain AND start.canonical
        AND start.block_number=marker.from_block
       INNER JOIN robinhood_chain_blocks finish
         ON finish.chain=marker.chain AND finish.canonical
        AND finish.block_number=marker.through_block
        AND finish.block_hash=marker.checkpoint_hash
      WHERE marker.chain=$1 AND marker.projection_version=$2
        AND marker.record_kind='batch' AND marker.identity_key='batch'
        AND marker.through_block BETWEEN $3::bigint AND $4::bigint
      ORDER BY marker.through_block DESC`,
    [CHAIN, cursor.projection_version, range.fromBlock, cursor.checkpoint_block]
  );
  return coveredMarkers(result.rows, range.fromBlock, cursor.checkpoint_block);
}

async function restoreMarker(client, cursor, marker, range) {
  const params = [CHAIN, cursor.projection_version, marker.through_block,
    marker.checkpoint_hash];
  const rows = await client.query(
    `SELECT split_part(identity_key, ':', 1) AS token_address,
            split_part(identity_key, ':', 2) AS wallet_address
       FROM ${TABLE}
      WHERE chain=$1 AND projection_version=$2 AND through_block=$3::bigint
        AND checkpoint_hash=$4 AND record_kind='position'
      ORDER BY identity_key`, params
  );
  const invalid = await client.query(
    `SELECT 1 FROM ${TABLE}
      WHERE chain=$1 AND projection_version=$2 AND through_block=$3::bigint
        AND checkpoint_hash=$4 AND record_kind='position' AND had_previous
        AND (previous_row->>'chain' IS DISTINCT FROM chain
          OR previous_row->>'projection_version' IS DISTINCT FROM projection_version
          OR ((previous_row->>'token_address') || ':'
              || (previous_row->>'wallet_address')) IS DISTINCT FROM identity_key)
      LIMIT 1`, params
  );
  if (invalid.rowCount) throw archiveRequired('position preimage identity is inconsistent');
  const removed = await client.query(
    `DELETE FROM robinhood_wallet_token_positions position USING ${TABLE} preimage
      WHERE preimage.chain=$1 AND preimage.projection_version=$2
        AND preimage.through_block=$3::bigint AND preimage.checkpoint_hash=$4
        AND preimage.record_kind='position'
        AND position.chain=preimage.chain
        AND position.projection_version=preimage.projection_version
        AND position.token_address=split_part(preimage.identity_key, ':', 1)
        AND position.wallet_address=split_part(preimage.identity_key, ':', 2)`, params
  );
  const rebuilt = await client.query(
    `INSERT INTO robinhood_wallet_token_positions
       SELECT restored.* FROM ${TABLE} preimage
       CROSS JOIN LATERAL jsonb_populate_record(
         NULL::robinhood_wallet_token_positions, preimage.previous_row
       ) restored
      WHERE preimage.chain=$1 AND preimage.projection_version=$2
        AND preimage.through_block=$3::bigint AND preimage.checkpoint_hash=$4
        AND preimage.record_kind='position' AND preimage.had_previous`, params
  );
  const hasPrefix = BigInt(marker.from_block) <= BigInt(range.ancestorBlock);
  if (hasPrefix) await client.query(
    `INSERT INTO ${TABLE} (
       chain, projection_version, from_block, through_block, checkpoint_hash,
       block_time, record_kind, identity_key, had_previous, previous_row, expires_at
     ) SELECT chain, projection_version, from_block, $5::bigint, $6,
              $7::timestamptz, record_kind, identity_key, had_previous,
              previous_row, $7::timestamptz + INTERVAL '3 days'
         FROM ${TABLE}
        WHERE chain=$1 AND projection_version=$2 AND through_block=$3::bigint
          AND checkpoint_hash=$4`,
    [...params, range.ancestorBlock, range.ancestorHash, range.ancestorTimestamp]
  );
  await client.query(
    `DELETE FROM ${TABLE}
      WHERE chain=$1 AND projection_version=$2 AND through_block=$3::bigint
        AND checkpoint_hash=$4`, params
  );
  return { pairs: rows.rows, hasPrefix,
    removed: removed.rowCount, rebuilt: rebuilt.rowCount };
}

module.exports = { loadCoveredMarkers, restoreMarker, __private: { coveredMarkers } };
