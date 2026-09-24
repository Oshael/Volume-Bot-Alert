'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const db = require('../src/models/db');

const children = [
  'rh_retention_outbox',
  'rh_retention_head_candidates',
  'rh_retention_balance_snapshots',
  'rh_retention_lifecycle',
];

it('keeps event FKs and cascades valid across partition removal and reorg', async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE rh_retention_transactions (
      chain text NOT NULL, block_hash text NOT NULL, transaction_hash text NOT NULL,
      PRIMARY KEY (chain, block_hash, transaction_hash)
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE rh_retention_events (
      chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
      transaction_hash text NOT NULL, log_index integer NOT NULL,
      PRIMARY KEY (chain, block_number, block_hash, log_index),
      FOREIGN KEY (chain, block_hash, transaction_hash)
        REFERENCES rh_retention_transactions (chain, block_hash, transaction_hash)
        ON DELETE CASCADE
    ) PARTITION BY RANGE (block_number)`);
    await client.query(`CREATE TEMP TABLE rh_retention_old
      PARTITION OF rh_retention_events FOR VALUES FROM (0) TO (200)`);
    await client.query(`CREATE TEMP TABLE rh_retention_current
      PARTITION OF rh_retention_events FOR VALUES FROM (200) TO (400)`);
    for (const child of children) {
      await client.query(`CREATE TEMP TABLE ${child} (
        chain text NOT NULL, block_number bigint NOT NULL,
        block_hash text NOT NULL, log_index integer NOT NULL,
        PRIMARY KEY (chain, block_number, block_hash, log_index),
        FOREIGN KEY (chain, block_number, block_hash, log_index)
          REFERENCES rh_retention_events (chain, block_number, block_hash, log_index)
          ON DELETE CASCADE
      ) ON COMMIT DROP`);
    }

    for (const [block, hash] of [[100, 'old'], [200, 'current'], [210, 'reorg']]) {
      await client.query(`INSERT INTO rh_retention_transactions VALUES
        ('robinhood', $1, $2)`, [hash, `tx-${hash}`]);
      await client.query(`INSERT INTO rh_retention_events VALUES
        ('robinhood', $1, $2, $3, 1)`, [block, hash, `tx-${hash}`]);
      for (const child of children) {
        await client.query(`INSERT INTO ${child} VALUES ('robinhood', $1, $2, 1)`,
          [block, hash]);
      }
    }

    const byHash = await client.query(`SELECT block_number FROM rh_retention_events
      WHERE chain = 'robinhood' AND block_hash = 'current' AND log_index = 1`);
    assert.equal(byHash.rows[0].block_number, '200');

    await client.query('SAVEPOINT wrong_block');
    await assert.rejects(
      client.query(`INSERT INTO rh_retention_outbox VALUES
        ('robinhood', 201, 'old', 1)`),
      { code: '23503' }
    );
    await client.query('ROLLBACK TO SAVEPOINT wrong_block');

    await client.query(`DELETE FROM rh_retention_events
      WHERE chain = 'robinhood' AND block_number = 100`);
    for (const child of children) {
      const count = await client.query(`SELECT count(*)::integer AS n FROM ${child}`);
      assert.equal(count.rows[0].n, 2, `${child} must cascade the old event`);
    }
    await client.query(`INSERT INTO rh_retention_events VALUES
      ('robinhood', 100, 'old', 'tx-old', 1)`);
    for (const child of children) {
      await client.query(`INSERT INTO ${child} VALUES ('robinhood', 100, 'old', 1)`);
    }

    await client.query('SAVEPOINT attached_drop');
    await assert.rejects(client.query('DROP TABLE rh_retention_old'), { code: '2BP01' });
    await client.query('ROLLBACK TO SAVEPOINT attached_drop');

    await client.query('SAVEPOINT referenced_detach');
    await assert.rejects(
      client.query('ALTER TABLE rh_retention_events DETACH PARTITION rh_retention_old'),
      { code: '23503' }
    );
    await client.query('ROLLBACK TO SAVEPOINT referenced_detach');

    for (const child of children) {
      await client.query(`DELETE FROM ${child} WHERE block_number = 100`);
    }
    await client.query('ALTER TABLE rh_retention_events DETACH PARTITION rh_retention_old');
    await client.query('DROP TABLE rh_retention_old');

    await client.query(`DELETE FROM rh_retention_transactions
      WHERE chain = 'robinhood' AND block_hash = 'reorg'`);
    const events = await client.query(`SELECT block_hash FROM rh_retention_events
      WHERE chain = 'robinhood' ORDER BY block_number`);
    assert.deepEqual(events.rows, [{ block_hash: 'current' }]);
    for (const child of children) {
      const rows = await client.query(`SELECT block_hash FROM ${child}`);
      assert.deepEqual(rows.rows, [{ block_hash: 'current' }],
        `${child} must cascade the reorg without losing the current event`);
    }
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await db.pool.end();
    }
  }
});
