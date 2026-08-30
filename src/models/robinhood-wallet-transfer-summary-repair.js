const db = require('./db');
const {
  RAW_RETENTION_DAYS,
  dayBounds,
  partitionName,
} = require('./robinhood-token-transfer-persistence');

const CHAIN = 'robinhood';
const EDGE_KINDS = ['wallet_transfer', 'dex_flow'];

function identifier(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function cutoffDay(now = new Date()) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(String(now));
  if (Number.isNaN(date.getTime())) throw new Error('now must be a valid timestamp');
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - RAW_RETENTION_DAYS);
  return date.toISOString().slice(0, 10);
}

function normalize(input = {}) {
  const partitionDay = dayBounds(input.partitionDay).from.slice(0, 10);
  const projectionVersion = identifier(input.projectionVersion, 'projectionVersion');
  const statementTimeoutMs = Number(input.statementTimeoutMs ?? 600_000);
  if (!Number.isSafeInteger(statementTimeoutMs)
      || statementTimeoutMs < 10_000 || statementTimeoutMs > 1_800_000) {
    throw new Error('statementTimeoutMs must be between 10000 and 1800000');
  }
  const retentionCutoffDay = cutoffDay(input.now);
  if (partitionDay >= retentionCutoffDay) {
    throw new Error(`partition day must be before retention cutoff ${retentionCutoffDay}`);
  }
  return {
    partitionDay, projectionVersion, statementTimeoutMs, retentionCutoffDay,
    partition: partitionName(partitionDay), ...dayBounds(partitionDay),
  };
}

async function assertPartition(client, input) {
  const result = await client.query(
    `SELECT child.relname AS partition, inheritance.inhparent = parent.oid AS attached,
            pg_get_expr(child.relpartbound, child.oid) AS partition_bound
       FROM pg_namespace namespace
       JOIN pg_class child ON child.relnamespace = namespace.oid AND child.relname = $1
       JOIN pg_class parent ON parent.relnamespace = namespace.oid
        AND parent.relname = 'robinhood_token_transfer_events'
       LEFT JOIN pg_inherits inheritance ON inheritance.inhrelid = child.oid
        AND inheritance.inhparent = parent.oid
      WHERE namespace.nspname = 'public'`,
    [input.partition]
  );
  const row = result.rows[0];
  if (!row || row.attached !== true) throw new Error('expected raw partition is not attached');
  const bounds = String(row.partition_bound || '').match(
    /FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/
  );
  if (!bounds || new Date(bounds[1]).toISOString() !== input.from
      || new Date(bounds[2]).toISOString() !== input.to) {
    throw new Error('raw partition bounds do not match requested UTC day');
  }
  return row;
}

async function snapshot(client, input) {
  const result = await client.query(
    `WITH raw AS (
       SELECT COUNT(*)::text AS raw_event_count,
              COUNT(*) FILTER (WHERE classification_version = $1)::text
                AS target_classified_event_count,
              COUNT(*) FILTER (WHERE classification_version = $1
                AND transfer_kind = ANY($2::text[]))::text AS eligible_transfer_count,
              COALESCE(SUM(amount_raw) FILTER (WHERE classification_version = $1
                AND transfer_kind = ANY($2::text[])), 0)::text AS eligible_amount_raw
         FROM ${input.partition}
     ), summary AS (
       SELECT COUNT(*)::text AS summary_token_count,
              COALESCE(SUM(transfer_count), 0)::text AS summary_transfer_count,
              COALESCE(SUM(total_amount_raw), 0)::text AS summary_amount_raw
         FROM robinhood_wallet_transfer_daily_summaries
        WHERE chain = $3 AND projection_version = $1 AND summary_day = $4::date
     ) SELECT * FROM raw CROSS JOIN summary`,
    [input.projectionVersion, EDGE_KINDS, CHAIN, input.partitionDay]
  );
  return result.rows[0];
}

async function summarySnapshot(client, input) {
  const result = await client.query(
    `SELECT COUNT(*)::text AS summary_token_count,
            COALESCE(SUM(transfer_count), 0)::text AS summary_transfer_count,
            COALESCE(SUM(total_amount_raw), 0)::text AS summary_amount_raw
       FROM robinhood_wallet_transfer_daily_summaries
      WHERE chain = $1 AND projection_version = $2 AND summary_day = $3::date`,
    [CHAIN, input.projectionVersion, input.partitionDay]
  );
  return result.rows[0];
}

