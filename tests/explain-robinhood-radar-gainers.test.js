const assert = require('node:assert/strict');
const { it } = require('node:test');
const { explainGainers } = require('../src/utils/explain-robinhood-radar-gainers');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const stage268 = require('../src/utils/db-init-stage268');

it('measures the real ranking SQL in a bounded read-only transaction and preserves cleanup on failure', async () => {
  for (const mode of ['plan', 'analyze', 'failure']) {
    const calls = []; let released = false;
    const database = { async getClient() { return {
      async query(sql) {
        calls.push(sql);
        if (sql.startsWith('SELECT relation.relkind')) return { rows: [{ partitioned: false }] };
        if (sql.startsWith('SELECT NOW()')) return { rows: [{ catalog_tokens: 500000, young_tokens: 100 }] };
        if (sql.startsWith('EXPLAIN')) {
          if (mode === 'failure') throw Object.assign(new Error('timeout'), { code: '57014' });
          return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Index Scan',
            'Relation Name': 'token_catalog', 'Index Name': stage268.INDEX_NAME, 'Plan Rows': 100 },
          }] }] };
        }
        return { rows: [] };
      }, release() { released = true; },
    }; } };
    const input = { mode: mode === 'failure' ? 'analyze' : mode, asOf: '2026-10-06T12:00:35Z' };
    if (mode === 'failure') await assert.rejects(explainGainers(input, database), { code: '57014' });
    else {
      const report = await explainGainers(input, database);
      assert.equal(report.asOf, '2026-10-06T12:00:00.000Z');
      assert.equal(report.scans[0].index, stage268.INDEX_NAME);
      assert.match(calls.find((sql) => sql.startsWith('EXPLAIN')), /WITH candidates AS MATERIALIZED/);
      assert.equal(calls.some((sql) => sql.startsWith('EXPLAIN (ANALYZE')), mode === 'analyze');
    }
    assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.ok(calls.includes("SET LOCAL statement_timeout = '5s'"));
    assert.ok(calls.includes("SET LOCAL lock_timeout = '500ms'"));
    assert.equal(calls.at(-1), 'ROLLBACK'); assert.equal(released, true);
  }
});

it('registers the creation index definition in the runtime schema contract', () => {
  const group = SCHEMA_GROUPS.find((item) => item.key === 'stage268-robinhood-radar-creation-index');
  assert.equal(group.repair, 'node src/utils/db-init-stage268.js');
  assert.equal(group.tables[0].indexes[0].name, stage268.INDEX_NAME);
  for (const part of group.tables[0].indexes[0].includes) assert.ok(stage268.STATEMENTS[0].includes(part));
});
