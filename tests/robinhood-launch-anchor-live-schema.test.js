const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage171 = require('../src/utils/db-init-stage171');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const {
  createRobinhoodLaunchAnchorOutboxRepository,
  __private: { COMMIT_CANDIDATE_SQL, LOAD_CANDIDATE_SQL },
} = require('../src/models/robinhood-launch-anchor-outbox');

const TOKEN = `0x${'a'.repeat(40)}`;

it('registers durable first-buy launch-anchor work without scanning history', () => {
  const sql = stage171.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage171-robinhood-launch-anchor-live-outbox'
  ));
  assert.match(sql, /AFTER INSERT OR UPDATE ON robinhood_wallet_token_first_buys/);
  assert.match(sql, /pg_notify\('robinhood_launch_anchor_outbox'/);
  assert.doesNotMatch(sql, /robinhood_wallet_swaps/);
  assert.doesNotMatch(LOAD_CANDIDATE_SQL, /FOR SHARE/);
  assert.doesNotMatch(LOAD_CANDIDATE_SQL, /robinhood_chain_capture_cursor/);
  assert.match(LOAD_CANDIDATE_SQL, /robinhood_wallet_token_first_buys/);
  assert.match(LOAD_CANDIDATE_SQL,
    /swap\.block_number BETWEEN target\.first_pool_block AND target\.upper_block/);
  assert.match(LOAD_CANDIDATE_SQL,
    /swap\.block_time BETWEEN target\.first_pool_time AND target\.upper_time/);
  assert.match(COMMIT_CANDIDATE_SQL, /recovery_state = 'running' FOR SHARE/);
  assert.match(COMMIT_CANDIDATE_SQL, /frontier\.canonical/);
  assert.match(COMMIT_CANDIDATE_SQL, /swap\.transaction_hash = \$6/);
  assert.equal(group.repair, 'node src/utils/db-init-stage171.js');
});

it('loads without the cursor lock and revalidates exact evidence before writing', async () => {
  const calls = [];
  const database = {
    queryWithStatementTimeout: async (sql, values, timeoutMs) => {
      calls.push({ sql, values, timeoutMs });
      if (sql === LOAD_CANDIDATE_SQL) {
        return { rows: [{
          readiness: 'ready', first_pool_block: '100', launch_block: '101',
          launch_block_time: new Date('2026-01-01T00:00:00Z'),
          launch_transaction_hash: `0x${'b'.repeat(64)}`, launch_action_index: '2',
          launch_protocol: 'uniswap-v2', launch_market_key: `0x${'c'.repeat(40)}`,
        }] };
      }
      return { rowCount: 1, rows: [{ token_address: TOKEN }] };
    },
  };
  const repository = createRobinhoodLaunchAnchorOutboxRepository({ database, timeoutMs: 5000 });
  assert.deepEqual(await repository.materialize(TOKEN), { status: 'materialized' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sql, LOAD_CANDIDATE_SQL);
  assert.equal(calls[1].sql, COMMIT_CANDIDATE_SQL);
  assert.deepEqual(calls[1].values.slice(0, 4), ['robinhood', TOKEN, '100', '101']);
});

it('classifies missing holders as terminal without taking the cursor lock', async () => {
  const calls = [];
  const database = { queryWithStatementTimeout: async (sql) => {
    calls.push(sql);
    return { rows: [{ readiness: 'holder_missing' }] };
  } };
  const repository = createRobinhoodLaunchAnchorOutboxRepository({ database });
  assert.deepEqual(await repository.materialize(TOKEN), {
    status: 'ineligible', reason: 'holder_missing',
  });
  assert.deepEqual(calls, [LOAD_CANDIDATE_SQL]);
});
