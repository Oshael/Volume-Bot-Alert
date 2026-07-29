const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createXProfileCardService } = require('../src/services/x-profile-card');

const USER = {
  screen_name: 'pipedog_',
  name: 'pipedog',
  followers: 10924,
  following: 12,
  joined: 'Wed Jul 15 01:18:25 +0000 2026',
};

function createClock(startMs = Date.parse('2026-07-28T00:00:00.000Z')) {
  let current = startMs;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

function jsonResponse(user) {
  return { ok: true, status: 200, json: async () => ({ code: 200, user }) };
}

function createService(overrides = {}) {
  const clock = overrides.clock || createClock();
  const calls = [];
  const responses = overrides.responses || [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses.shift() || jsonResponse(USER);
    if (next instanceof Error) throw next;
    return next;
  };
  const service = createXProfileCardService({
    now: clock.now,
    fetchImpl,
    ttlMs: 60 * 60_000,
    negativeTtlMs: 6 * 60 * 60_000,
    ...overrides.settings,
  });
  return { service, clock, calls };
}

describe('X profile card cache', () => {
  it('rejects an invalid handle without calling upstream', async () => {
    const { service, calls } = createService();
    const result = await service.get('bad-handle');

    assert.equal(result.status, 'invalid');
    assert.equal(calls.length, 0);
  });

  it('serves the second read from cache within the TTL', async () => {
    const { service, clock, calls } = createService();

    const first = await service.get('pipedog_');
    assert.equal(first.status, 'ok');
    assert.equal(first.profile.followers, 10924);

    clock.advance(59 * 60_000);
    const second = await service.get('pipedog_');

    assert.equal(second.cached, true);
    assert.equal(calls.length, 1);
  });

  it('refetches once the TTL expires', async () => {
    const { service, clock, calls } = createService();

    await service.get('pipedog_');
    clock.advance(60 * 60_000 + 1);
    await service.get('pipedog_');

    assert.equal(calls.length, 2);
  });

  it('caches a 404 for the negative TTL instead of retrying every hour', async () => {
    const { service, clock, calls } = createService({
      responses: [{ ok: false, status: 404 }],
    });

    const result = await service.get('pipedog_');
    assert.equal(result.status, 'not_found');

    clock.advance(2 * 60 * 60_000);
    await service.get('pipedog_');
    assert.equal(calls.length, 1, 'dead handle must not be refetched inside the negative TTL');

    clock.advance(5 * 60 * 60_000);
    await service.get('pipedog_');
    assert.equal(calls.length, 2);
  });

  it('serves stale data when upstream fails after a successful fetch', async () => {
    const { service, clock } = createService({
      responses: [jsonResponse(USER), new Error('upstream down')],
    });

    await service.get('pipedog_');
    clock.advance(60 * 60_000 + 1);
    const stale = await service.get('pipedog_');

    assert.equal(stale.status, 'ok');
    assert.equal(stale.stale, true);
    assert.equal(stale.profile.followers, 10924);
  });

  it('reports unavailable when upstream fails with no previous value', async () => {
    const { service } = createService({ responses: [new Error('upstream down')] });
    const result = await service.get('pipedog_');

    assert.equal(result.status, 'unavailable');
    assert.equal(result.profile, null);
  });

  it('collapses concurrent reads of the same handle into one upstream call', async () => {
    const { service, calls } = createService();

    const [a, b, c] = await Promise.all([
      service.get('pipedog_'),
      service.get('pipedog_'),
      service.get('pipedog_'),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(a.status, 'ok');
    assert.equal(b.status, 'ok');
    assert.equal(c.status, 'ok');
  });

  it('evicts the oldest entry when the cache is full', async () => {
    const { service } = createService({ settings: { maxEntries: 50 } });

    for (let index = 0; index < 55; index += 1) {
      await service.get(`handle${index}`);
    }

    const metrics = service.getMetrics();
    assert.equal(metrics.size, 50);
    assert.ok(metrics.evicted >= 5);
  });
});
