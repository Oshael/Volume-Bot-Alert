'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAutomaticPruneBudget } = require('../src/models/robinhood-holder-prune-budget');

test('automatic prune shares one time budget across statements including commit', async () => {
  let time = 100;
  const statements = [];
  const client = { query: async (sql, params) => {
    statements.push({ sql, params });
    return { rows: [{ value: 1 }] };
  } };
  const bounded = await createAutomaticPruneBudget(client, () => time);
  await bounded.query('SELECT 1');
  time += 7500;
  await bounded.query('COMMIT');
  assert.deepEqual(statements.filter(({ params }) => params).map(({ params }) => params),
    [['2000ms'], ['500ms']]);
  time += 500;
  const before = statements.length;
  await assert.rejects(bounded.query('SELECT 2'), { code: 'holder_journal_prune_budget' });
  assert.equal(statements.length, before);
});

test('a PostgreSQL timeout is returned to the transaction owner for rollback', async () => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), {
    code: '57014',
  });
  const bounded = await createAutomaticPruneBudget({ query: async (sql) => {
    if (sql === 'SELECT slow') throw timeout;
    return { rows: [] };
  } });
  await assert.rejects(bounded.query('SELECT slow'), (error) => error === timeout);
});
