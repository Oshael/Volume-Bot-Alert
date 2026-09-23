const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { main, parseArgs } = require('../src/utils/migrate-robinhood-wallet-transfer-evidence');

describe('Robinhood transfer evidence migration CLI', () => {
  it('requires paired apply confirmation', () => {
    assert.throws(() => parseArgs(['--day=2026-07-18', '--apply']), /requires/);
    assert.throws(() => parseArgs([
      '--day=2026-07-18', '--confirm-migrate-robinhood-wallet-transfer-evidence',
    ]), /requires/);
    assert.deepEqual(parseArgs(['--day=2026-07-18', '--batch-size=100',
      '--max-batches=2']).apply, undefined);
  });

  it('passes the bounded input to the migration and prints its report', async () => {
    const messages = [];
    const result = await main(['--day=2026-07-18', '--batch-size=100'], {
      logger: { log: (message) => messages.push(JSON.parse(message)) },
      migrationFactory: () => ({ run: async (input) => {
        assert.equal(input.day, '2026-07-18');
        assert.equal(input.batchSize, '100');
        assert.equal(input.apply, undefined);
        input.onBatch({ scanned: 100 });
        return { mode: 'read-only', readyForDrop: false };
      } }),
    });
    assert.deepEqual(messages, [{ scanned: 100 }, result]);
  });
});
