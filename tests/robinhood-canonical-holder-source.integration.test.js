'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodCanonicalHolderSource,
} = require('../src/models/robinhood-canonical-holder-source');
const {
  __private: { createRecentReplayReader },
} = require('../src/services/robinhood-holder-backfill-executor');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const {
  createRobinhoodHolderTransferReader,
} = require('../src/services/robinhood-holder-transfer-reader');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const OTHER_TOKEN = `0x${'2'.repeat(40)}`;
const FROM = `0x${'3'.repeat(40)}`;
const TO = `0x${'4'.repeat(40)}`;
const BLOCK_100 = `0x${'a'.repeat(64)}`;
const BLOCK_101 = `0x${'b'.repeat(64)}`;
const BLOCK_102 = `0x${'c'.repeat(64)}`;
const ORPHAN_BLOCK = `0x${'d'.repeat(64)}`;
const TX = `0x${'e'.repeat(64)}`;
const topicAddress = (value) => `0x${'0'.repeat(24)}${value.slice(2)}`;
const TOPICS = [TRANSFER_TOPIC, topicAddress(FROM), topicAddress(TO)];
const DATA = `0x${'0'.repeat(63)}5`;

let client;
let database;
let source;

async function seedCanonicalJournal() {
  await client.query(
    `INSERT INTO robinhood_chain_capture_cursor(
       chain, next_block, checkpoint_block, checkpoint_hash, node_head
     ) VALUES ('robinhood', 103, 102, $1, 110)`,
    [BLOCK_102]
  );
  await client.query(
    `INSERT INTO robinhood_chain_blocks(chain, block_number, block_hash, canonical) VALUES
       ('robinhood',100,$1,TRUE), ('robinhood',101,$2,TRUE),
       ('robinhood',102,$3,TRUE), ('robinhood',101,$4,FALSE)`,
    [BLOCK_100, BLOCK_101, BLOCK_102, ORPHAN_BLOCK]
  );
  await client.query(
    `INSERT INTO robinhood_chain_events(
       chain, block_hash, block_number, transaction_hash, transaction_index,
       log_index, address, topic0, topics, data
     ) VALUES
       ('robinhood',$1,101,$2,0,0,$3,$4,$5::jsonb,$6),
       ('robinhood',$1,101,$7,1,1,$8,$4,$5::jsonb,$6),
       ('robinhood',$9,101,$10,2,2,$3,$4,$5::jsonb,$6)`,
    [
      BLOCK_101, TX, TOKEN, TRANSFER_TOPIC, JSON.stringify(TOPICS), DATA,
      `0x${'f'.repeat(64)}`, OTHER_TOKEN, ORPHAN_BLOCK, `0x${'9'.repeat(64)}`,
    ]
  );
}

function rpcReader() {
  return createRobinhoodHolderTransferReader({
    rpcClient: {
      async request(method) {
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getLogs') return [{
          blockNumber: '0x65', blockHash: BLOCK_101, transactionHash: TX,
          transactionIndex: '0x0', logIndex: '0x0', address: TOKEN,
          topics: TOPICS, data: DATA, removed: false,
        }];
        if (method === 'eth_getBlockByNumber') {
          return { number: '0x66', hash: BLOCK_102 };
        }
        throw new Error(`unexpected RPC method: ${method}`);
      },
    },
  });
}

