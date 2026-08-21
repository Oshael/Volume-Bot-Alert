const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRegistryClosure,
  __private,
} = require('../src/services/robinhood-infrastructure-registry-close');
const { parseArgs } = require('../src/utils/close-robinhood-infrastructure-registry');

const ADDRESS = `0x${'a'.repeat(40)}`;

function request(overrides = {}) {
  return {
    address: ADDRESS, kind: 'cex', validFromBlock: '10', validThroughBlock: '19',
    closure: {
      source: 'manual_audit', evidence: { reference: 'case-close' },
      verifiedAt: '2026-08-21T13:00:00Z',
    }, ...overrides,
  };
}

describe('Robinhood infrastructure registry closure', () => {
  it('is dry-run by default and does not open a write transaction', async () => {
    const database = {
      query: async () => ({ rows: [{
        valid_from_block: '10', valid_through_block: null, closed_source: null,
        closed_evidence_json: null, closed_verified_at: null,
      }] }),
      getClient: async () => { throw new Error('dry-run must not open a transaction'); },
    };
    assert.deepEqual(await runRegistryClosure({ request: request() }, { database }), {
      mode: 'dry-run', action: 'close',
    });
  });

  it('rejects overlapping or mismatched closure requests', () => {
    const normalized = __private.normalizeRequest(request());
    assert.throws(() => __private.planRows([{
      valid_from_block: '10', valid_through_block: null,
    }, {
      valid_from_block: '19', valid_through_block: '30',
    }], normalized), /would overlap/);
    assert.throws(() => __private.normalizeRequest(request({ validThroughBlock: '9' })),
      /greater than or equal/);
    const replay = __private.normalizeRequest(request({
      closure: {
        source: 'manual_audit', evidence: { z: 1, a: 2 },
        verifiedAt: '2026-08-21T13:00:00Z',
      },
    }));
    assert.equal(__private.planRows([{
      valid_from_block: '10', valid_through_block: '19', closed_source: 'manual_audit',
      closed_evidence_json: { z: 1, a: 2 }, closed_verified_at: '2026-08-21T13:00:00Z',
    }], replay), 'unchanged');
  });

  it('requires an explicit closure file and apply flag', () => {
    assert.equal(parseArgs(['--file=closure.json']).apply, false);
    assert.equal(parseArgs(['--file=closure.json', '--apply']).apply, true);
    assert.throws(() => parseArgs([]), /--file=<closure.json> is required/);
  });
});
