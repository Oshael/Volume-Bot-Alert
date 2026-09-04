const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { MAX_BYTES, digest, namespace, validateFrame, describeJournal } = require('../src/services/robinhood-holder-journal-receiver');
const { readFrame } = require('../src/utils/receive-robinhood-holder-journal');
const runId = '12345678-1234-1234-1234-123456789abc';
const manifest = { version: 1, sourceIdentity: 'a'.repeat(64), schemaHash: 'b'.repeat(64), fromPage: 0, endPage: 1024, pages: 512 };
const batch = () => ({ op: 'batch', runId, sourceIdentity: manifest.sourceIdentity,
  fromPage: 0, toPage: 512, rows: [], checksum: digest([]) });

test('protocol bounds identities, pages, row count and checksum before database access', () => {
  assert.equal(namespace(runId), 'holder_rx_12345678123412341234123456789abc');
  assert.throws(() => namespace('public; DROP TABLE x'), /UUID/);
  assert.doesNotThrow(() => validateFrame({ op: 'init', runId, manifest }));
  for (const change of [{ version: 2 }, { pages: 513 }, { fromPage: -1 },
    { endPage: 0 }, { sourceIdentity: 'missing' }, { schemaHash: null }]) {
    assert.throws(() => validateFrame({ op: 'init', runId, manifest: { ...manifest, ...change } }));
  }
  for (const change of [{ fromPage: 0.5 }, { toPage: 513 }, { toPage: 0 },
    { rows: Array(20001).fill({}) }, { checksum: 'a'.repeat(64) }]) {
    assert.throws(() => validateFrame({ ...batch(), ...change }));
  }
});

test('stdin accepts exactly one complete JSON frame and rejects truncation or excess input', async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await readFrame(Readable.from([JSON.stringify(batch())]), signal), batch());
  for (const input of ['{"op":', `${JSON.stringify(batch())}\n${JSON.stringify(batch())}`]) {
    await assert.rejects(readFrame(Readable.from([input]), signal), SyntaxError);
  }
  await assert.rejects(readFrame(Readable.from([Buffer.alloc(MAX_BYTES + 1)]), signal), /exceeds/);
});

test('interrupted input cannot produce a batch for insertion', async () => {
  const controller = new AbortController(); const input = new Readable({ read() {} });
  const result = readFrame(input, controller.signal); controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('schema fingerprint ignores database collation order but detects changed checks', async () => {
  const columns = [{ name: 'amount_raw', type: 'numeric(78,0)', required: true, generated: '', identity: '' }];
  const description = (checks) => describeJournal(async sql => ({ rows: sql.includes('pg_attribute')
    ? columns : checks.map(definition => ({ definition })) }), 'public.robinhood_holder_transfer_journal');
  const first = await description(['CHECK (amount_raw >= 0)', 'CHECK (amount_raw < 100)']);
  assert.equal(first.hash, (await description(['CHECK (amount_raw < 100)', 'CHECK (amount_raw >= 0)'])).hash);
  assert.notEqual(first.hash, (await description(['CHECK (amount_raw >= 0)'])).hash);
});
