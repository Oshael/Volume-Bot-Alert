const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SCHEMA_GROUPS, __private } = require('../src/utils/runtime-schema');

const requirement = SCHEMA_GROUPS.find(
  ({ key }) => key === 'stage192-robinhood-complete-transaction-context'
).tables.find(({ table }) => table === 'robinhood_chain_transactions');
const name = 'rh_chain_transactions_context_check';
const rendered = 'CHECK ((((nonce IS NULL) OR (nonce >= (0)::numeric)) AND '
  + '((value_wei IS NULL) OR (value_wei >= (0)::numeric))))';

test('Stage 192 accepts PostgreSQL numeric casts without losing either nonnegative check', () => {
  for (const definition of [rendered, rendered.replaceAll('(0)::numeric', '0')]) {
    assert.deepEqual(__private.collectMissingConstraints(requirement, new Map([
      [name, definition],
    ])), []);
  }
  for (const definition of [
    undefined,
    rendered.replace('nonce >= (0)::numeric', 'nonce < (0)::numeric'),
    rendered.replace('value_wei >= (0)::numeric', 'value_wei < (0)::numeric'),
    rendered.replaceAll('>= (0)::numeric', '>= (-1)::numeric'),
  ]) {
    const constraints = new Map(definition ? [[name, definition]] : []);
    assert.equal(__private.collectMissingConstraints(requirement, constraints).length, 1);
  }
});
