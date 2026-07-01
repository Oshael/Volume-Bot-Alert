process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.MOCK_TRADING_ENABLED = 'false';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, server } = require('../src/server');
const db = require('../src/models/db');

describe('mock trading feature flag', () => {
  after(async () => {
    if (server && server.close) server.close();
    await db.pool.end().catch(() => {});
  });

  it('does not expose admin mock trading routes when disabled', async () => {
    const res = await request(app).get('/api/admin/mock-trading/wallets');

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Mock trading is disabled');
  });
});
