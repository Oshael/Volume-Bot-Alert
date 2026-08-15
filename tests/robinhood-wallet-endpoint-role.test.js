const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletEndpointRoleRepository,
  __private: { compactEvidence },
} = require('../src/models/robinhood-wallet-endpoint-role');

const ADDRESS = `0x${'a'.repeat(40)}`;
const HASH = `0x${'b'.repeat(64)}`;

function evidence(overrides = {}) {
  return {
    endpointAddress: ADDRESS,
    endpointRole: 'wallet',
    evidenceSource: 'pc_archive',
    evidenceBlock: '100',
    evidenceBlockHash: HASH,
    resolverVersion: 'rh_endpoint_v1',
    ...overrides,
  };
}

function database(rows = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
}

describe('Robinhood wallet endpoint role repository', () => {
  it('compacts repeated observations and lets contract evidence dominate', () => {
    const compacted = compactEvidence([
      evidence({ evidenceBlock: '100' }),
      evidence({ endpointRole: 'contract', evidenceBlock: '120' }),
      evidence({ evidenceBlock: '140' }),
    ]);
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0].endpoint_role, 'contract');
    assert.equal(compacted[0].evidence_block, '120');
    assert.equal(compacted[0].observed_from_block, '100');
    assert.equal(compacted[0].observed_through_block, '140');
  });

  it('rejects malformed or oversized evidence before persistence', async () => {
    const repository = createRobinhoodWalletEndpointRoleRepository({ database: database() });
    await assert.rejects(
      repository.upsertEvidence([evidence({ endpointAddress: '0x1234' })]),
      /endpointAddress must be 20 bytes/
    );
    await assert.rejects(
      repository.upsertEvidence([evidence({ endpointRole: 'unknown' })]),
      /endpointRole is unsupported/
    );
  });

  it('uses an idempotent upsert that cannot downgrade a contract', async () => {
    const row = {
      endpoint_address: ADDRESS, endpoint_role: 'contract', evidence_source: 'pc_archive',
      evidence_block: '100', evidence_block_hash: HASH, resolver_version: 'rh_endpoint_v1',
      observed_from_block: '100', observed_through_block: '100',
    };
    const fake = database([row]);
    const repository = createRobinhoodWalletEndpointRoleRepository({ database: fake });
    const result = await repository.upsertEvidence([evidence({ endpointRole: 'contract' })]);
    assert.match(fake.calls[0].sql, /ON CONFLICT \(chain, endpoint_address\) DO UPDATE/);
    assert.match(fake.calls[0].sql, /endpoint_role = CASE[\s\S]*endpoint_role = 'contract'/);
    assert.equal(JSON.parse(fake.calls[0].params[0])[0].endpoint_address, ADDRESS);
    assert.equal(result[0].endpointRole, 'contract');
  });

  it('loads normalized roles for unique addresses', async () => {
    const row = {
      endpoint_address: ADDRESS, endpoint_role: 'wallet', evidence_source: 'pc_archive',
      evidence_block: '100', evidence_block_hash: HASH, resolver_version: 'rh_endpoint_v1',
      observed_from_block: '90', observed_through_block: '110',
    };
    const fake = database([row]);
    const result = await createRobinhoodWalletEndpointRoleRepository({ database: fake })
      .loadRoles([ADDRESS.toUpperCase().replace('0X', '0x'), ADDRESS]);
    assert.deepEqual(fake.calls[0].params, [[ADDRESS]]);
    assert.equal(result[0].observedThroughBlock, '110');
  });

  it('lists the latest retained block for unresolved non-system endpoints', async () => {
    const fake = database([{
      endpoint_address: ADDRESS, block_number: '120', block_hash: HASH,
    }]);
    const result = await createRobinhoodWalletEndpointRoleRepository({ database: fake })
      .listUnresolvedCandidates(25);
    assert.match(fake.calls[0].sql, /robinhood_token_transfer_events/);
    assert.match(fake.calls[0].sql, /LEFT JOIN robinhood_wallet_endpoint_roles/);
    assert.deepEqual(fake.calls[0].params, [25]);
    assert.deepEqual(result, [{
      endpointAddress: ADDRESS, blockNumber: '120', blockHash: HASH,
    }]);
  });
});
