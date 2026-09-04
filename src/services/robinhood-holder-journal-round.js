'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { runPilot, normalizeOptions } = require('./robinhood-holder-journal-pilot');
const STREAMS = ['discovery', 'market'];
const POLICY = Object.freeze({ baselineMs: 30000, loadMs: 60000, recoveryMs: 30000,
  sampleMs: 5000, pauseMs: 500, pages: 512, batches: 64, staleMs: 65000,
  highLagBlocks: 100, highLagMs: 15000 });

function normalizePauseMs(value = POLICY.pauseMs) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 500) {
    throw new Error('round pause-ms must be an integer between 100 and 500');
  }
  return value;
}

function normalizeRoundOptions(input) {
  const options = normalizeOptions(input);
  if (!options.measure || options.pages !== POLICY.pages || options.timeoutMs > 3000) {
    throw new Error('round requires --measure, --pages=512 and timeout <= 3000ms');
  }
  return { ...options, pauseMs: normalizePauseMs(options.pauseMs) };
}

async function readHealth(client, database, schema = 'public') {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('invalid schema');
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '1000ms'; SET LOCAL lock_timeout = '500ms'; SET LOCAL enable_seqscan = off");
    const { rows: [row] } = await client.query(`SELECT current_database() AS database,
      clock_timestamp() AS observed_at,
      (SELECT jsonb_agg(to_jsonb(h)) FROM ${schema}.robinhood_head_capture_cursors h
        WHERE chain = 'robinhood' AND stream IN ('discovery','market')) AS heads,
      (SELECT to_jsonb(l) FROM ${schema}.worker_leases l
        WHERE lease_key = 'robinhood-processing-worker') AS lease,
      (SELECT jsonb_object_agg(stream, pending) FROM (
        SELECT stream, EXISTS(SELECT 1 FROM ${schema}.robinhood_head_captures c
          WHERE c.chain = 'robinhood' AND c.stream = s.stream
            AND c.processing_status = 'pending' AND c.next_attempt_at <= NOW()) AS pending
        FROM (VALUES ('discovery'), ('market')) s(stream)) q) AS pending`);
    if (row.database !== database) throw new Error('unexpected monitoring database');
    const t = row.lease?.metadata?.telemetry || {};
    return { observedAt: new Date(row.observed_at).getTime(), heads: row.heads,
      pending: row.pending, owner: row.lease?.owner_id, leaseUntil: row.lease?.lease_until,
      heartbeatAt: row.lease?.heartbeat_at, state: row.lease?.metadata?.state,
      metadataError: Boolean(row.lease?.metadata?.metadataProviderError), running: t.running,
      errors: t.totalErrors, lastError: t.lastError, processing: {
        market: { tick: t.lastTickAt, processed: t.totalProcessed, rejected: t.totalRejected, blocked: t.lastBlocked },
        discovery: { tick: t.discovery?.lastTickAt, processed: t.discovery?.totalProcessed,
          rejected: t.discovery?.totalRejected, blocked: t.discovery?.lastBlocked },
      } };
  } finally { await client.query('ROLLBACK'); }
}

function integer(value) {
  if (value === null || value === undefined || value === '') throw new Error('missing numeric telemetry');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid numeric telemetry');
  return n;
}

function fresh(value, now, maxAge) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 5000 && now - time <= maxAge;
}

function checkLease(sample, previous, now) {
  if (!sample.owner || sample.running !== true || sample.state === 'halted' || sample.metadataError
      || !(Date.parse(sample.leaseUntil) > now) || !fresh(sample.heartbeatAt, now, POLICY.staleMs)) {
    throw new Error('processing lease unavailable or stale');
  }
  const errors = integer(sample.errors);
  if (sample.lastError || (previous && (sample.owner !== previous.owner || errors !== previous.errors))) {
    throw new Error('processing error or worker restart');
  }
  return errors;
}

function progressTimers(before, current, now) {
  const { next, lag, settled, pending } = current;
  return {
    headSince: before && lag > 0 && before.lag > 0 && next === before.next ? before.headSince : now,
    pendingSince: before && pending && before.pending && settled === before.settled ? before.pendingSince : now,
    highLagSince: lag > POLICY.highLagBlocks ? (before?.highLagSince ?? now) : null,
  };
}

function checkProgress(current, before, now, options) {
  const { next, lag, processed, settled } = current;
  if (before && (next < before.next || processed < before.processed || settled < before.settled)) {
    throw new Error('cursor or counters regressed');
  }
  const rising = before && lag > before.lag ? before.rising + 1 : 0;
  const timers = progressTimers(before, current, now);
  if (timers.highLagSince !== null && now - timers.highLagSince >= POLICY.highLagMs) {
    throw new Error('lag above 100 blocks persisted for at least 15 seconds');
  }
  if ((!options?.allowLowLagGrowth && rising >= 2) || now - timers.headSince >= 30000
      || now - timers.pendingSince >= POLICY.staleMs) throw new Error('lag growing or progress stalled');
  return { ...current, rising, ...timers };
}

function checkStream(sample, stream, head, before, now, options) {
  const h = sample.heads.find((entry) => entry.stream === stream);
  if (!h || !fresh(h.updated_at, now, 30000)) throw new Error('HEAD telemetry stale');
  const next = integer(h.next_block); const lag = Math.max(0, head - next + 1);
  const p = sample.processing?.[stream];
  if (!p || !fresh(p.tick, now, POLICY.staleMs) || integer(p.blocked) > 0
      || typeof sample.pending?.[stream] !== 'boolean') throw new Error('processing unhealthy');
  const processed = integer(p.processed); const settled = processed + integer(p.rejected);
  return checkProgress({ next, lag, processed, settled, pending: sample.pending[stream] }, before, now, options);
}

