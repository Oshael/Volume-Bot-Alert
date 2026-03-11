const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const dexscreener = require('../src/services/dexscreener');
const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');

const TEST_USER = {
  username: `catalogtest_${Date.now()}`,
  email: `catalogtest_${Date.now()}@test.com`,
  password: 'TestPass123!',
};

const VALID_ADDR = 'So11111111111111111111111111111111111111112';

const originalGetTokenPairs = dexscreener.getTokenPairs;
const originalGetBestPair = dexscreener.getBestPair;

function buildPair(overrides = {}) {
  return {
    chainId: 'solana',
    pairAddress: 'pair_test_123',
    url: 'https://dexscreener.com/solana/testpair',
    marketCap: 123456,
    priceUsd: '1.23',
    pairCreatedAt: Date.now() - (2 * 24 * 60 * 60 * 1000),
    volume: { h24: 25000 },
    priceChange: { h1: 120, h6: 160 },
    baseToken: { symbol: 'WSOL', name: 'Wrapped SOL' },
    info: {
      imageUrl: 'https://example.com/token.png',
      socials: [{ type: 'twitter', url: 'https://x.com/wsol' }],
    },
    ...overrides,
  };
}

describe('Catalog routes', () => {
  let token;
  let mockPair;
  let mockDataAvailable;

  before(async () => {
    const invite = await Invite.create(null, 2, 24);
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ ...TEST_USER, inviteCode: invite.code });

    assert.equal(regRes.status, 201);
    token = regRes.body.token;

    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);

    dexscreener.getTokenPairs = async () => (mockDataAvailable ? { pairs: [mockPair] } : null);
    dexscreener.getBestPair = () => (mockDataAvailable ? mockPair : null);
  });

  beforeEach(() => {
    mockPair = buildPair();
    mockDataAvailable = true;
  });

  after(async () => {
    dexscreener.getTokenPairs = originalGetTokenPairs;
    dexscreener.getBestPair = originalGetBestPair;
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]).catch(() => {});
    if (server && server.close) server.close();
    await db.pool.end().catch(() => {});
  });

  it('rejects promote without auth', async () => {
    const res = await request(app)
      .post('/api/catalog/promote')
      .send({ address: VALID_ADDR, source: 'monitored-token' });

    assert.equal(res.status, 401);
  });

  it('upserts monitored token into token_catalog when Dex data is available', async () => {
    const res = await request(app)
      .post('/api/catalog/promote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: VALID_ADDR,
        source: 'monitored-token',
        chain: 'solana',
        symbol: 'FAKE',
        name: 'Spoofed Name',
        mcap: 999,
        pairUrl: 'https://attacker.example/token',
        imageUrl: 'https://attacker.example/token.png',
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.token.address, VALID_ADDR);
    assert.equal(res.body.token.source, 'monitored-token');

    const { rows } = await db.query(
      'SELECT address, source, symbol, name, last_mcap, last_pair_url, last_image_url, last_twitter_url FROM token_catalog WHERE address = $1',
      [VALID_ADDR]
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].address, VALID_ADDR);
    assert.equal(rows[0].source, 'monitored-token');
    assert.equal(rows[0].symbol, 'WSOL');
    assert.equal(rows[0].name, 'Wrapped SOL');
    assert.equal(Number(rows[0].last_mcap), 123456);
    assert.equal(rows[0].last_pair_url, 'https://dexscreener.com/solana/testpair');
    assert.equal(rows[0].last_image_url, 'https://example.com/token.png');
    assert.equal(rows[0].last_twitter_url, 'https://x.com/wsol');
  });

  it('defers monitored token promotion when Dex data is unavailable', async () => {
    mockDataAvailable = false;

    const res = await request(app)
      .post('/api/catalog/promote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: VALID_ADDR,
        source: 'monitored-token',
        chain: 'solana',
      });

    assert.equal(res.status, 202);
    assert.match(res.body.error, /retry later/i);
    assert.ok(res.body.retryAt);
  });

  it('rejects unsupported promotion sources', async () => {
    const res = await request(app)
      .post('/api/catalog/promote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: VALID_ADDR,
        source: 'recent-token',
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unsupported promotion source/i);
  });
});
