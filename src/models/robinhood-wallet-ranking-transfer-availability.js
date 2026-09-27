const db = require('./db');

const CHAIN = 'robinhood';
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const AVAILABILITY_SQL = `SELECT requested.partition_day::text AS partition_day,
    child.relname AS partition_name,
    pg_get_expr(child.relpartbound, child.oid) AS partition_bound,
    inheritance.inhparent IS NOT NULL AS attached,
    EXISTS (
      SELECT 1 FROM robinhood_wallet_transfer_compaction_watermarks watermark
      WHERE watermark.chain = '${CHAIN}'
        AND watermark.partition_day = requested.partition_day
        AND (watermark.lifecycle_state = 'dropped' OR watermark.dropped_at IS NOT NULL)
    ) AS dropped
  FROM unnest($1::date[]) AS requested(partition_day)
  LEFT JOIN pg_class parent
    ON parent.oid = to_regclass('robinhood_token_transfer_events')
  LEFT JOIN pg_class child
    ON child.relnamespace = parent.relnamespace
   AND child.relname = 'robinhood_token_transfer_events_'
     || to_char(requested.partition_day, 'YYYY_MM_DD')
  LEFT JOIN pg_inherits inheritance
    ON inheritance.inhparent = parent.oid AND inheritance.inhrelid = child.oid
  ORDER BY requested.partition_day`;

function utcDays(start, end) {
  const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const days = [];
  for (let time = first; time <= last; time += DAY_MS) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

function normalizeWindow(input) {
  const start = new Date(input.windowStart);
  const end = new Date(input.asOf);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
    || end <= start || end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new Error('windowStart/asOf must define a window of at most 30 days');
  }
  return { start, end, days: utcDays(start, end) };
}

function boundMatchesDay(bound, day) {
  const match = String(bound || '').match(/FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/);
  if (!match) return false;
  const from = Date.parse(match[1]);
  const to = Date.parse(match[2]);
  const expected = Date.parse(`${day}T00:00:00.000Z`);
  return from === expected && to === expected + DAY_MS;
}

function assessDay(row, day) {
  const reasons = [];
  if (!row || !row.partition_name) reasons.push('raw_transfer_partition_missing');
  else if (row.attached !== true) reasons.push('raw_transfer_partition_detached');
  else if (!boundMatchesDay(row.partition_bound, day)) {
    reasons.push('raw_transfer_partition_bound_mismatch');
  }
  if (row?.dropped === true) reasons.push('raw_transfer_partition_compacted');
  return { day, available: reasons.length === 0, reasons };
}

function createRobinhoodWalletRankingTransferAvailabilityRepository(options = {}) {
  const database = options.database || db;
  return {
    async inspectWindow(input = {}) {
      const { start, end, days } = normalizeWindow(input);
      const result = await database.queryWithStatementTimeout(
        AVAILABILITY_SQL, [days], TIMEOUT_MS,
      );
      const byDay = new Map(result.rows.map((row) => [row.partition_day, row]));
      const partitions = days.map((day) => assessDay(byDay.get(day), day));
      return {
        chain: CHAIN, windowStart: start.toISOString(), asOf: end.toISOString(),
        partitions, rawTransferAvailable: partitions.every((item) => item.available),
        sourceCoverageVerified: false,
      };
    },
  };
}

module.exports = { createRobinhoodWalletRankingTransferAvailabilityRepository };
