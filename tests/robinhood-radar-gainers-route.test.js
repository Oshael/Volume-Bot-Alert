const assert = require('node:assert/strict');
const { it } = require('node:test');
const express = require('express');
const request = require('supertest');
const { createRobinhoodRadarGainersRouter } = require('../src/routes/robinhood-radar-gainers');
const { createRobinhoodRadarGainersPage } = require('../src/services/robinhood-radar-gainers-page');

const PATH = '/api/robinhood/radar-gainers';
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;

function harness(overrides = {}) {
  const calls = [];
  const blockedUsers = [];
  const page = createRobinhoodRadarGainersPage({ now: () => Date.parse('2026-10-06T12:00:45Z'),
    loadBlockedAddresses: async (userId) => {
      blockedUsers.push(userId);
      if (overrides.blockError) throw new Error('secret SQL connection');
      return [address(1)];
    },
    service: { async getGainers(input) {
      calls.push(input);
      if (overrides.sourceError) throw new Error('secret SQL connection');
      return { chain: 'robinhood', asOf: input.asOf, total: 1, candidateCount: 4,
        unpricedCount: 2, items: [{ identity: { chain: 'robinhood', address: address(3) },
          priceChangePct: '10.0000000000001', volume24hChangePct: null,
          priceBasis: { type: 'first-observed-price', coverage: 'available-history' } }] };
    } },
  });
  const app = express();
  app.use(express.json());
  app.use(PATH, createRobinhoodRadarGainersRouter({ page,
    config: { robinhoodUserVisibility: { enabled: overrides.visible !== false },
      robinhoodRadarGainers: overrides.missingFlag ? undefined : { enabled: overrides.enabled !== false } },
    authenticate: overrides.realAuth ? undefined : (req, res, next) => {
      if (!req.get('Authorization')) return res.sendStatus(401);
      req.user = { id: 123 }; next();
    },
    requireTrustedOrigin: (req, res, next) => (
      req.get('X-Bad-Origin') ? res.sendStatus(403) : next()),
    logger: { error() {} },
  }));
  return { app, calls, blockedUsers };
}

it('guards authentication, origin, RH visibility and rollout before reading gainers', async () => {
  for (const [options, headers, status, code] of [
    [{ realAuth: true }, {}, 401],
    [{ realAuth: true }, { Authorization: 'Bearer invalid' }, 401],
    [{}, { Authorization: 'test', 'X-Bad-Origin': '1' }, 403],
    [{ visible: false }, { Authorization: 'test' }, 400, 'CHAIN_NOT_AVAILABLE'],
    [{ enabled: false }, { Authorization: 'test' }, 503, 'GAINERS_NOT_READY'],
    [{ missingFlag: true }, { Authorization: 'test' }, 503, 'GAINERS_NOT_READY'],
  ]) {
    const h = harness(options);
    const response = await request(h.app).post(PATH).set(headers).send({}).expect(status);
    if (code) assert.equal(response.body.code, code);
    assert.equal(h.calls.length, 0);
    assert.equal(h.blockedUsers.length, 0);
  }
});

it('uses authenticated user exclusions before top selection and preserves published values', async () => {
  const h = harness();
  const response = await request(h.app).post(PATH).set('Authorization', 'test')
    .send({ limit: 1, dismissedIdentities: [`robinhood:${address(2)}`] }).expect(200);
  assert.deepEqual(h.blockedUsers, [123]);
  assert.deepEqual(h.calls[0], { asOf: '2026-10-06T12:00:00.000Z',
    excludedAddresses: [address(1), address(2)], limit: 20 });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.limit, 1);
  assert.equal(response.body.source, 'robinhood-radar-gainers-v1');
  assert.equal(response.body.hasMore, false);
  assert.equal(response.body.items[0].priceChangePct, '10.0000000000001');
  assert.equal(response.body.items[0].volume24hChangePct, null);
  assert.equal(response.body.items[0].priceBasis.coverage, 'available-history');
});

it('returns controlled errors without leaking source failures or accepting client user/cutoff', async () => {
  const h = harness();
  for (const body of [{ userId: 456 }, { asOf: '2020-01-01' }, { limit: 21 }]) {
    await request(h.app).post(PATH).set('Authorization', 'test').send(body).expect(400);
  }
  await request(h.app).post(`${PATH}?chain=solana`)
    .set('Authorization', 'test').send({}).expect(400);
  assert.equal(h.blockedUsers.length, 0);
  for (const options of [{ blockError: true }, { sourceError: true }]) {
    const failed = harness(options);
    const result = await request(failed.app).post(PATH)
      .set('Authorization', 'test').send({}).expect(503);
    assert.equal(result.body.code, 'GAINERS_UNAVAILABLE');
    assert.equal(result.headers['retry-after'], '10');
    assert.doesNotMatch(JSON.stringify(result.body), /secret|SQL/);
    if (options.blockError) assert.equal(failed.calls.length, 0);
    if (options.sourceError) {
      const retry = await request(failed.app).post(PATH)
        .set('Authorization', 'test').send({}).expect(503);
      assert.equal(retry.body.code, 'GAINERS_BUSY');
      assert.equal(failed.calls.length, 1);
    }
  }
});
