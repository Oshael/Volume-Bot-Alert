const express = require('express');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const request = require('supertest');

const telegramRouter = require('../src/routes/telegram');

function appWith(service, authenticated = true, trusted = true) {
  const app = express();
  const authenticate = (req, res, next) => {
    if (!authenticated) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: 7 };
    return next();
  };
  app.use('/api/telegram', telegramRouter.createTelegramRouter({
    authenticate,
    requireTrustedOrigin: (_req, res, next) => (
      trusted ? next() : res.status(403).json({ error: 'Trusted origin required' })
    ),
    service,
  }));
  return app;
}

describe('Telegram web connection routes', () => {
  it('requires authentication before reading status', async () => {
    const response = await request(appWith({}, false)).get('/api/telegram/status');
    assert.equal(response.status, 401);
  });

  it('requires a trusted origin before creating a link', async () => {
    const service = { createLink: async () => assert.fail('service must not run') };
    const response = await request(appWith(service, true, false)).post('/api/telegram/link');
    assert.equal(response.status, 403);
  });

  it('returns status, creates links, and disconnects for the authenticated user', async () => {
    const calls = [];
    const service = {
      async getStatus(userId) {
        calls.push(['status', userId]);
        return { available: true, status: 'disconnected' };
      },
      async createLink(userId) {
        calls.push(['link', userId]);
        return { deepLink: 'https://t.me/bot?start=opaque', expiresAt: 'soon' };
      },
      async disconnect(userId) {
        calls.push(['disconnect', userId]);
        return { available: true, status: 'disconnected' };
      },
    };
    const app = appWith(service);

    const status = await request(app).get('/api/telegram/status');
    const link = await request(app).post('/api/telegram/link');
    const disconnected = await request(app).post('/api/telegram/disconnect');

    assert.equal(status.status, 200);
    assert.equal(link.status, 201);
    assert.equal(disconnected.status, 200);
    assert.deepEqual(calls, [['status', 7], ['link', 7], ['disconnect', 7]]);
  });
});
