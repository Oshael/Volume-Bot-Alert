'use strict';

const db = require('./db');
const { dayBounds, lockRobinhoodTransferRetentionDay, partitionName } =
  require('./robinhood-token-transfer-persistence');
const { lockRobinhoodCanonicalRecoveryShared } =
  require('./robinhood-canonical-projection-fence');
const { __private: readinessProbes } =
  require('./robinhood-wallet-transfer-retention-readiness');
const { PREIMAGE_COVERAGE_SQL } = require('./robinhood-wallet-position-preimage-coverage');

const CHAIN = 'robinhood';
const VERSION = 'rh_transfer_v1';
const POSITION_VERSION = 'unified_transfer_v1';
const EDGE_KINDS = ['wallet_transfer', 'dex_flow'];

function assertInput(input) {
  const day = String(input.day || '');
  dayBounds(day);
  const version = String(input.expectedWatermarkVersion ?? '');
  if (!/^\d+$/.test(version)) throw new Error('expectedWatermarkVersion is required');
  const now = input.now == null ? new Date() : new Date(input.now);
  if (Number.isNaN(now.getTime())) throw new Error('now must be a valid timestamp');
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - 3);
  if (day >= cutoff.toISOString().slice(0, 10)) {
    throw new Error('transfer partition has not passed the three-day cutoff');
  }
  return { day, version };
}

function matchesDailyBound(bound, day) {
  const match = String(bound || '').match(/FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/);
  if (!match) return false;
  const { from, to } = dayBounds(day);
  return Date.parse(match[1]) === Date.parse(from)
    && Date.parse(match[2]) === Date.parse(to);
}

async function lockVerifiedWatermark(client, day, version, name) {
  const result = await client.query(
    `SELECT watermark.version::text, watermark.lifecycle_state,
            watermark.dropped_at, watermark.raw_event_count::text,
            watermark.target_classified_event_count::text,
            watermark.eligible_transfer_count::text,
            watermark.eligible_amount_raw::text,
            watermark.summary_transfer_count::text,
            watermark.summary_amount_raw::text,
            watermark.raw_last_block::text,
            watermark.checkpoint_hash,
            watermark.summary_reconciled, watermark.position_complete,
            watermark.evidence_complete, watermark.cursor_complete,
            watermark.checkpoint_canonical,
            child.relname AS actual_partition,
            pg_get_expr(child.relpartbound, child.oid) AS partition_bound,
            inheritance.inhparent=parent.oid AS attached
       FROM robinhood_wallet_transfer_compaction_watermarks watermark
       LEFT JOIN pg_class child ON child.oid=to_regclass($4)
       LEFT JOIN pg_class parent
         ON parent.oid='public.robinhood_token_transfer_events'::regclass
       LEFT JOIN pg_inherits inheritance ON inheritance.inhrelid=child.oid
         AND inheritance.inhparent=parent.oid
      WHERE watermark.chain=$1 AND watermark.projection_version=$2
        AND watermark.partition_day=$3::date
      FOR UPDATE OF watermark`,
    [CHAIN, VERSION, day, `public.${name}`]
  );
  const row = result.rows[0];
  if (!row || row.version !== version || row.lifecycle_state !== 'verified'
      || row.dropped_at || row.actual_partition !== name || row.attached !== true
      || !matchesDailyBound(row.partition_bound, day)
      || !['summary_reconciled', 'position_complete', 'evidence_complete',
        'cursor_complete', 'checkpoint_canonical'].every((field) => row[field] === true)) {
    throw new Error('transfer retention watermark or partition changed');
  }
  return row;
}

async function assertCurrentProjection(client, day, watermark) {
  const { to } = dayBounds(day);
  const cursors = await client.query(
    `SELECT transfer.lifecycle_state AS transfer_state,
            transfer.next_block_time AS transfer_time,
            transfer.next_block AS transfer_next,
            position.lifecycle_state AS position_state,
            position.next_block AS position_next
       FROM robinhood_wallet_transfer_cursors transfer
       JOIN robinhood_wallet_position_cursors position ON position.chain=transfer.chain
         AND position.projection_version=$3 AND position.stream='live'
      WHERE transfer.chain=$1 AND transfer.projection_version=$2
        AND transfer.stream='live'`,
    [CHAIN, VERSION, POSITION_VERSION]
  );
  const row = cursors.rows[0];
  if (!row || !['running', 'complete'].includes(row.transfer_state)
      || !['running', 'complete'].includes(row.position_state)
      || !row.transfer_time || new Date(row.transfer_time).getTime() < Date.parse(to)
      || (watermark.raw_last_block !== null
        && (BigInt(row.transfer_next) <= BigInt(watermark.raw_last_block)
          || BigInt(row.position_next) <= BigInt(watermark.raw_last_block)))) {
    throw new Error('transfer or position projection no longer covers the raw day');
  }
}

