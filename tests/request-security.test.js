const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const requestSecurity = require('../src/utils/request-security');

const originalCorsOrigins = [...config.corsOrigins];
const originalNodeEnv = config.nodeEnv;

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