function checkHealth(sample, previous, options) {
  const now = integer(sample.observedAt);
  const errors = checkLease(sample, previous, now);
  if (previous && now <= previous.at) throw new Error('monitor clock did not advance');
  if (sample.heads?.length !== 2) throw new Error('missing HEAD streams');
  const head = Math.max(...sample.heads.map((h) => integer(h.safe_head)));
  const result = { at: now, owner: sample.owner, errors, streams: {} };
  for (const stream of STREAMS) {
    try { result.streams[stream] = checkStream(sample, stream, head, previous?.streams[stream], now, options); }
    catch (error) { throw new Error(`${stream}: ${error.message}`); }
  }
  return result;
}

// Isolated diagnostic polling: no retries, durable cursor, writes or automatic ramp-up.
async function runRound({ sample, measure, emit, signal, fromPage, pauseMs,
  now = () => performance.now(), sleep = (ms) => delay(ms, undefined, { signal }) }) {
  const pause = normalizePauseMs(pauseMs);
  let previous; let lastSample = -Infinity; let batches = 0; let bytes = 0; let failure;
  async function observe(phase, enforce = true) {
    signal?.throwIfAborted();
    const snapshot = await sample();
    let health; let error;
    try { health = checkHealth(snapshot, previous); } catch (cause) { error = cause; }
    emit({ phase, snapshot, health, error: error?.message });
    lastSample = now();
    if (error && enforce) throw error;
    if (error) failure ||= error;
    if (health) previous = health;
  }
  async function window(phase, duration, enforce) {
    const end = now() + duration;
    await observe(phase, enforce);
    while (now() < end) {
      await sleep(Math.min(POLICY.sampleMs, end - now()));
      await observe(phase, enforce);
    }
  }
  await window('baseline', POLICY.baselineMs, true);
  const started = now(); const end = started + POLICY.loadMs;
  try {
    while (batches < POLICY.batches && now() < end) {
      signal?.throwIfAborted();
      if (now() - lastSample >= POLICY.sampleMs) await observe('load');
      const remaining = Math.floor(end - now());
      if (remaining <= 0) break;
      const deadline = AbortSignal.timeout(remaining);
      const batchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const report = await measure(fromPage + batches * POLICY.pages, batchSignal);
      batches += 1; bytes += report.heapRangeBytes;
      emit({ phase: 'batch', batch: batches, report });
      await sleep(Math.max(0, Math.min(pause, end - now())));
    }
  } catch (error) { failure = error; emit({ phase: 'stopped', reason: error.message }); }
  const loadElapsedMs = Math.round(now() - started);
  if (!signal?.aborted) {
    try { await window('recovery', POLICY.recoveryMs, false); }
    catch (error) { failure ||= error; emit({ phase: 'recovery_failed', reason: error.message }); }
  }
  if (failure) throw failure;
  signal?.throwIfAborted();
  return { mode: 'round', batches, heapRangeBytes: bytes, loadElapsedMs, pauseMs: pause, resumable: false };
}

async function runSustainedPilot(pool, input, { signal, progress = () => {} } = {}) {
  const options = normalizeRoundOptions(input);
  const client = await pool.connect();
  let locked = false;
  try {
    signal?.throwIfAborted();
    const { rows: [lock] } = await client.query(`SELECT current_database() AS database,
      pg_try_advisory_lock(hashtextextended('robinhood-holder-journal-pilot',0)) AS acquired`);
    locked = lock.acquired;
    if (lock.database !== options.database || !locked) throw new Error('wrong database or another pilot is active');
    // Keep the session lock between batches. runPilot re-enters it on this same session.
    const batchPool = { query: pool.query.bind(pool), connect: async () => ({
      query: client.query.bind(client), release(error) { if (error) throw error; },
    }) };
    const plan = await runPilot(batchPool, { ...options, measure: false }, { signal });
    const lastPage = options.fromPage + POLICY.pages * POLICY.batches;
    if (lastPage * plan.identity.block_size > Number(plan.identity.heap_bytes)) throw new Error('round exceeds heap boundary');
    progress({ phase: 'round_plan', policy: { ...POLICY, pauseMs: options.pauseMs }, plan });
    return await runRound({ signal, fromPage: options.fromPage, pauseMs: options.pauseMs, emit: progress,
      sample: () => readHealth(client, options.database),
      measure: async (fromPage, batchSignal) => {
        return runPilot(batchPool, { ...options, fromPage }, { signal: batchSignal, progress: (event) => {
          if (event.phase === 'plan' && JSON.stringify([event.identity.oid, event.identity.filenode, event.cursor])
              !== JSON.stringify([plan.identity.oid, plan.identity.filenode, plan.cursor])) {
            throw new Error('journal identity or holder cursor changed');
          }
          progress(event);
        } });
      },
    });
  } finally {
    // Destroy this dedicated connection even on failure; never return a session lock to the pool.
    try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('robinhood-holder-journal-pilot',0))"); }
    finally { client.release(true); }
  }
}

module.exports = { POLICY, normalizeRoundOptions, readHealth, checkHealth, runRound, runSustainedPilot };
