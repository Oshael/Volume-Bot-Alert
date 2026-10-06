const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createRobinhoodRadarGainersReadRepository } = require('../src/models/robinhood-radar-gainers-read');

it('rejects invalid gainers limits, cutoffs and unbounded or invalid exclusions before I/O', async () => {
  const reader = createRobinhoodRadarGainersReadRepository({
    database: { queryWithStatementTimeout() { assert.fail('unexpected database read'); } },
  });
  for (const limit of [0, 21, 1.5, '15', Infinity]) {
    await assert.rejects(reader.getGainers({ limit }), /gainers limit/);
  }
  await assert.rejects(reader.getGainers({ asOf: 'invalid' }), /asOf/);
  for (const excludedAddresses of ['invalid', Array(5001).fill(`0x${'1'.repeat(40)}`)]) {
    await assert.rejects(reader.getGainers({ excludedAddresses }), /at most 5000/);
  }
  await assert.rejects(reader.getGainers({ excludedAddresses: ['solana:abc'] }), /address/i);
});

it('propagates a timeout instead of returning a fabricated empty ranking', async () => {
  const reader = createRobinhoodRadarGainersReadRepository({
    database: { async queryWithStatementTimeout() {
      throw Object.assign(new Error('statement timeout'), { code: '57014' });
    } },
  });
  await assert.rejects(reader.getGainers(), { code: '57014' });
});
