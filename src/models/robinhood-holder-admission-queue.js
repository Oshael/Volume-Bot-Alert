'use strict';
const db = require('./db');
const CHANNEL = 'robinhood_holder_admission';
function owner(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('invalid admission owner');
  return value;
}
function bound(value, fallback, maximum) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error('invalid admission limit');
  return number;
}
function createRobinhoodHolderAdmissionQueue(options = {}) {
  const database = options.database || db;
  async function claim(input) {
    const { rows } = await database.query(`WITH due AS (
      SELECT token_address,status FROM robinhood_holder_admission_queue
      WHERE chain='robinhood' AND (status='pending' AND next_attempt_at<=NOW()
        OR status='leased' AND lease_until<=NOW())
      ORDER BY next_attempt_at,token_address LIMIT $2 FOR UPDATE SKIP LOCKED)
      UPDATE robinhood_holder_admission_queue q SET status='leased',lease_owner=$1,
        lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
        attempt_count=attempt_count+1,updated_at=NOW()
      FROM due WHERE q.chain='robinhood' AND q.token_address=due.token_address
      RETURNING q.token_address,q.version::text,q.attempt_count,q.created_at,
        (due.status='leased') AS reclaimed`,
    [owner(input.owner), bound(input.limit, 100, 100), bound(input.leaseMs, 60_000, 300_000)]);
    return rows;
  }
  async function settle(input) {
    if (!input.tasks.length) return { completed: 0, deferred: 0 };
    const completed = input.completed || [];
    const tasks = input.tasks.map((task) => ({ address: task.token_address, version: task.version,
      done: completed.includes(task.token_address),
      delay: Math.min(60_000, 5000 * (2 ** Math.min(4, task.attempt_count - 1))) }));
    const { rows } = await database.query(`WITH tasks AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS t(address varchar(42),version bigint,done boolean,delay bigint)),
      removed AS (DELETE FROM robinhood_holder_admission_queue q USING tasks t
        WHERE q.chain='robinhood' AND q.token_address=t.address AND q.version=t.version
          AND q.status='leased' AND q.lease_owner=$2 AND q.lease_until>NOW() AND t.done
        RETURNING q.token_address),
      deferred AS (UPDATE robinhood_holder_admission_queue q
        SET status='pending',lease_owner=NULL,lease_until=NULL,updated_at=NOW(),
          next_attempt_at=CASE WHEN q.version<>t.version THEN NOW()
            ELSE NOW()+(t.delay*INTERVAL '1 millisecond') END,
          last_error=CASE WHEN q.version<>t.version THEN NULL ELSE $3 END
        FROM tasks t WHERE q.chain='robinhood' AND q.token_address=t.address
          AND q.status='leased' AND q.lease_owner=$2 AND q.lease_until>NOW()
          AND (q.version<>t.version OR NOT t.done) RETURNING q.token_address)
      SELECT (SELECT COUNT(*)::int FROM removed) AS completed,
        (SELECT COUNT(*)::int FROM deferred) AS deferred`,
    [JSON.stringify(tasks), owner(input.owner), String(input.error || 'admission_not_ready').slice(0, 500)]);
    return rows[0];
  }
  async function completedAddresses(addresses, admittedAfter) {
    if (!addresses.length) return [];
    const { rows } = await database.query(`SELECT candidate.address
      FROM unnest($1::varchar[]) candidate(address)
      LEFT JOIN robinhood_holder_token_states state
        ON state.chain='robinhood' AND state.token_address=candidate.address
      LEFT JOIN token_catalog catalog ON catalog.chain='robinhood' AND catalog.address=candidate.address
      LEFT JOIN admin_blocked_tokens blocked ON blocked.chain='robinhood' AND blocked.address=candidate.address
      WHERE state.token_address IS NOT NULL OR blocked.address IS NOT NULL
        OR catalog.first_seen_at<$2::timestamptz`, [addresses, admittedAfter]);
    return rows.map((row) => row.address);
  }
  async function reconcile(input = {}) {
    const { rows } = await database.query(`WITH page AS MATERIALIZED (
      SELECT address FROM token_catalog WHERE chain='robinhood' AND address>$1
        AND address ~ '^0x[0-9a-f]{40}$' AND address<>'0x0000000000000000000000000000000000000000'
        AND ($3::timestamptz IS NULL OR first_seen_at >= $3::timestamptz)
      ORDER BY address LIMIT $2), inserted AS (
      INSERT INTO robinhood_holder_admission_queue (chain,token_address)
      SELECT 'robinhood',page.address FROM page LEFT JOIN robinhood_holder_token_states state
        ON state.chain='robinhood' AND state.token_address=page.address
      WHERE state.token_address IS NULL ON CONFLICT DO NOTHING RETURNING token_address)
      SELECT (SELECT MAX(address) FROM page) AS cursor,
        (SELECT COUNT(*)::int FROM page) AS scanned,
        (SELECT COUNT(*)::int FROM inserted) AS enqueued`,
    [input.after || '', bound(input.limit, 500, 1000), input.admittedAfter || null]);
    return rows[0];
  }
  return Object.freeze({ claim, settle, completedAddresses, reconcile });
}
module.exports = { CHANNEL, createRobinhoodHolderAdmissionQueue };
