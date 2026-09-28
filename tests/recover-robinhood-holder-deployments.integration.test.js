'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { before, after, it } = require('node:test');
const db = require('../src/models/db');
const stage165 = require('../src/utils/db-init-stage165');
const stage215 = require('../src/utils/db-init-stage215');
const stage242 = require('../src/utils/db-init-stage242');
const {
  createRobinhoodTokenDeploymentOutboxRepository,
} = require('../src/models/robinhood-token-deployment-outbox');
const { listCandidates } = require('../src/utils/recover-robinhood-holder-deployments');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'8'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const NEW_HASH = `0x${'b'.repeat(64)}`;
const TX = `0x${'c'.repeat(64)}`;

before(async () => {
  await assertUsingTestDatabase(db);
  await stage165.init({ closePool: false });
  await stage215.init({ closePool: false });
  await stage242.init({ closePool: false });
});
after(async () => { await db.pool.end(); });

it('does not delete a reopened or changed deployment task', async () => {
  const client = await db.getClient();
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO robinhood_token_deployment_outbox(
      chain, token_address, status, archive_required_at,
      mint_block_number, mint_block_hash, mint_transaction_hash, last_error
    ) VALUES ('robinhood', $1, 'archive_required', NOW(), 100, $2, $3,
      'rpc_code_transition:rpc_error:eth_getCode RPC error -32000')`,
    [TOKEN, HASH, TX]);
    const database = { query: (sql, params) => client.query(sql, params) };
    const candidates = await listCandidates(database, 1000, { pinnedLiveRpcError: true });
    const selected = candidates.find(({ tokenAddress }) => tokenAddress === TOKEN);
    assert.equal(selected.upperBlock, '100');
    assert.deepEqual(selected.pinnedHint, {
      tokenAddress: TOKEN, blockNumber: '100', blockHash: HASH, transactionHash: TX,
    });
    const repository = createRobinhoodTokenDeploymentOutboxRepository({
      database,
    });
    const hint = { tokenAddress: TOKEN, blockNumber: '100',
      blockHash: HASH, transactionHash: TX };
    assert.equal(await repository.completePinnedRecovered({ ...hint, blockHash: NEW_HASH }), false);

    await client.query('SAVEPOINT before_reopen');
    await client.query(`UPDATE robinhood_token_deployment_outbox SET
      status='pending', archive_required_at=NULL,
      mint_block_number=101, mint_block_hash=$2
      WHERE chain='robinhood' AND token_address=$1`, [TOKEN, NEW_HASH]);
    assert.equal(await repository.completePinnedRecovered(hint), false);
    assert.deepEqual((await client.query(`SELECT status, mint_block_number::text
      FROM robinhood_token_deployment_outbox WHERE token_address=$1`, [TOKEN])).rows[0], {
      status: 'pending', mint_block_number: '101',
    });

    await client.query('ROLLBACK TO SAVEPOINT before_reopen');
    assert.equal(await repository.completePinnedRecovered(hint), true);
    assert.equal((await client.query(`SELECT 1 FROM robinhood_token_deployment_outbox
      WHERE token_address=$1`, [TOKEN])).rowCount, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('selects only archived no-hint tasks and guards their completion', async () => {
  const client = await db.getClient();
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO robinhood_token_deployment_outbox(
      chain, token_address, status, archive_required_at, last_error
    ) VALUES ('robinhood', $1, 'archive_required', NOW(),
      'canonical_creator_evidence:local_deployment_evidence_pending')`, [TOKEN]);
    const database = { query: (sql, params) => client.query(sql, params) };
    const repository = createRobinhoodTokenDeploymentOutboxRepository({ database });
    const selected = (await listCandidates(database, 1000, { archiveNoHint: true }))
      .find(({ tokenAddress }) => tokenAddress === TOKEN);
    assert.equal(selected.archiveNoHint, true);
    assert.equal(selected.upperBlock, null);
    assert.equal(await repository.completeArchiveNoHintRecovered({
      ...selected, archiveRequiredAt: '2026-09-24 10:00:00+00',
    }), false);

    await client.query('SAVEPOINT before_reopen');
    await client.query(`UPDATE robinhood_token_deployment_outbox SET
      status='pending', archive_required_at=NULL,
      mint_block_number=101, mint_block_hash=$2, mint_transaction_hash=$3
      WHERE chain='robinhood' AND token_address=$1`, [TOKEN, NEW_HASH, TX]);
    assert.equal(await repository.completeArchiveNoHintRecovered(selected), false);
    await client.query('ROLLBACK TO SAVEPOINT before_reopen');

    assert.equal(await repository.completeArchiveNoHintRecovered(selected), true);
    assert.equal((await client.query(`SELECT 1 FROM robinhood_token_deployment_outbox
      WHERE chain='robinhood' AND token_address=$1`, [TOKEN])).rowCount, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('keeps a pending no-hint task when the live worker changes it during recovery', async () => {
  const client = await db.getClient();
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO robinhood_token_deployment_outbox(
      chain, token_address, status, last_error
    ) VALUES ('robinhood', $1, 'pending',
      'canonical_creator_evidence:local_deployment_evidence_pending')`, [TOKEN]);
    const database = { query: (sql, params) => client.query(sql, params) };
    const repository = createRobinhoodTokenDeploymentOutboxRepository({ database });
    const selected = (await listCandidates(database, 1000, { noHint: true }))
      .find(({ tokenAddress }) => tokenAddress === TOKEN);
    assert.equal(selected.selectedStatus, 'pending');
    assert.equal(selected.upperBlock, null);

    await client.query(`UPDATE robinhood_token_deployment_outbox
      SET attempt_count=attempt_count+1, updated_at=updated_at+INTERVAL '1 millisecond'
      WHERE chain='robinhood' AND token_address=$1`, [TOKEN]);
    assert.equal(await repository.completeNoHintRecovered(selected), false);

    const retried = (await listCandidates(database, 1000, { noHint: true }))
      .find(({ tokenAddress }) => tokenAddress === TOKEN);
    await client.query(`UPDATE robinhood_token_deployment_outbox
      SET mint_block_number=101, mint_block_hash=$2, mint_transaction_hash=$3,
          updated_at=updated_at+INTERVAL '1 millisecond'
      WHERE chain='robinhood' AND token_address=$1`, [TOKEN, NEW_HASH, TX]);
    assert.equal(await repository.completeNoHintRecovered(retried), false);
    await client.query(`UPDATE robinhood_token_deployment_outbox
      SET mint_block_number=NULL, mint_block_hash=NULL, mint_transaction_hash=NULL,
          updated_at=updated_at+INTERVAL '1 millisecond'
      WHERE chain='robinhood' AND token_address=$1`, [TOKEN]);

    const current = (await listCandidates(database, 1000, { noHint: true }))
      .find(({ tokenAddress }) => tokenAddress === TOKEN);
    assert.equal(await repository.completeNoHintRecovered(current), true);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