before(async () => {
  await assertUsingTestDatabase(db);
  client = await db.getClient();
  await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
    chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
    canonical boolean NOT NULL, PRIMARY KEY (chain, block_hash)
  ) ON COMMIT PRESERVE ROWS`);
  await client.query(`CREATE UNIQUE INDEX test_rh_blocks_canonical_number
    ON robinhood_chain_blocks(chain, block_number) WHERE canonical`);
  await client.query(`CREATE TEMP TABLE robinhood_chain_events (
    chain text NOT NULL, block_hash text NOT NULL, block_number bigint NOT NULL,
    transaction_hash text NOT NULL, transaction_index int NOT NULL,
    log_index int NOT NULL, address text NOT NULL, topic0 text NOT NULL,
    topics jsonb NOT NULL, data text NOT NULL,
    PRIMARY KEY (chain, block_hash, log_index)
  ) ON COMMIT PRESERVE ROWS`);
  await client.query(`CREATE INDEX test_rh_events_order
    ON robinhood_chain_events(chain, block_number, transaction_index, log_index)`);
  await client.query(`CREATE TEMP TABLE robinhood_chain_capture_cursor (
    chain text PRIMARY KEY, next_block bigint NOT NULL, checkpoint_block bigint,
    checkpoint_hash text, node_head bigint
  ) ON COMMIT PRESERVE ROWS`);
  const query = client.query.bind(client);
  database = { query, getClient: async () => ({ query, release() {} }) };
  source = createRobinhoodCanonicalHolderSource({ database, statementTimeoutMs: 2000 });
});

beforeEach(async () => {
  await client.query(`TRUNCATE robinhood_chain_events, robinhood_chain_blocks,
    robinhood_chain_capture_cursor`);
  await seedCanonicalJournal();
});

after(async () => {
  if (client) {
    await client.query('DROP TABLE IF EXISTS pg_temp.robinhood_chain_events');
    await client.query('DROP TABLE IF EXISTS pg_temp.robinhood_chain_blocks');
    await client.query('DROP TABLE IF EXISTS pg_temp.robinhood_chain_capture_cursor');
    client.release();
  }
  await db.pool.end();
});

describe('Robinhood canonical holder source PostgreSQL integration', () => {
  it('matches RPC payloads, excludes orphan/token noise and repeats idempotently', async () => {
    const input = { tokenAddress: TOKEN, fromBlock: '100', toBlock: '102' };
    const canonical = await source.readRange(input);
    const expected = await rpcReader().readRange(input);

    assert.deepEqual(canonical.transfers, expected.transfers);
    assert.deepEqual(await source.readRange(input), canonical);
    assert.deepEqual(await source.getCoverage(), {
      floorBlock: '100', frontierBlock: '102', nodeHead: '110',
    });
    assert.equal(canonical.telemetry.observedLogs, 1);
  });

  it('routes a partial retention range wholly to RPC', async () => {
    const rpcCalls = [];
    const rpc = {
      getSafeHead: async () => ({ safeHead: '102' }), matchesCheckpoint: async () => true,
      readReceiptRange: async () => ({}),
      readRange: async (input) => {
        rpcCalls.push(input);
        return { ...input, checkpoint: { number: input.toBlock, hash: BLOCK_100 }, transfers: [] };
      },
    };
    const reader = createRecentReplayReader({ canonicalReader: source, rpcReader: rpc });
    await assert.rejects(
      source.readRange({ tokenAddress: TOKEN, fromBlock: '99', toBlock: '100' }),
      (error) => error.reason === 'partial-coverage'
    );
    const routed = await reader.readRange({
      tokenAddress: TOKEN, fromBlock: '99', toBlock: '100',
    });
    assert.equal(routed.source, 'rpc');
    assert.equal(routed.routeReason, 'partial-coverage');
    assert.deepEqual(rpcCalls, [{ tokenAddress: TOKEN, fromBlock: '99', toBlock: '100' }]);
  });

  it('fails closed for malformed canonical data and a missing frontier checkpoint', async () => {
    await client.query(
      `UPDATE robinhood_chain_events SET topics=$1::jsonb
        WHERE address=$2 AND block_hash=$3`,
      [JSON.stringify([...TOPICS, topicAddress(FROM)]), TOKEN, BLOCK_101]
    );
    await assert.rejects(
      source.readRange({ tokenAddress: TOKEN, fromBlock: '100', toBlock: '102' }),
      (error) => error.code === 'holder_transfer_invalid_log'
    );

    await client.query('DELETE FROM robinhood_chain_blocks WHERE block_hash=$1', [BLOCK_102]);
    await assert.rejects(
      source.readRange({ tokenAddress: OTHER_TOKEN, fromBlock: '100', toBlock: '102' }),
      (error) => error.code === 'canonical_holder_source_gap'
        && error.reason === 'checkpoint-missing'
    );
  });
});
