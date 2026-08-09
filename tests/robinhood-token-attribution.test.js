const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage110 = require('../src/utils/db-init-stage110');
const { createRobinhoodTokenAttributionRepository } = require('../src/models/robinhood-token-attribution');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { CONFIRM, parseArgs, run } = require('../src/utils/backfill-robinhood-token-creators');

const TOKEN = `0x${'a'.repeat(40)}`;
const CREATOR = `0x${'b'.repeat(40)}`;

describe('Robinhood token creator attribution', () => {
  it('registers an additive, retryable attribution table in the runtime guard', () => {
    const sql = stage110.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage110-robinhood-token-attributions'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_token_attributions/);
    assert.match(sql, /PRIMARY KEY \(chain, token_address\)/);
    assert.match(sql, /creator_address IS NULL AND last_resolved_at IS NULL/);
    assert.match(sql, /WHERE creator_address IS NULL/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage110.js');
    assert.equal(group.tables[0].indexes[0].name, 'idx_robinhood_token_attributions_retry');
  });

  it('lists only unresolved or stale registry tokens in discovery order', async () => {
    const calls = [];
    const repository = createRobinhoodTokenAttributionRepository({
      database: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [{ token_address: TOKEN.toUpperCase(), discovery_block: '123' }] };
        },
      },
    });
    const retryBefore = new Date('2026-08-01T00:00:00.000Z');

    assert.deepEqual(await repository.listCreatorCandidates({ retryBefore, limit: 12 }), [
      { tokenAddress: TOKEN, discoveryBlock: '123' },
    ]);
    assert.match(calls[0].sql, /LEFT JOIN robinhood_token_attributions/);
    assert.match(calls[0].sql, /attribution\.creator_address IS NULL/);
    assert.match(calls[0].sql, /attribution\.last_attempted_at < \$1/);
    assert.match(calls[0].sql, /ORDER BY MIN\(registry\.discovery_block\), registry\.token_address/);
    assert.deepEqual(calls[0].params, [retryBefore.toISOString(), 12]);
  });

  it('normalizes and records a resolved direct contract creator', async () => {
    const calls = [];
    const repository = createRobinhoodTokenAttributionRepository({
      database: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [{ token_address: params[0], creator_address: params[1] }] };
        },
      },
    });

    const row = await repository.recordAttempt({
      tokenAddress: TOKEN.toUpperCase(), creatorAddress: CREATOR.toUpperCase(),
    });
    assert.deepEqual(row, { token_address: TOKEN, creator_address: CREATOR });
    assert.deepEqual(calls[0].params, [TOKEN, CREATOR, null]);
    assert.match(calls[0].sql, /ON CONFLICT \(chain, token_address\) DO UPDATE/);
    assert.match(calls[0].sql, /COALESCE\(EXCLUDED\.creator_address/);
  });

  it('is dry-run by default and performs no Blockscout lookup or write', async () => {
    let lookups = 0;
    let writes = 0;
    const repository = {
      listCreatorCandidates: async () => [{ tokenAddress: TOKEN, discoveryBlock: '1' }],
      recordAttempt: async () => { writes += 1; },
    };
    const summary = await run({
      options: { apply: false, limit: 10, sleepMs: 0, retryHours: 24 },
      repository,
      client: { getContractCreator: async () => { lookups += 1; } },
    });

    assert.deepEqual(summary, {
      apply: false, candidates: 1, resolved: 0, unresolved: 0, failed: 0,
    });
    assert.equal(lookups, 0);
    assert.equal(writes, 0);
  });

  it('persists resolved, unresolved, and provider failures without hiding them', async () => {
    const candidates = [TOKEN, `0x${'c'.repeat(40)}`, `0x${'d'.repeat(40)}`]
      .map((tokenAddress) => ({ tokenAddress, discoveryBlock: '1' }));
    const attempts = [];
    let index = 0;
    const summary = await run({
      options: { apply: true, limit: 10, sleepMs: 0, retryHours: 24 },
      repository: {
        listCreatorCandidates: async () => candidates,
        recordAttempt: async (attempt) => { attempts.push(attempt); },
      },
      client: {
        getContractCreator: async () => {
          index += 1;
          if (index === 1) return CREATOR;
          if (index === 2) return null;
          throw new Error('rate limited');
        },
      },
    });

    assert.deepEqual(summary, {
      apply: true, candidates: 3, resolved: 1, unresolved: 1, failed: 1,
    });
    assert.equal(attempts[0].creatorAddress, CREATOR);
    assert.equal(attempts[1].creatorAddress, null);
    assert.equal(attempts[2].error, 'rate limited');
  });

  it('does not misclassify a persistence failure as a provider failure', async () => {
    let writes = 0;
    await assert.rejects(() => run({
      options: { apply: true, limit: 1, sleepMs: 0, retryHours: 24 },
      repository: {
        listCreatorCandidates: async () => [{ tokenAddress: TOKEN, discoveryBlock: '1' }],
        recordAttempt: async () => { writes += 1; throw new Error('database unavailable'); },
      },
      client: { getContractCreator: async () => CREATOR },
    }), /database unavailable/);
    assert.equal(writes, 1);
  });

  it('requires explicit confirmation and validates operational bounds', () => {
    assert.equal(parseArgs([]).apply, false);
    assert.equal(parseArgs([CONFIRM, '--limit', '25', '--sleep-ms', '0']).apply, true);
    assert.throws(() => parseArgs(['--limit', '0']), /--limit/);
    assert.throws(() => parseArgs(['--sleep-ms', '-1']), /--sleep-ms/);
    assert.throws(() => parseArgs(['--retry-hours', '-1']), /--retry-hours/);
  });
});
