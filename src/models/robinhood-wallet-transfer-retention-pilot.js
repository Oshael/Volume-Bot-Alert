'use strict';

const { createHash } = require('node:crypto');
const db = require('./db');
const { createRobinhoodWalletTransferRetentionTransaction } =
  require('./robinhood-wallet-transfer-retention-transaction');

const CHAIN = 'robinhood';
const VERSION = 'rh_transfer_v1';
const PILOT_DAY = '2026-07-19';
const PILOT_PARTITION = 'public.robinhood_token_transfer_events_2026_07_19';
const JULY18 = '2026-07-18';
const JULY18_PARTITION = 'public.robinhood_token_transfer_events_2026_07_18';
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const SAMPLE_STATUS = 'sampled_with_approved_exceptions';
const EVIDENCE_REFERENCE = 'docs/robinhood-transfer-raw-pilot-2026-07-19-evidence.md';
const EXCEPTION_DIGEST = 'ace37565221e38090aaea1750d2999ae41021c96f242acf3f7eead22bbc7f9f1';
const JULY18_REFERENCE = 'docs/robinhood-transfer-raw-pilot-2026-07-18-evidence.md';
const JULY18_EXCEPTION = Object.freeze({
  transactionHash: '0x23004b2d3fe35075ef78307d85f5a70c2a287a8081df4ec04fc59fa8f60e330a',
  logIndex: 10,
  blockTime: '2026-07-18T01:31:07Z',
  blockNumber: 12587704,
  blockHash: '0x0bf3967c2f3db3e16a4a05ebfca0caab00d9b5e696cae16bb8781fb9441d6d3a',
  transactionIndex: 4,
  tokenAddress: '0x7e86381a763f0ecca2bdf27c54eac403ddd48123',
  fromWallet: '0x42f0a3b8405e1f19e97e22cf7e5526b20c5f8982',
  toWallet: '0xf578b20020678ea4d5ee3700a03e7da6eacc6303',
  amountRaw: '3886049765533112256',
  storedKind: 'wallet_transfer',
  replayedKind: 'contract_flow',
  recipientCodeBytesAtEvent: 0,
});

function exactJuly18Exception(item) {
  if (!item || typeof item !== 'object') return false;
  const keys = Object.keys(JULY18_EXCEPTION);
  return Object.keys(item).length === keys.length
    && keys.every((key) => item[key] === JULY18_EXCEPTION[key]);
}

function validJuly18Replay(replay) {
  return replay?.status === 'sampled_with_scoped_exception'
    && replay.evidenceReference === JULY18_REFERENCE
    && replay.sampleRows === 24 && replay.receiptsMatched === 24
    && replay.decisionMatches === 23 && replay.walletSelfPopulation === 172
    && replay.walletSelfEqualEndpoints === 172
    && Array.isArray(replay.missingKinds) && replay.missingKinds.length === 0
    && Array.isArray(replay.exceptions) && replay.exceptions.length === 1
    && exactJuly18Exception(replay.exceptions[0]);
}

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
  const day = input.day;
  if (day !== PILOT_DAY && day !== JULY18) {
    throw new Error('pilot drop is limited to 2026-07-18 or 2026-07-19');
  }
  const version = String(input.expectedWatermarkVersion ?? '');
  const hash = String(input.expectedCheckpointHash ?? '').toLowerCase();
  const report = input.pilotReport;
  if (!/^\d+$/.test(version) || !HASH_PATTERN.test(hash)) {
    throw new Error('pilot drop requires expected watermark version and checkpoint hash');
  }
  if (!report || report.day !== day || String(report.watermarkVersion) !== version
      || report.checkpointHash !== hash
      || !(day === JULY18 ? validJuly18Replay(report.archiveReplay)
        : validArchiveReplay(report.archiveReplay)
          && typeof report.approvedBy === 'string' && report.approvedBy.trim()
          && report.approvedAt && !Number.isNaN(Date.parse(report.approvedAt)))) {
    throw new Error('pilot parity report is missing, mismatched or unapproved');
  }
  return { day, partition: day === JULY18 ? JULY18_PARTITION : PILOT_PARTITION,
    version, hash, report };
}

async function assertJuly18Exception(client, partition) {
  const population = (await client.query(
    `SELECT COUNT(*)::int AS events,
            COUNT(*) FILTER (WHERE from_wallet=to_wallet)::int AS equal_endpoints
       FROM ${partition} WHERE chain=$1 AND transfer_kind='wallet_self'`, [CHAIN]
  )).rows[0];
  if (population?.events !== 172 || population.equal_endpoints !== 172) {
    throw new Error('pilot wallet_self population changed since July 18 audit');
  }
  const item = JULY18_EXCEPTION;
  const row = (await client.query(
    `SELECT block_number::text, block_hash, transaction_index, token_address,
            from_wallet, to_wallet, amount_raw::text, transfer_kind, classification_version
       FROM ${partition}
      WHERE chain=$1 AND transaction_hash=$2 AND log_index=$3
        AND block_time=$4::timestamptz`,
    [CHAIN, item.transactionHash, item.logIndex, item.blockTime]
  )).rows[0];
  if (!row || row.block_number !== String(item.blockNumber)
      || row.block_hash !== item.blockHash || row.transaction_index !== item.transactionIndex
      || row.token_address !== item.tokenAddress || row.from_wallet !== item.fromWallet
      || row.to_wallet !== item.toWallet || row.amount_raw !== item.amountRaw
      || row.transfer_kind !== item.storedKind || row.classification_version !== VERSION) {
    throw new Error('July 18 pilot exception changed since Archive audit');
  }
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
    const { day, partition, version, hash, report } = approvedReport(input);
    return gate.withVerifiedPartition({
      day, expectedWatermarkVersion: version, now: input.now,
    }, async (client, candidate) => {
      if (candidate.day !== day || candidate.partition !== partition
          || candidate.watermarkVersion !== version || candidate.checkpointHash !== hash) {
        throw new Error('pilot checkpoint changed after parity approval');
      }
      if (day === JULY18) await assertJuly18Exception(client, candidate.partition);
      else await assertSampledExceptions(client, candidate.partition, report.archiveReplay);
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
        [CHAIN, VERSION, day, version, hash]
      );
      if (marked.rowCount !== 1) throw new Error('pilot watermark changed during drop');
      await client.query(`DROP TABLE ${candidate.partition}`);
      return { mode: 'apply', day, dropped: true,
        partition: candidate.partition, heapPathBefore: relation.rows[0].heap_path,
        totalBytesBefore: relation.rows[0].total_bytes,
        watermarkVersionBefore: version, watermarkVersionAfter: marked.rows[0].version };
    });
  }

  return { drop };
}

module.exports = { PILOT_DAY, createRobinhoodWalletTransferRetentionPilot,
  __private: { assertSampledExceptions, assertJuly18Exception } };
