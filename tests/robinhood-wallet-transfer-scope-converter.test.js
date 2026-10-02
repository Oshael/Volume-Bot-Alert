const assert = require('node:assert/strict');
const { test } = require('node:test');
const { optionsFor, convertScopeHistory } = require('../src/models/robinhood-wallet-transfer-scope-converter');
const { parseArgs, main } = require('../src/utils/convert-robinhood-wallet-transfer-scope-history');
const input = { projectionVersion: 'rh_transfer_v1', stream: 'live' };
test('conversion defaults to a single read-only range and requires a fixed watermark for resume', () => {
  const options = optionsFor(input);
  assert.equal(options.commit, false); assert.equal(options.maxRanges, 1);
  assert.deepEqual(parseArgs(['--commit', '--after-id=2', '--through-id=8']),
    { commit: true, afterId: '2', highWaterId: '8' });
  for (const change of [{ stream: 'all' }, { projectionVersion: '' }, { maxRanges: 11 }, { maxTokens: 500001 },
    { budgetMs: 30001 }, { commit: 'true' }, { afterId: -1 }, { afterId: 1 },
    { afterId: 3, highWaterId: 2 }, { highWaterId: '9223372036854775808' }]) {
    assert.throws(() => optionsFor({ ...input, ...change }), /invalid|requires/);
  }
});
test('CLI rejects removal modes, repeated flags and invalid input before connecting', async () => {
  for (const argv of [['--remove-arrays'], ['--commit', '--commit'], ['--commit=true'], ['--stream='],
    ['--stream=live', '--stream=seed']]) assert.throws(() => parseArgs(argv), /argument/);
  const database = { getClient() { assert.fail('invalid input must not connect'); } };
  await assert.rejects(convertScopeHistory(database, { ...input, maxRanges: 0 }), /invalid/);
  await assert.rejects(main(['--commit', '--remove-arrays'], { database }), /argument/);
});
