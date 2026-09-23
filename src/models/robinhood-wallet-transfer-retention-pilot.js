'use strict';

const { createHash } = require('node:crypto');
const db = require('./db');
const { createRobinhoodWalletTransferRetentionTransaction } =
  require('./robinhood-wallet-transfer-retention-transaction');

const CHAIN = 'robinhood';
const VERSION = 'rh_transfer_v1';
const PILOT_DAY = '2026-07-19';
const PILOT_PARTITION = 'public.robinhood_token_transfer_events_2026_07_19';
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const SAMPLE_STATUS = 'sampled_with_approved_exceptions';
const EVIDENCE_REFERENCE = 'docs/robinhood-transfer-raw-pilot-2026-07-19-evidence.md';
const EXCEPTION_DIGEST = 'ace37565221e38090aaea1750d2999ae41021c96f242acf3f7eead22bbc7f9f1';

function exceptionDigest(exceptions) {
  if (!Array.isArray(exceptions) || exceptions.length !== 12) return null;
  const tuples = exceptions.map((item) => [item.transactionHash, item.logIndex,
    item.blockTime, item.blockNumber, item.blockHash, item.transactionIndex,
    item.storedKind, item.replayedKind]);
  tuples.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
}

function validArchiveReplay(replay) {
  if (!replay || typeof replay.evidenceReference !== 'string'
      || !replay.evidenceReference.trim()) return false;
  if (replay.status === 'matched') return true;
  return replay.status === SAMPLE_STATUS
    && replay.evidenceReference === EVIDENCE_REFERENCE
    && replay.sampleRows === 56 && replay.receiptsMatched === 56
    && replay.decisionMatches === 44 && replay.walletSelfPopulation === 35
    && replay.walletSelfEqualEndpoints === 35 && replay.walletSelfReceiptsMatched === 35
    && Array.isArray(replay.missingKinds) && replay.missingKinds.length === 0
    && exceptionDigest(replay.exceptions) === EXCEPTION_DIGEST;
}

function approvedReport(input) {
  if (input.day !== PILOT_DAY) throw new Error('pilot drop is limited to 2026-07-19');
  const version = String(input.expectedWatermarkVersion ?? '');
  const hash = String(input.expectedCheckpointHash ?? '').toLowerCase();
  const report = input.pilotReport;
  if (!/^\d+$/.test(version) || !HASH_PATTERN.test(hash)) {
    throw new Error('pilot drop requires expected watermark version and checkpoint hash');
  }
  if (!report || report.day !== PILOT_DAY || String(report.watermarkVersion) !== version
      || report.checkpointHash !== hash
      || !validArchiveReplay(report.archiveReplay)
      || typeof report.approvedBy !== 'string' || !report.approvedBy.trim()
      || !report.approvedAt || Number.isNaN(Date.parse(report.approvedAt))) {
    throw new Error('pilot parity report is missing, mismatched or unapproved');
  }
  return { version, hash, report };
}

async function assertSampledExceptions(client, partition, replay) {
  if (replay.status !== SAMPLE_STATUS) return;
  const population = await client.query(
    `SELECT COUNT(*)::int AS events,
            COUNT(*) FILTER (WHERE from_wallet=to_wallet)::int AS equal_endpoints
       FROM ${partition} WHERE chain=$1 AND transfer_kind='wallet_self'`, [CHAIN]
  );
  if (population.rows[0]?.events !== 35 || population.rows[0]?.equal_endpoints !== 35) {
    throw new Error('pilot wallet_self population changed since approval');
  }
  for (const item of replay.exceptions) {
    const row = (await client.query(
      `SELECT block_number::text, block_hash, transaction_index, transfer_kind,
              classification_version, from_wallet=to_wallet AS equal_endpoints
         FROM ${partition}
        WHERE chain=$1 AND transaction_hash=$2 AND log_index=$3
          AND block_time=$4::timestamptz`,
      [CHAIN, item.transactionHash, item.logIndex, item.blockTime]
    )).rows[0];
    if (!row || row.block_number !== String(item.blockNumber)
        || row.block_hash !== item.blockHash
        || row.transaction_index !== item.transactionIndex
        || row.transfer_kind !== 'wallet_self'
        || row.classification_version !== VERSION || row.equal_endpoints !== true) {
      throw new Error(`pilot exception changed: ${item.transactionHash}:${item.logIndex}`);
    }
  }
}

function createRobinhoodWalletTransferRetentionPilot(options = {}) {
  const gate = options.gate || createRobinhoodWalletTransferRetentionTransaction({
    database: options.database || db,
  });

  async function drop(input = {}) {
    if (input.apply !== true || input.confirmed !== true) {
      throw new Error('pilot drop requires apply and exact day confirmation');
    }
    const { version, hash, report } = approvedReport(input);
    return gate.withVerifiedPartition({
      day: PILOT_DAY, expectedWatermarkVersion: version, now: input.now,
    }, async (client, candidate) => {
      if (candidate.day !== PILOT_DAY || candidate.partition !== PILOT_PARTITION
          || candidate.watermarkVersion !== version || candidate.checkpointHash !== hash) {
        throw new Error('pilot checkpoint changed after parity approval');
      }
      await assertSampledExceptions(client, candidate.partition, report.archiveReplay);
      const relation = await client.query(
        `SELECT pg_relation_filepath($1::regclass) AS heap_path,
                pg_total_relation_size($1::regclass)::text AS total_bytes`,
        [candidate.partition]
      );
      if (!relation.rows[0]?.heap_path || !/^\d+$/.test(relation.rows[0]?.total_bytes)) {
        throw new Error('pilot partition size or location is unavailable');
      }
      const marked = await client.query(
        `UPDATE robinhood_wallet_transfer_compaction_watermarks
            SET lifecycle_state='dropped', dropped_at=NOW(), version=version+1,
                updated_at=NOW()
          WHERE chain=$1 AND projection_version=$2 AND partition_day=$3::date
            AND lifecycle_state='verified' AND dropped_at IS NULL
            AND version=$4::bigint AND checkpoint_hash=$5
          RETURNING version::text AS version`,
        [CHAIN, VERSION, PILOT_DAY, version, hash]
      );
      if (marked.rowCount !== 1) throw new Error('pilot watermark changed during drop');
      await client.query(`DROP TABLE ${candidate.partition}`);
      return { mode: 'apply', day: PILOT_DAY, dropped: true,
        partition: candidate.partition, heapPathBefore: relation.rows[0].heap_path,
        totalBytesBefore: relation.rows[0].total_bytes,
        watermarkVersionBefore: version, watermarkVersionAfter: marked.rows[0].version };
    });
  }

  return { drop };
}

module.exports = { PILOT_DAY, createRobinhoodWalletTransferRetentionPilot,
  __private: { assertSampledExceptions } };
