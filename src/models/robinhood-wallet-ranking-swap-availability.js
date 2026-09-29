const db = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 30 * DAY_MS;
const TIMEOUT_MS = 5000;

const AVAILABILITY_SQL = `SELECT requested.partition_day::text AS partition_day,
    child.relname AS partition_name,
    pg_get_expr(child.relpartbound, child.oid) AS partition_bound,
    inheritance.inhparent IS NOT NULL AS attached
  FROM unnest($1::date[]) AS requested(partition_day)
  LEFT JOIN pg_class parent
    ON parent.oid = to_regclass('robinhood_wallet_swaps')
  LEFT JOIN pg_class child
    ON child.relnamespace = parent.relnamespace
   AND child.relname = 'robinhood_wallet_swaps_'
     || to_char(requested.partition_day, 'YYYY_MM_DD')
  LEFT JOIN pg_inherits inheritance
    ON inheritance.inhparent = parent.oid AND inheritance.inhrelid = child.oid
  ORDER BY requested.partition_day`;

function windowDays(input) {
  const start = new Date(input.windowStart);
  const end = new Date(input.asOf);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
    || end <= start || end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new Error('windowStart/asOf must define a window of at most 30 days');
  }
  const days = [];
  const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let time = first; time <= last; time += DAY_MS) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return { start, end, days };
}

function boundMatchesDay(bound, day) {
  const match = String(bound || '').match(/FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/);
  if (!match) return false;
  const expected = Date.parse(`${day}T00:00:00.000Z`);
  return Date.parse(match[1]) === expected && Date.parse(match[2]) === expected + DAY_MS;
}

function assessDay(row, day) {
  const reasons = [];
  if (!row?.partition_name) reasons.push('swap_partition_missing');
  else if (row.attached !== true) reasons.push('swap_partition_detached');
  else if (!boundMatchesDay(row.partition_bound, day)) {
    reasons.push('swap_partition_bound_mismatch');
  }
  return { day, available: reasons.length === 0, reasons };
}

function createRobinhoodWalletRankingSwapAvailabilityRepository(options = {}) {
  const database = options.database || db;
  return {
    async inspectWindow(input = {}) {
      const { start, end, days } = windowDays(input);
      const result = await database.queryWithStatementTimeout(
        AVAILABILITY_SQL, [days], TIMEOUT_MS,
      );
      const byDay = new Map(result.rows.map((row) => [row.partition_day, row]));
      const partitions = days.map((day) => assessDay(byDay.get(day), day));
      return {
        windowStart: start.toISOString(), asOf: end.toISOString(), partitions,
        swapPartitionsAvailable: partitions.every((item) => item.available),
        sourceCoverageVerified: false,
      };
    },
  };
}

module.exports = { createRobinhoodWalletRankingSwapAvailabilityRepository };
