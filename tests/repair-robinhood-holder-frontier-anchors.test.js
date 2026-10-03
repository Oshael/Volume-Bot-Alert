'use strict';

process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { it } = require('node:test');
const { CONFIRM_FLAG, parseArgs, createResolver } = require('../src/utils/repair-robinhood-holder-frontier-anchors');
const HASH = `0x${'a'.repeat(64)}`;

it('requires paired confirmation and bounds manual repair arguments', () => {
  assert.deepEqual(parseArgs([]), { apply: false, scanLimit: 500,
    timeoutMs: 5000, afterToken: '', block: null });
  assert.equal(parseArgs(['--apply', CONFIRM_FLAG, '--block=35641986']).apply, true);
  for (const args of [['--apply'], [CONFIRM_FLAG], ['--scan-limit=0'],
    ['--scan-limit=5001'], ['--timeout-ms=60001'], ['--block=-1'],
    ['--block=9223372036854775808'], ['--after-token=bad'], ['--unknown=1'],
    ['--block=1', '--block=2'], ['--apply', '--apply', CONFIRM_FLAG]]) {
    assert.throws(() => parseArgs(args));
  }
});

it('verifies chain and exact header evidence with bounded, sequential RPC calls', async () => {
  for (const [override, message] of [
    [{}, null], [{ chainId: '0x1' }, /not Robinhood/],
    [{ number: '0x33' }, /diverged/], [{ hash: `0x${'b'.repeat(64)}` }, /diverged/],
    [{ timestamp: 'invalid' }, /invalid/],
  ]) {
    let config;
    const calls = [];
    const resolve = createResolver({ timeoutMs: 5000 }, {
      env: { ROBINHOOD_RPC_URL: 'https://rpc.example/private-key' },
      rpcClientFactory(options) {
        config = options;
        return { async request(method, params) {
          calls.push([method, params]);
          if (method === 'eth_chainId') return override.chainId || '0x1237';
          return { number: '0x32', hash: HASH, timestamp: '0x68cfe920', ...override };
        } };
      },
    });
    if (message) await assert.rejects(resolve('50', HASH), message);
    else {
      assert.equal((await resolve('50', HASH)).blockHash, HASH);
      assert.deepEqual(calls, [['eth_chainId', []], ['eth_getBlockByNumber', ['0x32', false]]]);
    }
    assert.equal(config.maxRetries, 0);
    assert.equal(config.minRequestIntervalMs, 100);
    assert.equal(config.providers[0].url, 'https://rpc.example/private-key');
  }
  assert.throws(() => createResolver({ timeoutMs: 5000 }, { env: {} }), /rpc_missing/);
});
