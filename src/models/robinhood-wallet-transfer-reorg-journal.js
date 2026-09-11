'use strict';

const { RETENTION_DAYS } = require('../utils/db-init-stage208');

const CHAIN = 'robinhood';
const EVIDENCE_ROLES = Object.freeze(['first', 'last', 'largest']);

function edgeKey(event) {
  return `edge:${event.tokenAddress}:${event.fromWallet}:${event.toWallet}`;
}
function dailyKey(event) {
  return `daily:${event.blockTime.slice(0, 10)}:${event.tokenAddress}`;
}
function relationshipBase(event) {
  const [left, right] = [event.fromWallet, event.toWallet].sort();
  return `${event.tokenAddress}:${left}:${right}`;
}
function evidenceKey(event, role) {
  return `evidence:${relationshipBase(event)}:${role}`;
}
function identities(events) {
  const edges = new Set();
  const daily = new Set();
  const evidence = new Set();
  for (const event of events) {
    edges.add(edgeKey(event));
    daily.add(dailyKey(event));
    if (event.transferKind === 'wallet_transfer') {
      for (const role of EVIDENCE_ROLES) evidence.add(evidenceKey(event, role));
    }
  }
  return { edges: [...edges], daily: [...daily], evidence: [...evidence] };
}
async function loadRows(client, projectionVersion, keys) {
  const current = new Map();
  const queries = [
    keys.edges.length && [
      `SELECT 'edge:' || token_address || ':' || from_wallet || ':' || to_wallet AS identity_key,
              to_jsonb(edge) || jsonb_build_object(
                'transfer_count', transfer_count::text,
                'total_amount_raw', total_amount_raw::text,
                'wallet_transfer_count', wallet_transfer_count::text,
                'dex_flow_count', dex_flow_count::text,
                'first_block', first_block::text, 'last_block', last_block::text,
                'largest_amount_raw', largest_amount_raw::text,
                'first_wallet_transfer_block', first_wallet_transfer_block::text,
                'first_wallet_transfer_amount_raw', first_wallet_transfer_amount_raw::text
              ) AS previous_row
         FROM robinhood_wallet_transfer_edges edge
        WHERE chain=$1 AND classification_version=$2
          AND ('edge:' || token_address || ':' || from_wallet || ':' || to_wallet)
            = ANY($3::text[])`,
      [CHAIN, projectionVersion, keys.edges],
    ],
    keys.daily.length && [
      `SELECT 'daily:' || summary_day::text || ':' || token_address AS identity_key,
              to_jsonb(summary) || jsonb_build_object(
                'transfer_count', transfer_count::text,
                'total_amount_raw', total_amount_raw::text,
                'wallet_transfer_count', wallet_transfer_count::text,
                'wallet_transfer_amount_raw', wallet_transfer_amount_raw::text,
                'dex_flow_count', dex_flow_count::text,
                'dex_flow_amount_raw', dex_flow_amount_raw::text,
                'through_block', through_block::text
              ) AS previous_row
         FROM robinhood_wallet_transfer_daily_summaries summary
        WHERE chain=$1 AND projection_version=$2
          AND ('daily:' || summary_day::text || ':' || token_address) = ANY($3::text[])`,
      [CHAIN, projectionVersion, keys.daily],
    ],
    keys.evidence.length && [
      `SELECT 'evidence:' || token_address || ':' || left_wallet || ':' || right_wallet
                || ':' || evidence_role AS identity_key,
              to_jsonb(evidence) || jsonb_build_object(
                'evidence_id', evidence_id::text,
                'evidence_block', evidence_block::text,
                'amount_raw', amount_raw::text
              ) AS previous_row
         FROM robinhood_wallet_relationship_evidence evidence
        WHERE chain=$1 AND algorithm_version=$2
          AND ('evidence:' || token_address || ':' || left_wallet || ':' || right_wallet
                || ':' || evidence_role) = ANY($3::text[])`,
      [CHAIN, projectionVersion, keys.evidence],
    ],
  ].filter(Boolean);
  for (const [sql, params] of queries) {
    const result = await client.query(sql, params);
    for (const row of result.rows) current.set(row.identity_key, row.previous_row);
  }
  return current;
}
function journalRows(batch, keys, current) {
  const rows = [{
    aggregate_kind: 'block_marker',
    identity_key: `range:${batch.first.block}:${batch.first.blockHash}`,
  }];
  for (const identityKey of keys.edges) {
    rows.push({ aggregate_kind: 'edge', identity_key: identityKey });
  }
  for (const identityKey of keys.daily) {
    rows.push({ aggregate_kind: 'daily_summary', identity_key: identityKey });
  }
  for (const identityKey of keys.evidence) {
    rows.push({ aggregate_kind: 'relationship_evidence', identity_key: identityKey });
  }
  return rows.map((row) => ({
    ...row, block_number: batch.last.block, block_hash: batch.last.blockHash,
    block_time: batch.last.blockTime, had_previous: current.has(row.identity_key),
    previous_row: current.get(row.identity_key) || null,
  }));
}
async function captureTransferPreimages(client, projectionVersion, events) {
  if (!events.length) return 0;
  if (events.some((event) => !event.blockHash)) {
    throw new Error('LIVE transfer preimages require canonical block hashes');
  }
  const hashes = new Map();
  for (const event of events) {
    if (hashes.has(event.block) && hashes.get(event.block) !== event.blockHash) {
      throw new Error('LIVE transfer batch contains competing block hashes');
    }
    hashes.set(event.block, event.blockHash);
  }
  const keys = identities(events);
  const current = await loadRows(client, projectionVersion, keys);
  const rows = journalRows({ first: events[0], last: events[events.length - 1] }, keys, current);
  const inserted = await client.query(
    `INSERT INTO robinhood_wallet_transfer_reorg_journal(
       chain, projection_version, block_number, block_hash, block_time,
       aggregate_kind, identity_key, had_previous, previous_row, expires_at
     ) SELECT $1, $2, item.block_number::bigint, item.block_hash,
       item.block_time::timestamptz, item.aggregate_kind, item.identity_key,
       item.had_previous, item.previous_row,
       item.block_time::timestamptz + INTERVAL '${RETENTION_DAYS} days'
       FROM jsonb_to_recordset($3::jsonb) AS item(
         block_number text, block_hash text, block_time text, aggregate_kind text,
         identity_key text, had_previous boolean, previous_row jsonb
       ) ON CONFLICT DO NOTHING`,
    [CHAIN, projectionVersion, JSON.stringify(rows)]
  );
  if (inserted.rowCount !== rows.length) {
    const error = new Error('transfer reorg preimage identity already exists');
    error.code = 'transfer_reorg_journal_conflict';
    throw error;
  }
  return inserted.rowCount;
}

module.exports = { captureTransferPreimages, __private: { identities } };
