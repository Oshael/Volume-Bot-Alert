const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodInfrastructureRegistryRepository,
  __private,
} = require('../src/models/robinhood-infrastructure-registry');

const ADDRESS_A = `0x${'a'.repeat(40)}`;
const ADDRESS_B = `0x${'b'.repeat(40)}`;

describe('Robinhood infrastructure registry repository', () => {
  it('normalizes and deduplicates an as-of-block lookup', () => {
    assert.deepEqual(__private.normalizeLookup({
      chain: ' ROBINHOOD ', addresses: [ADDRESS_B.toUpperCase(), ADDRESS_A, ADDRESS_A],
      kinds: ['router', 'cex', 'cex'], blockNumber: '00042',
    }), {
      chain: 'robinhood', addresses: [ADDRESS_A, ADDRESS_B], kinds: ['cex', 'router'],
      blockNumber: '42',
    });
  });

  it('queries inclusive validity windows and normalizes evidence', async () => {
    const calls = [];
    const repository = createRobinhoodInfrastructureRegistryRepository({
      database: { query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{
          chain: 'robinhood', address: ADDRESS_A, kind: 'cex', label: 'Exchange',
          source: 'manual_audit', evidence_json: { caseId: 'case-1' },
          valid_from_block: '10', valid_through_block: null,
          verified_at: '2026-08-21T12:00:00Z',
        }] };
      } },
    });

    const result = await repository.listActiveAtBlock({
      addresses: [ADDRESS_A], kinds: ['cex'], blockNumber: 50,
    });

    assert.match(calls[0].sql, /valid_from_block <= \$4::bigint/);
    assert.match(calls[0].sql, /valid_through_block >= \$4::bigint/);
    assert.deepEqual(calls[0].params, ['robinhood', [ADDRESS_A], ['cex'], '50']);
    assert.deepEqual(result, [{
      chain: 'robinhood', address: ADDRESS_A, kind: 'cex', label: 'Exchange',
      source: 'manual_audit', evidence: { caseId: 'case-1' },
      validFromBlock: '10', validThroughBlock: null,
      verifiedAt: '2026-08-21T12:00:00.000Z',
    }]);
  });

  it('fails closed on invalid scope and skips empty database lookups', async () => {
    let queries = 0;
    const repository = createRobinhoodInfrastructureRegistryRepository({
      database: { query: async () => { queries += 1; } },
    });

    assert.deepEqual(await repository.listActiveAtBlock({
      addresses: [], kinds: ['cex'], blockNumber: '0',
    }), []);
    assert.equal(queries, 0);
    await assert.rejects(repository.listActiveAtBlock({
      chain: 'ethereum', addresses: [ADDRESS_A], blockNumber: '1',
    }), /Unsupported infrastructure chain/);
    await assert.rejects(repository.listActiveAtBlock({
      addresses: [ADDRESS_A], kinds: ['wallet'], blockNumber: '1',
    }), /Unsupported infrastructure kind/);
    await assert.rejects(repository.listActiveAtBlock({
      addresses: [ADDRESS_A], kinds: ['cex'], blockNumber: '-1',
    }), /blockNumber must be a non-negative integer/);
  });

  it('rejects overlapping evidence for the same address and kind', () => {
    const entry = {
      chain: 'robinhood', address: ADDRESS_A, kind: 'cex', label: 'Exchange',
      source: 'manual_audit', evidence_json: { caseId: 'case-1' },
      valid_from_block: '10', valid_through_block: '20',
      verified_at: '2026-08-21T12:00:00Z',
    };

    assert.throws(
      () => __private.normalizeRows([entry, { ...entry, valid_from_block: '15' }]),
      /Ambiguous infrastructure registry entries/
    );
  });
});
