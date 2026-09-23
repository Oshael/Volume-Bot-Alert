'use strict';

const db = require('./db');
const { createRobinhoodWalletTransferRetentionTransaction } =
  require('./robinhood-wallet-transfer-retention-transaction');

const CHAIN = 'robinhood';
const VERSION = 'rh_transfer_v1';
const PILOT_DAY = '2026-07-19';
const PILOT_PARTITION = 'public.robinhood_token_transfer_events_2026_07_19';
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

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
      || report.archiveReplay?.status !== 'matched'
      || typeof report.archiveReplay.evidenceReference !== 'string'
      || !report.archiveReplay.evidenceReference.trim()
      || typeof report.approvedBy !== 'string' || !report.approvedBy.trim()
      || !report.approvedAt || Number.isNaN(Date.parse(report.approvedAt))) {
    throw new Error('pilot parity report is missing, mismatched or unapproved');
  }
  return { version, hash, report };
}

function createRobinhoodWalletTransferRetentionPilot(options = {}) {
  const gate = options.gate || createRobinhoodWalletTransferRetentionTransaction({
    database: options.database || db,
  });

  async function drop(input = {}) {
    if (input.apply !== true || input.confirmed !== true) {
      throw new Error('pilot drop requires apply and exact day confirmation');
    }
    const { version, hash } = approvedReport(input);
    return gate.withVerifiedPartition({
      day: PILOT_DAY, expectedWatermarkVersion: version, now: input.now,
    }, async (client, candidate) => {
      if (candidate.day !== PILOT_DAY || candidate.partition !== PILOT_PARTITION
          || candidate.watermarkVersion !== version || candidate.checkpointHash !== hash) {
        throw new Error('pilot checkpoint changed after parity approval');
      }
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

module.exports = { PILOT_DAY, createRobinhoodWalletTransferRetentionPilot };
