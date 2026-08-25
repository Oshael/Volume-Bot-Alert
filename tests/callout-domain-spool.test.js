'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  calloutDedupeKey,
  commonCalloutFromFomo,
  commonCalloutFromPump,
  createCalloutEnvelope,
  resolveCalloutAddress,
} = require('../src/services/callout-domain');
const { createCalloutSpool, readCalloutSpoolBatch } = require('../src/services/callout-spool');

const EVM = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';
const SOLANA = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';

test('common callout domain preserves chain evidence and normalizes known addresses', () => {
  const pump = commonCalloutFromPump({
    eventKind: 'callout', sourceEventId: 'pump-1', platformUserId: 'profile-p',
    rawChainId: '4663', tokenAddress: EVM, walletAddress: EVM, thesis: 'pump thesis', marketCap: 123,
  });
  const fomo = commonCalloutFromFomo({
    eventType: 'callout', platformEventId: 'fomo-1', occurredAt: '2026-08-25T01:04:23.221Z',
    profile: { platformUserId: 'profile-f', handle: 'trader' },
    asset: { address: SOLANA, rawNetworkId: 1399811149, ticker: 'CATE' },
    thesis: { text: 'fomo thesis' }, platformMetrics: {},
  });

  assert.equal(pump.asset.chainKey, 'robinhood');
  assert.equal(pump.asset.address, EVM.toLowerCase());
  assert.equal(fomo.asset.chainKey, 'solana');
  assert.equal(fomo.asset.address, SOLANA);
  assert.equal(resolveCalloutAddress('999999', EVM).resolutionStatus, 'unsupported_chain');
  assert.equal(resolveCalloutAddress(null, EVM).resolutionStatus, 'unknown_chain');
  assert.equal(resolveCalloutAddress('4663', 'bad').resolutionStatus, 'invalid_address');
});

test('callout envelope deduplicates by platform event ID and stable fallback', () => {
  const base = commonCalloutFromFomo({
    eventType: 'callout', platformEventId: null, occurredAt: '2026-08-25T01:04:23.221Z',
    profile: { platformUserId: 'profile-f' }, asset: { address: SOLANA, rawNetworkId: 1399811149 },
    thesis: { text: 'same thesis' }, platformMetrics: {},
  });
  const first = calloutDedupeKey(base);
  assert.equal(first, calloutDedupeKey({ ...base, sourceMetadata: { drift: true } }));
  assert.notEqual(first, calloutDedupeKey({ ...base, thesis: 'changed thesis' }));
  const envelope = createCalloutEnvelope(base, { capturedAt: '2026-08-25T02:00:00.000Z', sequence: 7 });
  assert.equal(envelope.dedupeKey, first);
  assert.equal(envelope.sequence, 7);
});

test('spool serializes appends, rotates, enforces total bound and reads complete lines', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'callout-spool-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 1000;
  const spool = createCalloutSpool({ directory, writerId: 'test', maxFileBytes: 300, maxTotalBytes: 420, maxFileAgeMs: 100, now: () => now });
  const record = (id) => ({ spoolVersion: 1, platform: 'fomo', stream: 'callouts', capturedAt: 'x', sequence: id, dedupeKey: `id:${id}`, payload: { id } });
  const first = await spool.append(record(1));
  const sameFile = await spool.append(record(2));
  assert.equal(first.filePath, sameFile.filePath);
  const pageOne = await readCalloutSpoolBatch(first.filePath, { limit: 1 });
  const pageTwo = await readCalloutSpoolBatch(first.filePath, { offset: pageOne.nextOffset, limit: 1 });
  assert.deepEqual([pageOne.records[0].sequence, pageTwo.records[0].sequence], [1, 2]);
  now += 101;
  const rotated = await spool.append(record(3));
  assert.notEqual(first.filePath, rotated.filePath);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(rotated.filePath)).mode & 0o777, 0o600);
  await assert.rejects(spool.append({ ...record(4), payload: { headers: { 'set-cookie': 'secret' } } }), /forbidden key/);
  await assert.rejects(spool.append(record(4)), (error) => error.code === 'CALLOUT_SPOOL_TOTAL_LIMIT');

  await fs.appendFile(rotated.filePath, '{"partial":true');
  const batch = await readCalloutSpoolBatch(rotated.filePath, { limit: 10 });
  assert.equal(batch.records.length, 1);
  assert.equal(batch.trailingPartial, true);
  assert.equal(batch.nextOffset, rotated.bytes);
  await fs.appendFile(rotated.filePath, '\n');
  await assert.rejects(readCalloutSpoolBatch(rotated.filePath), SyntaxError);
});
