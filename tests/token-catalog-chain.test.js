const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const adminBlockedToken = require('../src/models/admin-blocked-token');
const db = require('../src/models/db');
const tokenCatalog = require('../src/models/token-catalog');

const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM_MIXED = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';
const EVM_LOWER = EVM_MIXED.toLowerCase();

async function withCatalogQueries(handler, callback) {
  const originalQuery = db.query;
  const originalEnsureTable = adminBlockedToken.ensureTable;
  db.query = handler;
  adminBlockedToken.ensureTable = async () => {};
  try {
    return await callback();
  } finally {
    db.query = originalQuery;
    adminBlockedToken.ensureTable = originalEnsureTable;
  }
}

describe('token catalog chain identity', () => {
  it('keeps legacy upserts on Solana while enforcing chain-aware block checks', async () => {
    let captured;
    const row = await withCatalogQueries(async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ address: params[0], chain: params[1] }] };
    }, () => tokenCatalog.upsertToken({ address: SOLANA, source: 'test' }));

    assert.deepEqual(row, { address: SOLANA, chain: 'solana' });
    assert.equal(captured.params[1], 'solana');
    assert.match(captured.sql, /ab\.chain = \$2::text AND ab\.address = \$24/);
    assert.match(captured.sql, /ON CONFLICT \(chain, address\)/);
    assert.doesNotMatch(captured.sql, /chain = EXCLUDED\.chain,/);
  });

  it('normalizes Robinhood addresses for a composite identity upsert', async () => {
    let capturedParams;
    const row = await withCatalogQueries(async (_sql, params) => {
      capturedParams = params;
      return { rows: [{ address: params[0], chain: params[1] }] };
    }, () => tokenCatalog.upsertToken({
      chain: 'robinhood',
      address: EVM_MIXED,
      source: 'robinhood-onchain',
    }));

    assert.equal(capturedParams[0], EVM_LOWER);
    assert.equal(capturedParams[1], 'robinhood');
    assert.deepEqual(row, { address: EVM_LOWER, chain: 'robinhood' });
  });

  it('looks up canonical chain and address without silent fallback', async () => {
    const calls = [];
    await withCatalogQueries(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    }, async () => {
      assert.equal(await tokenCatalog.getByAddress(EVM_MIXED, 'robinhood'), null);
      await tokenCatalog.listRecent(10, 'robinhood');
      assert.equal(await tokenCatalog.getMarketBaselineByAddress(EVM_MIXED, 'robinhood'), null);
      await assert.rejects(tokenCatalog.getByAddress(EVM_MIXED, 'unknown'), /Unsupported token chain/);
    });

    assert.deepEqual(calls[0].params, ['robinhood', EVM_LOWER]);
    assert.match(calls[0].sql, /WHERE chain = \$1 AND address = \$2/);
    assert.deepEqual(calls[1].params, [10, 'robinhood']);
    assert.match(calls[1].sql, /WHERE chain = \$2/);
    assert.deepEqual(calls[2].params, ['robinhood', EVM_LOWER]);
    assert.match(calls[2].sql, /WHERE chain = \$1 AND address = \$2/);
  });

  it('loads dashboard metadata with the requested chain and normalized EVM addresses', async () => {
    let captured;
    await withCatalogQueries(async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    }, () => tokenCatalog.listDashboardMetadataByAddresses(
      [EVM_MIXED, EVM_LOWER, 'invalid'],
      { chain: 'robinhood' }
    ));

    assert.deepEqual(captured.params, ['robinhood', [EVM_LOWER]]);
    assert.match(captured.sql, /tc\.launchpad_id/);
    assert.match(captured.sql, /WHERE tc\.chain = \$1/);
    assert.match(captured.sql, /tc\.address = ANY\(\$2::varchar\[\]\)/);
  });

  it('keeps legacy Solana workers isolated from Robinhood catalog rows', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };

    await withCatalogQueries(runner.query.bind(runner), async () => {
      await tokenCatalog.listDueForEvaluation(5);
      await tokenCatalog.claimDueForEvaluation(5, {}, runner);
      await tokenCatalog.countDueForMeteoraSnapshots();
      await tokenCatalog.listEligibleVisible(5);
    });

    assert.match(calls[0].sql, /WHERE chain = 'solana'/);
    assert.match(calls[0].sql, /ut\.chain = token_catalog\.chain/);
    assert.match(calls[1].sql, /SELECT id[\s\S]*WHERE chain = 'solana'/);
    assert.match(calls[1].sql, /WHERE tc\.id = claimed\.id/);
    assert.match(calls[2].sql, /WHERE catalog_candidate\.chain = 'solana'/);
    assert.match(calls[2].sql, /ON pool_candidate\.chain = 'solana'/);
    assert.match(calls[3].sql, /WHERE chain = 'solana'/);
  });

  it('scopes catalog cleanup candidates and protections to Solana identities', async () => {
    const calls = [];
    await withCatalogQueries(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }, async () => {
      await tokenCatalog.applyQuarantineCleanup({ quarantineRecheckMs: 60_000 });
      await tokenCatalog.applySoftArchiveCleanup({
        archiveLimit: 25,
        softArchiveRecheckMs: 60_000,
      });
    });

    assert.equal(calls.length, 2);
    for (const { sql } of calls) {
      assert.match(sql, /SELECT chain, address FROM user_tokens/);
      assert.match(sql, /SELECT chain, address FROM user_starred_tokens/);
      assert.match(sql, /SELECT chain, address FROM user_blocklist/);
      assert.match(sql, /SELECT chain, address FROM token_catalog WHERE source = 'user-manual'/);
      assert.match(sql, /WHERE tc\.chain = 'solana'/);
      assert.match(sql, /protected\.chain = tc\.chain\s+AND protected\.address = tc\.address/);
    }

    assert.match(calls[1].sql, /SELECT tc\.chain, tc\.address/);
    assert.match(
      calls[1].sql,
      /WHERE tc\.chain = candidate\.chain\s+AND tc\.address = candidate\.address/
    );
  });
});
