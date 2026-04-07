const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const requestSecurity = require('../src/utils/request-security');

const originalCorsOrigins = [...config.corsOrigins];
const originalNodeEnv = config.nodeEnv;

function buildRequest({ headers = {}, remoteAddress = null, ip = null } = {}) {
  return {
    headers,
    ip,
    socket: { remoteAddress },
    connection: { remoteAddress },
  };
}

describe('request security origin allowlist', () => {
  beforeEach(() => {
    config.corsOrigins = ['https://www.trendscope.pro', 'https://api.trendscope.pro'];
    config.nodeEnv = originalNodeEnv;
  });

  after(() => {
    config.corsOrigins = originalCorsOrigins;
    config.nodeEnv = originalNodeEnv;
  });

  it('allows origins that are explicitly configured', () => {
    assert.equal(requestSecurity.isAllowedOrigin('https://www.trendscope.pro'), true);
    assert.equal(requestSecurity.isAllowedOrigin('https://api.trendscope.pro'), true);
  });

  it('rejects Vercel preview origins when not explicitly configured', () => {
    assert.equal(requestSecurity.isAllowedOrigin('https://volume-bot-alert-frontend.vercel.app'), false);
    assert.equal(requestSecurity.isAllowedOrigin('https://volume-bot-alert-frontend-pr-123.vercel.app'), false);
  });

  it('continues allowing loopback origins in development', () => {
    config.nodeEnv = 'development';
    assert.equal(requestSecurity.isAllowedOrigin('http://localhost:3000'), true);
    assert.equal(requestSecurity.isAllowedOrigin('http://127.0.0.1:5173'), true);
  });
});

describe('request security trusted IP resolution', () => {
  it('ignores forged x-forwarded-for on direct HTTP requests', () => {
    const req = buildRequest({
      headers: { 'x-forwarded-for': '1.2.3.4' },
      remoteAddress: '203.0.113.10',
    });

    assert.equal(requestSecurity.getRequestIp(req), '203.0.113.10');
  });

  it('uses the nearest untrusted address behind a trusted HTTP proxy', () => {
    const req = buildRequest({
      headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.25' },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(requestSecurity.getRequestIp(req), '198.51.100.25');
  });

  it('resolves socket client IP from the trusted proxy chain instead of raw headers', () => {
    const socket = {
      request: buildRequest({
        headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.25' },
        remoteAddress: '127.0.0.1',
      }),
      handshake: {
        address: '127.0.0.1',
        headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.25' },
      },
      conn: { remoteAddress: '127.0.0.1' },
    };

    assert.equal(requestSecurity.getSocketClientIp(socket), '198.51.100.25');
  });
});
