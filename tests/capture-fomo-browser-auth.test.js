'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  chromeArgs,
  createCaptureAccumulator,
  sessionCapture,
  socketCapture,
  waitForManualTopic,
  writeBundle,
} = require('../src/utils/capture-fomo-browser-auth');

const jwt = (label, identity = { sub: 'did:privy:user', sid: 'session-1' }) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ label, ...identity })).toString('base64url')}.signature`;

describe('Fomo browser authentication capture', () => {
  it('keeps remote debugging disabled during the Google login phase', () => {
    assert.equal(chromeArgs('/tmp/profile', 'https://accounts.google.com/')
      .some((value) => value.startsWith('--remote-debugging')), false);
    assert.equal(chromeArgs('/tmp/profile', 'about:blank', true)
      .some((value) => value.startsWith('--remote-debugging')), true);
  });

  it('keeps the Privy infrastructure token separate from the Fomo app token', () => {
    const privyAccessToken = jwt('privy-access');
    const appToken = jwt('fomo-app');
    assert.deepEqual(sessionCapture({
      token: appToken, privy_access_token: privyAccessToken, refresh_token: 'refresh',
    }, { 'privy-ca-id': 'privy:caid' }), {
      privyAccessToken, appToken, refreshToken: 'refresh', caId: 'privy:caid',
    });
  });

  it('completes only when the session and WebSocket JWT belong together', async () => {
    const accessToken = jwt('current');
    const accumulator = createCaptureAccumulator();
    accumulator.acceptSession({
      privyAccessToken: jwt('privy-access'), appToken: accessToken,
      refreshToken: 'refresh', caId: 'ca-id',
    });
    accumulator.acceptSocket(socketCapture(JSON.stringify({
      type: 'challengeResponse', jwt: jwt('stale'),
    })));
    assert.equal(accumulator.getSnapshot(), null);
    accumulator.acceptSocket(socketCapture(JSON.stringify({
      type: 'challengeResponse', jwt: accessToken,
    })));
    assert.deepEqual(await accumulator.wait(10), {
      accessToken,
      refreshToken: 'refresh',
      caId: 'ca-id',
    });
  });

  it('matches a session by Privy sub and sid when the response omits the app token', () => {
    const accumulator = createCaptureAccumulator();
    accumulator.acceptSession({
      privyAccessToken: jwt('privy-access'), appToken: null,
      refreshToken: 'refresh', caId: 'ca-id',
    });
    accumulator.acceptSocket({ accessToken: jwt('fomo-app') });
    assert.equal(accumulator.getSnapshot().accessToken, jwt('fomo-app'));
  });

  it('writes secrets separately with restrictive permissions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fomo-auth-test-'));
    const output = path.join(root, 'bundle');
    try {
      await writeBundle(output, {
        accessToken: jwt('access'), refreshToken: 'refresh', caId: 'ca-id',
      });
      for (const name of ['fomo-customer-token', 'fomo-refresh-token', 'callouts.env.fragment']) {
        const mode = (await fs.stat(path.join(output, name))).mode & 0o777;
        assert.equal(mode, 0o600);
      }
      assert.equal(await fs.readFile(path.join(output, 'callouts.env.fragment'), 'utf8'),
        'FOMO_PRIVY_CA_ID=ca-id\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('waits for manual topic collection before allowing the browser to close', async () => {
    const prompts = [];
    await waitForManualTopic(async (message) => { prompts.push(message); });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /topicId/);
    assert.match(prompts[0], /pressione Enter/);
  });
});
