const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRegistryImport,
  __private,
} = require('../src/services/robinhood-infrastructure-registry-import');
const { parseArgs } = require('../src/utils/import-robinhood-infrastructure-registry');

const ADDRESS = `0x${'a'.repeat(40)}`;

function entry(overrides = {}) {
  return {
    address: ADDRESS, kind: 'cex', label: 'Example Exchange', source: 'manual_audit',
    evidence: { reference: 'case-1' }, validFromBlock: '10', validThroughBlock: '20',
    verifiedAt: '2026-08-21T12:00:00Z', ...overrides,
  };
}

function row(input) {
  return {
    chain: 'robinhood', address: input.address, kind: input.kind, label: input.label,
    source: input.source, evidence_json: input.evidence,
    valid_from_block: input.validFromBlock, valid_through_block: input.validThroughBlock,
    verified_at: input.verifiedAt,
  };
}

describe('Robinhood infrastructure registry import', () => {
  it('is dry-run by default and reports idempotent and new entries without writes', async () => {
    const existing = entry();
    let queries = 0;
    const database = {
      query: async () => { queries += 1; return { rows: [row(existing)] }; },
      getClient: async () => { throw new Error('dry-run must not open a transaction'); },
    };

    assert.deepEqual(await runRegistryImport({
      manifest: { entries: [existing, entry({ validFromBlock: '21', validThroughBlock: null })] },
    }, { database }), { mode: 'dry-run', entries: 2, insert: 1, unchanged: 1 });
    assert.equal(queries, 1);
  });

  it('rejects overlapping or conflicting manifest evidence before querying', () => {
    assert.throws(() => __private.normalizeManifest({ entries: [
      entry(), entry({ validFromBlock: '20', validThroughBlock: '30' }),
    ] }), /Manifest intervals overlap/);
    assert.throws(() => __private.normalizeManifest({ entries: [
      entry(), entry({ label: 'Conflicting Label' }),
    ] }), /Manifest contains conflicting entry/);
    assert.throws(() => __private.normalizeManifest({ entries: [
      entry({ validFromBlock: '9223372036854775808', validThroughBlock: null }),
    ] }), /validFromBlock exceeds PostgreSQL BIGINT/);
  });

  it('requires an explicit manifest path and apply flag', () => {
    assert.equal(parseArgs(['--file=fixtures/registry.json']).apply, false);
    assert.equal(parseArgs(['--file=fixtures/registry.json', '--apply']).apply, true);
    assert.throws(() => parseArgs([]), /--file=<manifest.json> is required/);
  });
});
