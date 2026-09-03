const { performance } = require('node:perf_hooks');

const OPERATIONS = [
  ['robinhood_v4_liquidity_replay_state', 'v4_ranges'],
  ['robinhood_pool_liquidity_snapshots', 'snapshots'],
  ['robinhood_pool_liquidity_event_cursors', 'cursor'],
  ['robinhood_head_capture_cursors', 'processing_frontier'],
  ['robinhood_pool_registry', 'pool_registry'],
];

function poolState(pool) {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

function errorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
}

// Match Pool.query's connection disposal and error-event handling, including
// failures emitted before the query callback. Never release a client twice.
function queryAndRelease(client, text, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      client.removeListener('error', finish);
      client.release(error);
      if (error) reject(error);
      else resolve(result);
    }
    client.once('error', finish);
    try {
      client.query(text, params, finish);
    } catch (error) {
      finish(error);
    }
  });
}

function createLiquidityTimedDatabase(database, options = {}) {
  if (options.enabled === false || typeof database.pool?.connect !== 'function') return database;
  const pool = database.pool;
  const now = options.now || (() => performance.now());
  const emit = options.emit || ((event) => console.warn(
    '[RobinhoodLiquidityDbTiming]', JSON.stringify(event)
  ));
  const threshold = Number(options.slowQueryMs ?? 1000);
  const slowQueryMs = Number.isFinite(threshold) ? Math.max(0, threshold) : 1000;
  const ms = (value) => Math.round(Math.max(0, value) * 1000) / 1000;

  async function query(text, params) {
    const started = now();
    const startedAt = new Date().toISOString();
    const poolAtStart = poolState(pool);
    let poolWhileAcquiring = poolAtStart;
    let client;
    let acquiredAt = null;
    let failure = null;
    try {
      const pending = pool.connect();
      poolWhileAcquiring = poolState(pool);
      client = await pending;
      acquiredAt = now();
      return await queryAndRelease(client, text, params);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const finished = now();
      if (finished - started > slowQueryMs) {
        try {
          emit({
            event: 'liquidity_db_slow_query', startedAt, finishedAt: new Date().toISOString(),
            processPid: process.pid, backendPid: client?.processID ?? null,
            operation: OPERATIONS.find(([table]) => String(text).includes(table))?.[1] || 'other',
            totalMs: ms(finished - started), acquireMs: ms((acquiredAt ?? finished) - started),
            roundTripMs: acquiredAt == null ? null : ms(finished - acquiredAt),
            poolAtStart, poolWhileAcquiring, poolAtEnd: poolState(pool),
            failed: failure != null,
            errorCode: errorCode(failure),
          });
        } catch (_) { /* Diagnostics must not change the query result or error. */ }
      }
    }
  }

  return { ...database, query };
}

module.exports = { createLiquidityTimedDatabase };