function createRobinhoodWalletTransferSummaryRepair(options = {}) {
  const database = options.database || db;

  async function inspectDay(rawInput = {}) {
    const input = normalize(rawInput);
    const client = await database.getClient();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(input.statementTimeoutMs),
      ]);
      await assertPartition(client, input);
      const result = await snapshot(client, input);
      await client.query('COMMIT');
      return { ...input, ...result };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function rebuildDay(rawInput = {}) {
    const input = normalize(rawInput);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(input.statementTimeoutMs),
      ]);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('rh-transfer-summary-repair'), hashtext($1))",
        [`${input.projectionVersion}:${input.partitionDay}`]
      );
      await assertPartition(client, input);
      await client.query(`LOCK TABLE ${input.partition} IN SHARE MODE`);
      const before = await snapshot(client, input);
      if (before.raw_event_count !== before.target_classified_event_count) {
        throw new Error('raw partition classification is incomplete');
      }
      const dropped = await client.query(
        `SELECT 1 FROM robinhood_wallet_transfer_compaction_watermarks
          WHERE chain = $1 AND projection_version = $2 AND partition_day = $3::date
            AND lifecycle_state = 'dropped'`,
        [CHAIN, input.projectionVersion, input.partitionDay]
      );
      if (dropped.rowCount) throw new Error('cannot rebuild a dropped compaction day');
      const removed = await client.query(
        `DELETE FROM robinhood_wallet_transfer_daily_summaries
          WHERE chain = $1 AND projection_version = $2 AND summary_day = $3::date`,
        [CHAIN, input.projectionVersion, input.partitionDay]
      );
      const inserted = await client.query(
        `WITH aggregate AS MATERIALIZED (
           SELECT token_address, COUNT(*)::bigint AS transfer_count,
                  SUM(amount_raw)::numeric AS total_amount_raw,
                  COUNT(*) FILTER (WHERE transfer_kind = 'wallet_transfer')::bigint
                    AS wallet_transfer_count,
                  COALESCE(SUM(amount_raw) FILTER (
                    WHERE transfer_kind = 'wallet_transfer'), 0)::numeric
                    AS wallet_transfer_amount_raw,
                  COUNT(*) FILTER (WHERE transfer_kind = 'dex_flow')::bigint
                    AS dex_flow_count,
                  COALESCE(SUM(amount_raw) FILTER (
                    WHERE transfer_kind = 'dex_flow'), 0)::numeric AS dex_flow_amount_raw,
                  MAX(ARRAY[block_number, transaction_index::bigint, log_index::bigint])
                    AS through_position
         FROM ${input.partition}
            WHERE chain = $3 AND classification_version = $1
              AND transfer_kind = ANY($2::text[])
            GROUP BY token_address
         ) INSERT INTO robinhood_wallet_transfer_daily_summaries (
           chain, projection_version, summary_day, token_address,
           transfer_count, total_amount_raw, wallet_transfer_count,
           wallet_transfer_amount_raw, dex_flow_count, dex_flow_amount_raw,
           through_block, through_transaction_index, through_log_index, through_block_time
         ) SELECT $3, $1, $4::date, aggregate.token_address,
                  aggregate.transfer_count, aggregate.total_amount_raw,
                  aggregate.wallet_transfer_count, aggregate.wallet_transfer_amount_raw,
                  aggregate.dex_flow_count, aggregate.dex_flow_amount_raw,
                  aggregate.through_position[1], aggregate.through_position[2]::integer,
                  aggregate.through_position[3]::integer, event.block_time
             FROM aggregate
             JOIN ${input.partition} event
               ON event.chain = $3 AND event.token_address = aggregate.token_address
              AND event.block_number = aggregate.through_position[1]
              AND event.transaction_index = aggregate.through_position[2]
              AND event.log_index = aggregate.through_position[3]`,
        [input.projectionVersion, EDGE_KINDS, CHAIN, input.partitionDay]
      );
      const invalidated = await client.query(
        `UPDATE robinhood_wallet_transfer_compaction_watermarks SET
           lifecycle_state = 'pending', state_reason = NULL, audited_at = NULL,
           verified_at = NULL, summary_reconciled = false, evidence_complete = false,
           version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND partition_day = $3::date`,
        [CHAIN, input.projectionVersion, input.partitionDay]
      );
      const after = { ...before, ...(await summarySnapshot(client, input)) };
      await client.query('COMMIT');
      return {
        ...input, before, after, summariesRemoved: removed.rowCount || 0,
        summariesWritten: inserted.rowCount || 0,
        watermarksInvalidated: invalidated.rowCount || 0,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return { inspectDay, rebuildDay };
}

module.exports = {
  cutoffDay,
  createRobinhoodWalletTransferSummaryRepair,
};
