'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { runPilot } = require('../src/services/robinhood-chain-event-pruner');

let client;

before(async () => {
  client = await db.getClient();
  await client.query(`CREATE TEMP TABLE robinhood_chain_events (
    chain text NOT NULL, block_hash text NOT NULL, block_number bigint NOT NULL,
    transaction_index int NOT NULL, log_index int NOT NULL,
    PRIMARY KEY (chain, block_hash, log_index)
  ) ON COMMIT PRESERVE ROWS`);
  await client.query(`CREATE INDEX idx_rh_chain_events_order
    ON robinhood_chain_events(chain, block_number, transaction_index, log_index)`);
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
    client.release();
  }
  await db.pool.end();
});

describe('Robinhood chain event pruner integration', () => {
  it('cascades a bounded old event and preserves the cutoff event', async () => {
    for (const [hash, block] of [['old-a', 10], ['old-b', 20], ['cutoff', 30]]) {
      await client.query(
        `INSERT INTO robinhood_chain_events VALUES ('robinhood',$1,$2,0,0)`, [hash, block]
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
    const report = await runPilot({ batchLimit: 1 }, {
      database,
      audit: { inspect: async () => ({ chain_events: {
        ready_for_pilot: true, candidate_cutoff_block: '30', blockers: [],
      } }) },
    });
    assert.equal(report.totalDeleted, 1);
    for (const table of [
      'robinhood_chain_events', 'robinhood_chain_domain_outbox',
      'robinhood_canonical_head_candidates', 'robinhood_chain_v3_balance_snapshots',
    ]) {
      const rows = await client.query(`SELECT block_hash FROM ${table} ORDER BY block_hash`);
      assert.deepEqual(rows.rows, [{ block_hash: 'cutoff' }, { block_hash: 'old-b' }]);
    }
  });
});
