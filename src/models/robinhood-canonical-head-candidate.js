'use strict';

const db = require('./db');
const { normalizeCaptureEntry } = require('./robinhood-head-capture');

const CHAIN = 'robinhood';

function recordOf(value) {
  const entry = normalizeCaptureEntry(value);
  return {
    stream: entry.stream, transaction_hash: entry.transactionHash,
    log_index: entry.logIndex, block_number: entry.blockNumber,
    block_hash: entry.blockHash, transaction_index: entry.transactionIndex,
    address: entry.address, topics: JSON.parse(entry.topics), data: entry.data,
    protocol: entry.protocol, market_key: entry.marketKey,
    evidence_version: entry.evidenceVersion, evidence: JSON.parse(entry.evidence),
  };
}

const INPUT = `jsonb_to_recordset($1::jsonb) item(
  stream text, transaction_hash text, log_index bigint, block_number bigint,
  block_hash text, transaction_index bigint, address text, topics jsonb,
  data text, protocol text, market_key text, evidence_version integer, evidence jsonb
)`;
const SAME = `candidate.stream=item.stream
  AND candidate.block_number=item.block_number AND candidate.block_hash=item.block_hash
  AND candidate.transaction_index=item.transaction_index AND candidate.address=item.address
  AND candidate.topics=item.topics AND candidate.data=item.data
  AND candidate.protocol IS NOT DISTINCT FROM item.protocol
  AND candidate.market_key IS NOT DISTINCT FROM item.market_key
  AND candidate.evidence_version=item.evidence_version AND candidate.evidence=item.evidence`;
const LEGACY_SHAPE_SAME = `legacy.stream=candidate.stream
  AND legacy.block_number=candidate.block_number AND legacy.block_hash=candidate.block_hash
  AND legacy.transaction_index=candidate.transaction_index AND legacy.address=candidate.address
  AND legacy.topics=candidate.topics AND legacy.data=candidate.data
  AND legacy.protocol IS NOT DISTINCT FROM candidate.protocol
  AND legacy.market_key IS NOT DISTINCT FROM candidate.market_key
  AND legacy.evidence_version=candidate.evidence_version`;
const LEGACY_SAME = `${LEGACY_SHAPE_SAME} AND legacy.evidence=candidate.evidence`;
const LEGACY_VOLATILE_SAME = `candidate.stream='market'
  AND legacy.evidence #- '{quoteUsd,priceUsd}' #- '{tokenMetadata,totalSupplyRaw}'
    = candidate.evidence #- '{quoteUsd,priceUsd}' #- '{tokenMetadata,totalSupplyRaw}'`;
const LEGACY_V3_QUALITY_UPGRADE = `candidate.stream='market'
  AND candidate.protocol='uniswap-v3'
  AND legacy.evidence #>> '{v3,balanceStatus}'='unavailable_backfill'
  AND legacy.evidence #> '{v3,tokenBalanceRaw}'='null'::jsonb
  AND legacy.evidence #> '{v3,quoteBalanceRaw}'='null'::jsonb
  AND candidate.evidence #>> '{v3,balanceStatus}'='observed'
  AND candidate.evidence #>> '{v3,tokenBalanceRaw}' ~ '^\\d+$'
  AND candidate.evidence #>> '{v3,quoteBalanceRaw}' ~ '^\\d+$'
  AND legacy.evidence #- '{quoteUsd,priceUsd}' #- '{tokenMetadata,totalSupplyRaw}'
      #- '{v3,balanceStatus}' #- '{v3,tokenBalanceRaw}' #- '{v3,quoteBalanceRaw}'
    = candidate.evidence #- '{quoteUsd,priceUsd}' #- '{tokenMetadata,totalSupplyRaw}'
      #- '{v3,balanceStatus}' #- '{v3,tokenBalanceRaw}' #- '{v3,quoteBalanceRaw}'`;
const LEGACY_COMPATIBLE = `${LEGACY_SHAPE_SAME}
  AND (legacy.evidence=candidate.evidence OR (${LEGACY_VOLATILE_SAME})
    OR (${LEGACY_V3_QUALITY_UPGRADE}))`;
const MATURE = 'cursor.next_block IS NOT NULL AND candidate.block_number < cursor.next_block';

function optionalBlock(value, label) {
  if (value == null || value === '') return null;
  const block = String(value).trim();
  if (!/^\d+$/.test(block)) throw new Error(`${label} must be a non-negative integer`);
  return block;
}

