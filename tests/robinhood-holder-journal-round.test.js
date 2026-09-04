const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseArgs } = require('../src/utils/pilot-robinhood-holder-journal');
const { POLICY, checkHealth, runRound } = require('../src/services/robinhood-holder-journal-round');
const EPOCH = Date.parse('2026-09-04T15:00:00Z');

function snapshot(elapsed = 0) {
  const time = EPOCH + elapsed; const iso = new Date(time).toISOString();
  const block = 1000 + Math.floor(elapsed / 100);
  const p = { tick: iso, processed: Math.floor(elapsed / 1000), rejected: 0, blocked: 0 };
  return { observedAt: time, owner: 'worker-one', running: true, errors: 0,
    heartbeatAt: iso, leaseUntil: new Date(time + 120000).toISOString(),
    heads: ['discovery', 'market'].map((stream) => ({ stream, next_block: block,
      safe_head: block - 1, updated_at: iso })),
    processing: { market: { ...p }, discovery: { ...p } }, pending: { market: false, discovery: false } };
}

test('round remains opt-in and cannot raise batch size or timeout', () => {
  assert.equal(parseArgs(['--database=test', '--round', '--measure', '--pages=512']).round, true);
  for (const args of [[], ['--measure'], ['--measure', '--pages=1024'],
    ['--measure', '--pages=512', '--timeout-ms=3001']]) {
    assert.throws(() => parseArgs(['--database=test', '--round', ...args]), /round requires/);
  }
});

test('health fails closed on missing/stale telemetry, failures and resets', () => {
  const previous = checkHealth(snapshot());
  const mutations = [
    (s) => { s.heads.pop(); }, (s) => { s.errors = null; },
    (s) => { s.processing.market.processed = null; }, (s) => { s.running = false; },
    (s) => { s.errors = 1; }, (s) => { s.owner = 'restarted'; },
    (s) => { s.lastError = 'failure'; }, (s) => { s.metadataError = true; },
    (s) => { s.processing.discovery.tick = new Date(EPOCH - 70000).toISOString(); },
    (s) => { s.heads[0].updated_at = new Date(EPOCH - 40000).toISOString(); },
    (s) => { s.leaseUntil = new Date(EPOCH).toISOString(); },
    (s) => { s.processing.market.blocked = 1; }, (s) => { delete s.pending.market; },
    (s) => { s.heads[0].next_block = 999; },
  ];
  for (const mutate of mutations) { const s = snapshot(5000); mutate(s); assert.throws(() => checkHealth(s, previous)); }
});

test('lag must grow twice; steady lag is not itself treated as growth', () => {
  let previous = checkHealth(snapshot());
  const one = snapshot(5000); one.heads[1].next_block -= 10;
  previous = checkHealth(one, previous);
  const two = snapshot(10000); two.heads[1].next_block -= 20;
  assert.throws(() => checkHealth(two, previous), /lag growing/);
  two.heads[1].next_block += 10;
  assert.equal(checkHealth(two, previous).streams.market.rising, 0);
});

test('idle processing is allowed; continuously pending work without settlement stops after heartbeat grace', () => {
  let previous;
  for (let ms = 0; ms <= POLICY.staleMs; ms += 5000) {
    const s = snapshot(ms); s.pending.market = true; s.processing.market.processed = 0;
    if (ms === POLICY.staleMs) assert.throws(() => checkHealth(s, previous), /progress stalled/);
    else previous = checkHealth(s, previous);
  }
  assert.doesNotThrow(() => checkHealth(snapshot(70000)));
});

test('absolute lag and a stationary HEAD stop even without two increasing samples', () => {
  const high = snapshot(); high.heads[0].safe_head += 100;
  const previous = checkHealth(high);
  const higher = snapshot(5000); higher.heads[0].safe_head += 101;
  assert.throws(() => checkHealth(higher, previous), /lag growing/);
  const stationary = snapshot(30000);
  stationary.heads.forEach((h, index) => { h.next_block = high.heads[index].next_block; h.safe_head = high.heads[index].safe_head; });
  assert.throws(() => checkHealth(stationary, previous), /progress stalled/);
});

function harness(overrides = {}) {
  let clock = 0; const events = []; const pages = [];
  return { events, pages, options: { fromPage: 9072427, now: () => clock,
    sleep: async (ms) => { clock += ms; }, sample: async () => snapshot(clock),
    measure: async (page) => { pages.push(page); clock += 320; return { heapRangeBytes: 4194304 }; },
    emit: (event) => events.push(event), ...overrides } };
}

test('round bounds total bytes, uses disjoint pages and observes baseline/load/recovery', async () => {
  const h = harness(); const result = await runRound(h.options);
  assert.equal(result.batches, 64); assert.equal(result.heapRangeBytes, 256 * 1024 * 1024);
  assert.equal(h.pages[63], h.pages[0] + 63 * 512);
  assert.deepEqual([...new Set(h.events.map((e) => e.phase))], ['baseline', 'batch', 'load', 'recovery']);
  assert.equal(h.events.filter((e) => e.phase === 'baseline').length, 7);
});

test('load duration stops new batches even when fewer than 64 fit', async () => {
  const h = harness(); const original = h.options.measure;
  h.options.measure = async (...args) => { await h.options.sleep(2500); return original(...args); };
  const result = await runRound(h.options);
  assert.ok(result.batches < 64); assert.ok(result.loadElapsedMs >= 60000);
});

test('measurement failure has no retry and still observes recovery', async () => {
  let calls = 0;
  const h = harness({ measure: async () => { calls += 1; throw new Error('timeout'); } });
  await assert.rejects(runRound(h.options), /timeout/);
  assert.equal(calls, 1); assert.ok(h.events.some((e) => e.phase === 'recovery'));
});

test('monitor failure prevents load or further batches; unhealthy recovery cannot report success', async () => {
  for (const phase of ['baseline', 'load', 'recovery']) {
    const h = harness(); const original = h.options.sample;
    h.options.sample = async () => {
      const s = await original(); const ms = s.observedAt - EPOCH;
      if ((phase === 'baseline' && ms === 0) || (phase === 'load' && ms > 35000)
          || (phase === 'recovery' && h.pages.length === 64)) s.running = false;
      return s;
    };
    await assert.rejects(runRound(h.options), /lease unavailable/);
    if (phase === 'baseline') assert.equal(h.pages.length, 0);
    if (phase === 'load') assert.ok(h.pages.length < 64);
  }
});

test('operator interruption prevents further load and skips recovery', async () => {
  const controller = new AbortController(); const h = harness({ signal: controller.signal });
  h.options.measure = async () => { controller.abort(); controller.signal.throwIfAborted(); };
  await assert.rejects(runRound(h.options), { name: 'AbortError' });
  assert.equal(h.events.some((e) => e.phase === 'recovery'), false);
});
