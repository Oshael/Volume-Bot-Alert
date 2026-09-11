'use strict';

const {
  persistTransferProjection,
} = require('./robinhood-wallet-transfer-projection');

const CHAIN = 'robinhood';
const EDGE_KINDS = Object.freeze(['wallet_transfer', 'dex_flow']);

function conflict(message) {
  return Object.assign(new Error(message), { code: 'transfer_recovery_fence_conflict' });
}
function markerStart(marker) {
  const match = String(marker.identity_key || '').match(/^range:(\d+):(0x[0-9a-f]{64})$/);
  if (!match) throw conflict('transfer journal range marker is invalid');
  return { block: match[1], hash: match[2] };
}
async function loadCursors(client, range) {
  const result = await client.query(
    `SELECT cursor.*, EXISTS (
       SELECT 1 FROM robinhood_chain_blocks block
        WHERE block.chain=cursor.chain AND block.canonical
          AND block.block_number=cursor.checkpoint_block
          AND block.block_hash=cursor.checkpoint_hash
     ) AS checkpoint_canonical
      FROM robinhood_wallet_transfer_cursors cursor
      WHERE cursor.chain=$1 AND cursor.stream='live'
        AND (cursor.next_block, cursor.next_transaction_index, cursor.next_log_index)
          > ($2::bigint, 0, 0)
      ORDER BY cursor.projection_version FOR UPDATE`,
    [CHAIN, range.fromBlock]
  );
  for (const cursor of result.rows) {
    if (!['pending', 'running'].includes(cursor.lifecycle_state)
        || cursor.checkpoint_block == null || cursor.checkpoint_hash == null
        || BigInt(cursor.checkpoint_block) < BigInt(range.fromBlock)
        || BigInt(cursor.checkpoint_block) > BigInt(range.throughBlock)
        || cursor.checkpoint_canonical !== true) {
      throw conflict(`${cursor.projection_version} transfer cursor is outside the orphan branch`);
    }
  }
  return result.rows;
}
async function loadMarkers(client, range, cursor) {
  const result = await client.query(
    `SELECT journal.block_number::text, journal.block_hash, journal.block_time,
            journal.identity_key
       FROM robinhood_wallet_transfer_reorg_journal journal
       INNER JOIN robinhood_chain_blocks anchor
         ON anchor.chain=journal.chain AND anchor.canonical
        AND anchor.block_number=journal.block_number
        AND anchor.block_hash=journal.block_hash
      WHERE journal.chain=$1 AND journal.projection_version=$2
        AND journal.aggregate_kind='block_marker'
        AND journal.block_number BETWEEN $3::bigint AND $4::bigint
      ORDER BY journal.block_number DESC`,
    [CHAIN, cursor.projection_version, range.fromBlock, cursor.checkpoint_block]
  );
  for (const marker of result.rows) {
    const start = markerStart(marker);
    const canonical = await client.query(
      `SELECT 1 FROM robinhood_chain_blocks WHERE chain=$1 AND canonical
        AND block_number=$2::bigint AND block_hash=$3`,
      [CHAIN, start.block, start.hash]
    );
    if (canonical.rowCount !== 1) throw conflict('transfer journal range is not canonical');
    marker.range_start = start.block;
  }
  return result.rows;
}
async function assertCoverage(client, range, cursor, markers) {
  const result = await client.query(
    `SELECT DISTINCT transfer.block_number::text
       FROM robinhood_token_transfer_events transfer
       INNER JOIN robinhood_chain_blocks block
         ON block.chain=transfer.chain AND block.canonical
        AND block.block_number=transfer.block_number AND block.block_hash=transfer.block_hash
      WHERE transfer.chain=$1 AND transfer.classification_version=$2
        AND transfer.transfer_kind=ANY($3::text[])
        AND transfer.block_number BETWEEN $4::bigint AND $5::bigint
        AND transfer.block_time BETWEEN $6::timestamptz AND $7::timestamptz
        AND (transfer.block_number, transfer.transaction_index, transfer.log_index)
          < ($8::bigint, $9::integer, $10::integer)`,
    [CHAIN, cursor.projection_version, EDGE_KINDS, range.fromBlock,
      cursor.checkpoint_block, range.fromTimestamp, range.throughTimestamp,
      cursor.next_block, cursor.next_transaction_index, cursor.next_log_index]
  );
  const uncovered = result.rows.find(({ block_number: block }) => !markers.some((marker) => (
    BigInt(marker.range_start) <= BigInt(block) && BigInt(marker.block_number) >= BigInt(block)
  )));
  if (uncovered) throw conflict(`transfer block ${uncovered.block_number} has no preimage`);
}
const TABLES = Object.freeze({
  edge: {
    table: 'robinhood_wallet_transfer_edges',
    key: "'edge:' || token_address || ':' || from_wallet || ':' || to_wallet",
    scope: 'target.chain=$1 AND target.classification_version=$2',
  },
  daily_summary: {
    table: 'robinhood_wallet_transfer_daily_summaries',
    key: "'daily:' || summary_day::text || ':' || token_address",
    scope: 'target.chain=$1 AND target.projection_version=$2',
  },
  relationship_evidence: {
    table: 'robinhood_wallet_relationship_evidence',
    key: "'evidence:' || token_address || ':' || left_wallet || ':' || right_wallet || ':' || evidence_role",
    scope: 'target.chain=$1 AND target.algorithm_version=$2',
  },
});
async function restoreKind(client, cursor, marker, kind, config) {
  const params = [CHAIN, cursor.projection_version, marker.block_hash, kind];
  await client.query(
    `DELETE FROM ${config.table} target USING robinhood_wallet_transfer_reorg_journal journal
      WHERE ${config.scope}
        AND journal.chain=$1 AND journal.projection_version=$2 AND journal.block_hash=$3
        AND journal.aggregate_kind=$4 AND (${config.key})=journal.identity_key`, params
  );
  await client.query(
    `INSERT INTO ${config.table}
       SELECT restored.* FROM robinhood_wallet_transfer_reorg_journal journal
       CROSS JOIN LATERAL jsonb_populate_record(NULL::${config.table}, journal.previous_row) restored
      WHERE journal.chain=$1 AND journal.projection_version=$2 AND journal.block_hash=$3
        AND journal.aggregate_kind=$4 AND journal.had_previous`, params
  );
}
async function preservePrefixJournal(client, range, cursor, marker) {
  if (BigInt(marker.range_start) > BigInt(range.ancestorBlock)) return false;
  await client.query(
    `INSERT INTO robinhood_wallet_transfer_reorg_journal(
       chain, projection_version, block_number, block_hash, block_time,
       aggregate_kind, identity_key, had_previous, previous_row, expires_at, created_at
     ) SELECT chain, projection_version, $4::bigint, $5, $6::timestamptz,
              aggregate_kind, identity_key, had_previous, previous_row,
              $6::timestamptz + INTERVAL '3 days', created_at
       FROM robinhood_wallet_transfer_reorg_journal
      WHERE chain=$1 AND projection_version=$2 AND block_hash=$3`,
    [CHAIN, cursor.projection_version, marker.block_hash, range.ancestorBlock,
      range.ancestorHash, range.ancestorTimestamp]
  );
  return true;
}
async function replayPrefix(client, range, cursor, marker) {
  if (BigInt(marker.range_start) > BigInt(range.ancestorBlock)) return 0;
  const result = await client.query(
    `SELECT transfer.block_number AS "blockNumber", transfer.block_hash AS "blockHash",
            transfer.block_time AS "blockTime", transfer.transaction_hash AS "transactionHash",
            transfer.transaction_index AS "transactionIndex", transfer.log_index AS "logIndex",
            transfer.token_address AS "tokenAddress", transfer.from_wallet AS "fromWallet",
            transfer.to_wallet AS "toWallet", transfer.amount_raw AS "amountRaw",
            transfer.transfer_kind AS "transferKind",
            transfer.classification_version AS "classificationVersion"
       FROM robinhood_token_transfer_events transfer
       INNER JOIN robinhood_chain_blocks block
         ON block.chain=transfer.chain AND block.canonical
        AND block.block_number=transfer.block_number AND block.block_hash=transfer.block_hash
      WHERE transfer.chain=$1 AND transfer.classification_version=$2
        AND transfer.transfer_kind=ANY($3::text[])
        AND transfer.block_number BETWEEN $4::bigint AND $5::bigint
      ORDER BY transfer.block_number, transfer.transaction_index, transfer.log_index`,
    [CHAIN, cursor.projection_version, EDGE_KINDS, marker.range_start, range.ancestorBlock]
  );
  await persistTransferProjection(client, cursor.projection_version, result.rows);
  return result.rowCount;
}
async function restoreCursor(client, range, cursor) {
  const result = await client.query(
    `UPDATE robinhood_wallet_transfer_cursors SET
       next_block=$3::bigint, next_transaction_index=0, next_log_index=0,
       next_block_time=$4::timestamptz, safe_head=$2::bigint,
       checkpoint_block=$2::bigint, checkpoint_hash=$5,
       lifecycle_state='running', state_reason=NULL, completed_at=NULL, failed_at=NULL,
       version=version+1, updated_at=NOW()
     WHERE chain=$1 AND projection_version=$6 AND stream='live' AND version=$7
       AND next_block=$8::bigint AND checkpoint_block=$9::bigint AND checkpoint_hash=$10`,
    [CHAIN, range.ancestorBlock, range.fromBlock, range.ancestorTimestamp,
      range.ancestorHash, cursor.projection_version, cursor.version, cursor.next_block,
      cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (result.rowCount !== 1) throw conflict('transfer cursor changed during recovery');
}
function createRobinhoodWalletTransferReorgRollback() {
  async function rollback(client, range) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('transfer rollback requires a transaction client');
    }
    const cursors = await loadCursors(client, range);
    const summary = { projections: cursors.length, restoredBatches: 0, replayedPrefix: 0 };
    for (const cursor of cursors) {
      const markers = await loadMarkers(client, range, cursor);
      await assertCoverage(client, range, cursor, markers);
      for (const marker of markers) {
        await preservePrefixJournal(client, range, cursor, marker);
        for (const [kind, config] of Object.entries(TABLES)) {
          await restoreKind(client, cursor, marker, kind, config);
        }
        await client.query(
          `DELETE FROM robinhood_wallet_transfer_reorg_journal
            WHERE chain=$1 AND projection_version=$2 AND block_hash=$3`,
          [CHAIN, cursor.projection_version, marker.block_hash]
        );
        summary.replayedPrefix += await replayPrefix(client, range, cursor, marker);
        summary.restoredBatches += 1;
      }
      await restoreCursor(client, range, cursor);
    }
    const deleted = await client.query(
      `DELETE FROM robinhood_token_transfer_events transfer USING robinhood_chain_blocks block
        WHERE transfer.chain=$1 AND block.chain=transfer.chain AND block.canonical
          AND block.block_number=transfer.block_number AND block.block_hash=transfer.block_hash
          AND transfer.block_number BETWEEN $2::bigint AND $3::bigint
          AND transfer.block_time BETWEEN $4::timestamptz AND $5::timestamptz`,
      [CHAIN, range.fromBlock, range.throughBlock, range.fromTimestamp, range.throughTimestamp]
    );
    return { ...summary, deletedRawTransfers: deleted.rowCount, cursorsRewound: cursors.length };
  }
  return Object.freeze({ rollback });
}

module.exports = { createRobinhoodWalletTransferReorgRollback, __private: { markerStart } };