async function assertReconciled(client, partition, day, watermark) {
  const result = await client.query(
    `WITH totals AS (
       SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE classification_version=$3)::text AS classified,
              COUNT(*) FILTER (WHERE classification_version=$3
                AND transfer_kind=ANY($4::text[]))::text AS eligible,
              COALESCE(SUM(amount_raw) FILTER (WHERE classification_version=$3
                AND transfer_kind=ANY($4::text[])), 0)::text AS amount
         FROM ${partition} WHERE chain=$1
     ), raw AS (
       SELECT token_address, COUNT(*)::bigint AS transfer_count,
              COALESCE(SUM(amount_raw), 0) AS total_amount_raw
         FROM ${partition}
        WHERE chain=$1 AND classification_version=$3
          AND transfer_kind=ANY($4::text[])
        GROUP BY token_address
     ), summarized AS (
       SELECT token_address, transfer_count, total_amount_raw
         FROM robinhood_wallet_transfer_daily_summaries
        WHERE chain=$1 AND projection_version=$3 AND summary_day=$2::date
     ), compared AS (
       SELECT raw.transfer_count AS raw_count, raw.total_amount_raw AS raw_amount,
              summarized.transfer_count, summarized.total_amount_raw,
              summarized.token_address AS summary_token
         FROM raw FULL JOIN summarized USING (token_address)
     ) SELECT totals.*,
              COALESCE(SUM(transfer_count), 0)::text AS summary_total,
              COALESCE(SUM(total_amount_raw), 0)::text AS summary_amount,
              COUNT(*) FILTER (WHERE (raw_count IS NOT NULL OR summary_token IS NOT NULL)
                AND (raw_count IS NULL OR summary_token IS NULL
                  OR raw_count <> transfer_count OR raw_amount <> total_amount_raw))::text
                AS mismatches
         FROM totals LEFT JOIN compared ON true GROUP BY totals.total, totals.classified,
           totals.eligible, totals.amount`,
    [CHAIN, day, VERSION, EDGE_KINDS]
  );
  const row = result.rows[0];
  if (!row || row.total !== watermark.raw_event_count
      || row.classified !== watermark.target_classified_event_count
      || row.eligible !== watermark.eligible_transfer_count
      || row.amount !== watermark.eligible_amount_raw
      || row.summary_total !== watermark.summary_transfer_count
      || row.summary_amount !== watermark.summary_amount_raw
      || row.mismatches !== '0') {
    throw new Error('transfer raw, summaries or watermark no longer reconcile');
  }
}

async function assertDependencies(client, day, name, watermark) {
  const { from, to } = dayBounds(day);
  const candidate = { partitionDay: day, watermarkVersion: watermark.version };
  const probes = {
    ...readinessProbes.probeSql(`public.${name}`, from, to, watermark.raw_last_block),
    canonicalCheckpointNotProven: readinessProbes.canonicalCheckpointProbe(candidate, VERSION),
    positionPreimageCoverageMissing: { sql: PREIMAGE_COVERAGE_SQL, params: [CHAIN] },
  };
  for (const [nameOfProbe, probe] of Object.entries(probes)) {
    const result = await client.query(probe.sql, probe.params);
    const present = result.rows[0]?.present;
    if (typeof present !== 'boolean') throw new Error(`${nameOfProbe} returned no verdict`);
    if (present && nameOfProbe !== 'endpointRoleGapOnUnknown') {
      throw new Error(`${nameOfProbe} still requires transfer raw`);
    }
  }
}

function createRobinhoodWalletTransferRetentionTransaction(options = {}) {
  const database = options.database || db;
  const lockRecovery = options.lockRecovery || lockRobinhoodCanonicalRecoveryShared;

  async function withVerifiedPartition(input, action) {
    const { day, version } = assertInput(input);
    if (typeof action !== 'function') throw new TypeError('a same-transaction action is required');
    const name = partitionName(day);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      await lockRecovery(client);
      await lockRobinhoodTransferRetentionDay(client, day);
      await client.query(`LOCK TABLE public.${name} IN ACCESS EXCLUSIVE MODE`);
      const position = await client.query(
        `SELECT 1 FROM robinhood_wallet_position_cursors
          WHERE chain=$1 AND projection_version=$2 AND stream='live' FOR UPDATE`,
        [CHAIN, POSITION_VERSION]
      );
      if (position.rowCount !== 1) throw new Error('LIVE position cursor is missing');
      const watermark = await lockVerifiedWatermark(client, day, version, name);
      await assertCurrentProjection(client, day, watermark);
      await assertReconciled(client, `public.${name}`, day, watermark);
      await assertDependencies(client, day, name, watermark);
      const result = await action(client, { day, partition: `public.${name}`,
        watermarkVersion: version, checkpointHash: watermark.checkpoint_hash });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return { withVerifiedPartition };
}

module.exports = { createRobinhoodWalletTransferRetentionTransaction };