function optionalTimestamp(value, label) {
  if (value == null || value === '') return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return timestamp.toISOString();
}

function createRobinhoodCanonicalHeadCandidateRepository(options = {}) {
  const database = options.database || db;

  async function appendCaptureEntries(input = {}) {
    const entries = (Array.isArray(input.entries) ? input.entries : []).map(recordOf);
    if (!entries.length) return { insertedCaptures: 0, duplicateCaptures: 0 };
    const payload = JSON.stringify(entries);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO robinhood_canonical_head_candidates(
           chain, stream, transaction_hash, log_index, block_number, block_hash,
           transaction_index, address, topics, data, protocol, market_key,
           evidence_version, evidence
         ) SELECT $2, item.* FROM ${INPUT}
         ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
         RETURNING 1`, [payload, CHAIN]
      );
      const verified = await client.query(
        `SELECT COUNT(candidate.chain)::int AS found,
                COUNT(*) FILTER (WHERE ${SAME})::int AS compatible
           FROM ${INPUT}
           LEFT JOIN robinhood_canonical_head_candidates candidate
             ON candidate.chain=$2 AND candidate.transaction_hash=item.transaction_hash
            AND candidate.log_index=item.log_index`, [payload, CHAIN]
      );
      if (verified.rows[0].found !== entries.length
          || verified.rows[0].compatible !== entries.length) {
        const error = new Error('canonical head candidate replay diverged');
        error.code = 'canonical_candidate_conflict';
        throw error;
      }
      await client.query('COMMIT');
      return {
        insertedCaptures: inserted.rowCount,
        duplicateCaptures: entries.length - inserted.rowCount,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function getParitySummary(input = {}) {
    const fromBlock = optionalBlock(input.fromBlock, 'fromBlock');
    const toBlock = optionalBlock(input.toBlock, 'toBlock');
    const capturedAfter = optionalTimestamp(input.capturedAfter, 'capturedAfter');
    const result = await database.query(
      `SELECT candidate.stream, COUNT(*)::int AS candidates,
              COUNT(*) FILTER (WHERE ${MATURE})::int AS mature_candidates,
              COUNT(*) FILTER (WHERE cursor.next_block IS NULL
                OR candidate.block_number >= cursor.next_block)::int AS awaiting_legacy,
              COUNT(*) FILTER (WHERE ${MATURE} AND legacy.chain IS NULL)::int AS missing_legacy,
              COUNT(*) FILTER (WHERE ${MATURE} AND legacy.chain IS NOT NULL
                AND ${LEGACY_SAME})::int AS matched,
              COUNT(*) FILTER (WHERE ${MATURE} AND legacy.chain IS NOT NULL
                AND ${LEGACY_SHAPE_SAME}
                AND ${LEGACY_V3_QUALITY_UPGRADE})::int AS quality_upgrade,
              COUNT(*) FILTER (WHERE ${MATURE} AND legacy.chain IS NOT NULL
                AND ${LEGACY_COMPATIBLE} AND NOT (${LEGACY_SAME})
                AND NOT (${LEGACY_V3_QUALITY_UPGRADE}))::int AS volatile_drift,
              COUNT(*) FILTER (WHERE ${MATURE} AND legacy.chain IS NOT NULL
                AND NOT (${LEGACY_COMPATIBLE}))::int AS divergent,
              MIN(candidate.block_number)::text AS first_block,
              MAX(candidate.block_number)::text AS last_block
         FROM robinhood_canonical_head_candidates candidate
         LEFT JOIN robinhood_head_captures legacy
           ON legacy.chain=candidate.chain
          AND legacy.transaction_hash=candidate.transaction_hash
          AND legacy.log_index=candidate.log_index
         LEFT JOIN robinhood_head_capture_cursors cursor
           ON cursor.chain=candidate.chain AND cursor.stream=candidate.stream
        WHERE candidate.chain=$1
          AND ($2::bigint IS NULL OR candidate.block_number >= $2)
          AND ($3::bigint IS NULL OR candidate.block_number <= $3)
          AND ($4::timestamptz IS NULL OR candidate.captured_at >= $4)
        GROUP BY candidate.stream ORDER BY candidate.stream`,
      [CHAIN, fromBlock, toBlock, capturedAfter]
    );
    return result.rows;
  }

  return Object.freeze({ appendCaptureEntries, getParitySummary });
}

module.exports = { createRobinhoodCanonicalHeadCandidateRepository };
