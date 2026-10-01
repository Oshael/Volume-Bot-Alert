const assert = require('node:assert/strict');
const { test } = require('node:test');
const { difference, fingerprint } = require('../src/models/robinhood-wallet-transfer-scope-history-audit');
const { parseArgs } = require('../src/utils/audit-robinhood-wallet-transfer-scope-history');
const tokens = [1, 2, 3].map((id) => `0x${id.toString(16).padStart(40, '0')}`);

test('sorted-set deltas preserve removals, additions, reentry and unchanged scopes', () => {
  for (const [before, after, expected] of [
    [tokens, tokens, { added: 0, removed: 0 }],
    [tokens, [tokens[0]], { added: 0, removed: 2 }],
    [[tokens[0]], tokens, { added: 2, removed: 0 }],
    [[tokens[0]], [tokens[2]], { added: 1, removed: 1 }],
  ]) assert.deepEqual(difference(before, after), expected);
});
test('scope hash validates normalized sets and detects corrupt referenced payloads', () => {
  const hash = fingerprint([...tokens]);
  assert.equal(fingerprint(tokens.toReversed(), hash), hash);
  for (const bad of [null, [], [tokens[0], tokens[0]], ['invalid'], [tokens[0].toUpperCase()]]) {
    assert.throws(() => fingerprint(bad), /scope/);
  }
  assert.throws(() => fingerprint(tokens.slice(1), hash), /hash mismatch/);
});
test('CLI has no write mode and rejects repeated or unknown arguments', () => {
  assert.deepEqual(parseArgs(['--stream=live', '--max-ranges=1']), { stream: 'live', maxRanges: '1' });
  for (const args of [['--commit'], ['--stream='], ['--stream=live', '--stream=seed']]) {
    assert.throws(() => parseArgs(args), /argument/);
  }
});
