'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const {
  pruneBatch, resolveRetentionCutoff,
  runPilot,
} = require('../src/services/robinhood-chain-event-pruner');

let client;

before(async () => {
  client = await db.getClient();
  await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
    chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
    block_timestamp timestamptz NOT NULL,
    canonical boolean NOT NULL DEFAULT true,
    PRIMARY KEY (chain, block_hash)
  ) ON COMMIT PRESERVE ROWS`);
  await client.query(`CREATE INDEX idx_rh_chain_blocks_retention
    ON robinhood_chain_blocks(chain, block_number, block_hash)
    INCLUDE (block_timestamp)`);
  await client.query(`CREATE TEMP TABLE robinhood_chain_transactions (
    chain text NOT NULL, block_hash text NOT NULL, transaction_hash text NOT NULL,
    transaction_index int NOT NULL,
    PRIMARY KEY (chain, block_hash, transaction_hash),
    FOREIGN KEY (chain, block_hash) REFERENCES robinhood_chain_blocks(chain, block_hash)
      ON DELETE CASCADE
  ) ON COMMIT PRESERVE ROWS`);
  await client.query(`CREATE TEMP TABLE robinhood_chain_events (
    chain text NOT NULL, block_hash text NOT NULL, block_number bigint NOT NULL,
    transaction_hash text NOT NULL, transaction_index int NOT NULL, log_index int NOT NULL,
    PRIMARY KEY (chain, block_hash, log_index),
    FOREIGN KEY (chain, block_hash, transaction_hash)
      REFERENCES robinhood_chain_transactions(chain, block_hash, transaction_hash)
      ON DELETE CASCADE
  ) ON COMMIT PRESERVE ROWS`);
  await client.query(`CREATE INDEX idx_rh_chain_events_order
    ON robinhood_chain_events(chain, block_number, transaction_index, log_index)`);
  await client.query(`CREATE INDEX idx_rh_chain_events_transaction_lookup
    ON robinhood_chain_events(chain, block_hash, transaction_hash)`);
  await client.query(`CREATE TEMP TABLE robinhood_chain_domain_outbox (
    chain text NOT NULL, domain text NOT NULL, block_hash text NOT NULL, log_index int NOT NULL,
    PRIMARY KEY (chain, domain, block_hash, log_index),
    FOREIGN KEY (chain, block_hash, log_index)
      REFERENCES robinhood_chain_events(chain, block_hash, log_index) ON DELETE CASCADE
  ) ON COMMIT PRESERVE ROWS`);
  await client.query(`CREATE INDEX idx_rh_chain_domain_outbox_event_lookup
    ON robinhood_chain_domain_outbox(block_hash, log_index)`);
  await client.query(`CREATE TEMP TABLE robinhood_canonical_head_candidates (
    chain text NOT NULL, block_hash text NOT NULL, log_index int NOT NULL,
    PRIMARY KEY (chain, block_hash, log_index),
    FOREIGN KEY (chain, block_hash, log_index)
      REFERENCES robinhood_chain_events(chain, block_hash, log_index) ON DELETE CASCADE
  ) ON COMMIT PRESERVE ROWS`);
  await client.query(`CREATE INDEX idx_rh_canonical_head_candidates_event_lookup
    ON robinhood_canonical_head_candidates(block_hash, log_index)`);
  await client.query(`CREATE TEMP TABLE robinhood_chain_v3_balance_snapshots (
    chain text NOT NULL, block_hash text NOT NULL, log_index int NOT NULL,
    PRIMARY KEY (chain, block_hash, log_index),
    FOREIGN KEY (chain, block_hash, log_index)
      REFERENCES robinhood_chain_events(chain, block_hash, log_index) ON DELETE CASCADE
  ) ON COMMIT PRESERVE ROWS`);
});

after(async () => {
  if (client) {
    await client.query('DROP TABLE IF EXISTS robinhood_chain_v3_balance_snapshots');
    await client.query('DROP TABLE IF EXISTS robinhood_canonical_head_candidates');
    await client.query('DROP TABLE IF EXISTS robinhood_chain_domain_outbox');
    await client.query('DROP TABLE IF EXISTS robinhood_chain_events');
    await client.query('DROP TABLE IF EXISTS robinhood_chain_transactions');
    await client.query('DROP TABLE IF EXISTS robinhood_chain_blocks');
    client.release();
  }
  await db.pool.end();
});

describe('Robinhood chain event pruner integration', () => {
  it('cascades old events while preserving the time and frontier cutoffs', async () => {
    for (const [hash, block, age] of [
      ['recent', 5, '2 days'], ['old-a', 10, '4 days'],
      ['old-b', 20, '4 days'], ['cutoff', 30, '4 days'],
    ]) {
      await client.query(
        `INSERT INTO robinhood_chain_blocks(
           chain, block_number, block_hash, block_timestamp
         ) VALUES ('robinhood',$1,$2,NOW() - $3::interval)`,
        [block, hash, age]
      );
      await client.query(
        `INSERT INTO robinhood_chain_transactions
         VALUES ('robinhood',$1,$2,0)`, [hash, `tx-${hash}`]
      );
      await client.query(
        `INSERT INTO robinhood_chain_events
         VALUES ('robinhood',$1,$2,$3,0,0)`, [hash, block, `tx-${hash}`]
      );
      await client.query(
        `INSERT INTO robinhood_chain_domain_outbox VALUES ('robinhood','market',$1,0)`, [hash]
      );
      await client.query(
        `INSERT INTO robinhood_canonical_head_candidates VALUES ('robinhood',$1,0)`, [hash]
      );
      await client.query(
        `INSERT INTO robinhood_chain_v3_balance_snapshots VALUES ('robinhood',$1,0)`, [hash]
      );
    }
    const database = { getClient: async () => ({
      query: client.query.bind(client), release() {},
    }) };
    const report = await runPilot({ batchLimit: 10, pruneCanonicalStorage: true }, {
      database,
      audit: { inspect: async () => ({ chain_events: {
        ready_for_pilot: true, journal_start_block: '10',
        candidate_cutoff_block: '30', blockers: [],
      } }) },
      resolveRetentionCutoff: async () => '30',
    });
    assert.equal(report.totalDeleted, 2);
    assert.equal(report.totalDeletedTransactions, 2);
    assert.equal(report.totalDeletedBlocks, 2);
    await assert.rejects(pruneBatch(database, '30', 10, 0), /retentionMs must be between/);
    for (const table of [
      'robinhood_chain_events', 'robinhood_chain_domain_outbox',
      'robinhood_canonical_head_candidates', 'robinhood_chain_v3_balance_snapshots',
    ]) {
      const rows = await client.query(`SELECT block_hash FROM ${table} ORDER BY block_hash`);
      assert.deepEqual(rows.rows, [{ block_hash: 'cutoff' }, { block_hash: 'recent' }]);
    }
    const transactions = await client.query(
      'SELECT block_hash FROM robinhood_chain_transactions ORDER BY block_hash'
    );
    assert.deepEqual(transactions.rows, [
      { block_hash: 'cutoff' }, { block_hash: 'recent' },
    ]);
    const blocks = await client.query(
      'SELECT block_hash FROM robinhood_chain_blocks ORDER BY block_hash'
    );
    assert.deepEqual(blocks.rows, [
      { block_hash: 'cutoff' }, { block_hash: 'recent' },
    ]);
  });

  it('finds the three-day block boundary with indexed block-number probes', async () => {
    for (let block = 100; block < 109; block += 1) {
      await client.query(
        `INSERT INTO robinhood_chain_blocks(
           chain, block_number, block_hash, block_timestamp
         ) VALUES ('robinhood',$1,$2,NOW() - $3::interval)`,
        [block, `boundary-${block}`, block < 105 ? '4 days' : '2 days']
      );
    }
    const database = { getClient: async () => ({
      query: client.query.bind(client), release() {},
    }) };

    const cutoff = await resolveRetentionCutoff(database, {
      journalStartBlock: '100', safetyCutoffBlock: '109',
      retentionMs: 3 * 24 * 60 * 60 * 1000,
    });

    assert.equal(cutoff, '105');
  });
});
