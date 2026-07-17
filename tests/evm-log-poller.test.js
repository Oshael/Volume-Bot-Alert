const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { EvmRpcError } = require('../src/services/evm-json-rpc-client');
const {
  createEvmLogPoller,
  logIdentity,
  parseQuantity,
  toQuantity,
} = require('../src/services/evm-log-poller');

function rpcLog(blockNumber, suffix = '1', overrides = {}) {
  return {
    address: '0x0000000000000000000000000000000000000001',
    blockNumber: toQuantity(blockNumber),
    blockHash: `0xblock${suffix}`,
    transactionHash: `0xtx${suffix}`,
    logIndex: '0x0',
    topics: ['0xtopic'],
    data: '0x',
    removed: false,
    ...overrides,
  };
}

function blockFromParams(params, hashPrefix = 'hash') {
  return { hash: `0x${hashPrefix}${parseQuantity(params[0]).toString()}` };
}

describe('EVM log poller', () => {
  it('drains every block in contiguous bounded ranges and reports backfill lag', async () => {
    const requestedRanges = [];
    const client = {
      request: async (method, params) => {
        if (method === 'eth_blockNumber') return '0x69';
        if (method === 'eth_getLogs') {
          requestedRanges.push([params[0].fromBlock, params[0].toBlock]);
          return [];
        }
        if (method === 'eth_getBlockByNumber') return blockFromParams(params);
        throw new Error(`Unexpected method ${method}`);
      },
    };
    const poller = createEvmLogPoller({
      client,
      startBlock: 100,
      confirmations: 0,
      rangeSize: 2,
      minRangeSize: 2,
      maxRangeSize: 2,
    });

    const status = await poller.pollOnce();

    assert.deepEqual(requestedRanges, [
      ['0x64', '0x65'],
      ['0x66', '0x67'],
      ['0x68', '0x69'],
    ]);
    assert.equal(status.nextBlock, '106');
    assert.equal(status.polling, false);
    assert.equal(status.lagBlocks, 0);
    assert.equal(status.metrics.blocksProcessed, 6);
    assert.equal(status.metrics.backfillBlocks, 4);
  });

  it('advances the cursor only after the consumer accepts logs', async () => {
    const log = rpcLog(100);
    let shouldFail = true;
    const client = {
      request: async (method, params) => {
        if (method === 'eth_blockNumber') return '0x64';
        if (method === 'eth_getLogs') return [log];
        if (method === 'eth_getBlockByNumber') return blockFromParams(params);
        throw new Error(`Unexpected method ${method}`);
      },
    };
    const accepted = [];
    const poller = createEvmLogPoller({
      client,
      startBlock: 100,
      confirmations: 0,
      onLogs: async (logs) => {
        if (shouldFail) throw new Error('consumer unavailable');
        accepted.push(...logs);
      },
    });

    await assert.rejects(poller.pollOnce(), /consumer unavailable/);
    assert.equal(poller.getStatus().nextBlock, '100');
    assert.equal(poller.getStatus().seenLogs, 0);

    shouldFail = false;
    const status = await poller.pollOnce();
    assert.equal(accepted.length, 1);
    assert.equal(status.nextBlock, '101');
    assert.equal(status.metrics.logsAccepted, 1);
  });

  it('commits empty ranges before advancing and retries when the range commit fails', async () => {
    let shouldFail = true;
    const committed = [];
    const poller = createEvmLogPoller({
      client: {
        request: async (method, params) => {
          if (method === 'eth_blockNumber') return '0x64';
          if (method === 'eth_getLogs') return [];
          if (method === 'eth_getBlockByNumber') return blockFromParams(params);
          throw new Error(`Unexpected method ${method}`);
        },
      },
      startBlock: 100,
      confirmations: 0,
      onRange: async (range) => {
        if (shouldFail) throw new Error('cursor store unavailable');
        committed.push(range);
      },
    });

    await assert.rejects(poller.pollOnce(), /cursor store unavailable/);
    assert.equal(poller.getStatus().nextBlock, '100');
    shouldFail = false;
    assert.equal((await poller.pollOnce()).nextBlock, '101');
    assert.equal(committed[0].logs.length, 0);
    assert.equal(committed[0].nextBlock, '101');
    assert.equal(committed[0].checkpoint.number, '100');
  });

  it('deduplicates repeated log identities within a fetched range', async () => {
    const log = rpcLog(50);
    const batches = [];
    const poller = createEvmLogPoller({
      client: {
        request: async (method, params) => {
          if (method === 'eth_blockNumber') return '0x32';
          if (method === 'eth_getLogs') return [log, { ...log }];
          if (method === 'eth_getBlockByNumber') return blockFromParams(params);
          throw new Error(`Unexpected method ${method}`);
        },
      },
      startBlock: 50,
      confirmations: 0,
      onLogs: async (logs) => batches.push(logs),
    });

    const status = await poller.pollOnce();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 1);
    assert.equal(status.metrics.logsReceived, 2);
    assert.equal(status.metrics.logsAccepted, 1);
    assert.equal(status.metrics.logsDuplicate, 1);
    assert.match(logIdentity(log), /^0xblock1:0xtx1:0x0$/);
  });

  it('shrinks an rejected eth_getLogs range and retries without skipping a block', async () => {
    const requestedRanges = [];
    let rejected = false;
    const poller = createEvmLogPoller({
      client: {
        request: async (method, params) => {
          if (method === 'eth_blockNumber') return '0x6b';
          if (method === 'eth_getLogs') {
            requestedRanges.push([params[0].fromBlock, params[0].toBlock]);
            if (!rejected) {
              rejected = true;
              throw new EvmRpcError('range rejected', {
                code: 'http_error', httpStatus: 400, method, provider: 'alchemy-free',
              });
            }
            return [];
          }
          if (method === 'eth_getBlockByNumber') return blockFromParams(params);
          throw new Error(`Unexpected method ${method}`);
        },
      },
      startBlock: 100,
      confirmations: 0,
      rangeSize: 8,
      minRangeSize: 2,
      maxRangeSize: 8,
      growAfterSuccesses: 100,
    });

    const status = await poller.pollOnce();
    assert.deepEqual(requestedRanges, [
      ['0x64', '0x6b'],
      ['0x64', '0x67'],
      ['0x68', '0x6b'],
    ]);
    assert.equal(status.nextBlock, '108');
    assert.equal(status.rangeSize, 4);
    assert.equal(status.metrics.rangeShrinks, 1);
  });

  it('recovers a dense range after adaptive shrink when success recovery is enabled', async () => {
    const requestedRanges = [];
    let shouldRateLimit = true;
    const poller = createEvmLogPoller({
      client: {
        request: async (method, params) => {
          if (method === 'eth_blockNumber') return '0x73';
          if (method === 'eth_getLogs') {
            requestedRanges.push([params[0].fromBlock, params[0].toBlock]);
            if (shouldRateLimit) {
              shouldRateLimit = false;
              throw new EvmRpcError('limited', { code: 'rate_limited', method });
            }
            const blockNumber = parseQuantity(params[0].fromBlock);
            return Array.from({ length: 11 }, (_, index) => (
              rpcLog(blockNumber, `${requestedRanges.length}-${index}`, { logIndex: toQuantity(index) })
            ));
          }
          if (method === 'eth_getBlockByNumber') return blockFromParams(params);
          throw new Error(`Unexpected method ${method}`);
        },
      },
      startBlock: 100,
      confirmations: 0,
      rangeSize: 8,
      minRangeSize: 2,
      maxRangeSize: 8,
      maxRangesPerPoll: 3,
      growAfterSuccesses: 2,
      recoverRangeOnSuccess: true,
    });

    const status = await poller.pollOnce();

    assert.deepEqual(requestedRanges, [
      ['0x64', '0x6b'],
      ['0x64', '0x67'],
      ['0x68', '0x6b'],
      ['0x6c', '0x73'],
    ]);
    assert.equal(status.nextBlock, '116');
    assert.equal(status.rangeSize, 8);
    assert.equal(status.metrics.rangeShrinks, 1);
    assert.equal(status.metrics.rangeGrows, 1);
  });

  it('detects a checkpoint hash change, undoes affected logs, and replays the overlap', async () => {
    let poll = 0;
    let checkpointReads = 0;
    let logReads = 0;
    const oldLog = rpcLog(100, 'old');
    const replacement = rpcLog(100, 'new');
    const accepted = [];
    const removed = [];
    const client = {
      request: async (method, params) => {
        if (method === 'eth_blockNumber') {
          poll += 1;
          return poll === 1 ? '0x65' : '0x67';
        }
        if (method === 'eth_getLogs') {
          logReads += 1;
          return [logReads === 1 ? oldLog : replacement];
        }
        if (method === 'eth_getBlockByNumber') {
          checkpointReads += 1;
          return { hash: checkpointReads === 1 ? '0xoldcheckpoint' : '0xnewcheckpoint' };
        }
        throw new Error(`Unexpected method ${method} ${params}`);
      },
    };
    const poller = createEvmLogPoller({
      client,
      startBlock: 100,
      confirmations: 0,
      rangeSize: 2,
      minRangeSize: 2,
      maxRangeSize: 2,
      maxRangesPerPoll: 1,
      reorgDepth: 2,
      onLogs: async (logs) => accepted.push(logs.map((log) => log.transactionHash)),
      onRemoved: async (logs, context) => removed.push({ logs, context }),
    });

    assert.equal((await poller.pollOnce()).nextBlock, '102');
    const status = await poller.pollOnce();

    assert.deepEqual(accepted, [['0xtxold'], ['0xtxnew']]);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].logs[0].removed, true);
    assert.equal(removed[0].context.reason, 'checkpoint_hash_changed');
    assert.equal(removed[0].context.rewindBlock, '100');
    assert.equal(status.nextBlock, '102');
    assert.equal(status.metrics.reorgs, 1);
    assert.equal(status.metrics.logsRemoved, 1);
  });

  it('rewinds when the safe head regresses below the last checkpoint', async () => {
    let poll = 0;
    const removed = [];
    const oldLog = rpcLog(100, 'old');
    const poller = createEvmLogPoller({
      client: {
        request: async (method, params) => {
          if (method === 'eth_blockNumber') return ++poll === 1 ? '0x65' : '0x63';
          if (method === 'eth_getLogs') return poll === 1 ? [oldLog] : [];
          if (method === 'eth_getBlockByNumber') return blockFromParams(params, 'stable');
          throw new Error(`Unexpected method ${method}`);
        },
      },
      startBlock: 100,
      confirmations: 0,
      rangeSize: 2,
      minRangeSize: 2,
      maxRangeSize: 2,
      maxRangesPerPoll: 1,
      reorgDepth: 2,
      onRemoved: async (logs, context) => removed.push({ logs, context }),
    });

    assert.equal((await poller.pollOnce()).nextBlock, '102');
    const status = await poller.pollOnce();
    assert.equal(status.safeHead, '99');
    assert.equal(status.nextBlock, '100');
    assert.equal(status.metrics.reorgs, 1);
    assert.equal(removed[0].context.rewindBlock, '98');
    assert.equal(removed[0].context.reason, 'safe_head_regressed');
  });

  it('backs off idle head polling and keeps quantities exact', async () => {
    const client = {
      request: async (method, params) => {
        if (method === 'eth_blockNumber') return '0xa';
        if (method === 'eth_getLogs') return [];
        if (method === 'eth_getBlockByNumber') return blockFromParams(params);
        throw new Error(`Unexpected method ${method}`);
      },
    };
    const poller = createEvmLogPoller({ client, startBlock: 10, confirmations: 0, pollIntervalMs: 100 });

    assert.equal((await poller.pollOnce()).nextPollMs, 100);
    assert.equal((await poller.pollOnce()).nextPollMs, 200);
    assert.equal(parseQuantity('0x20000000000001'), 9007199254740993n);
    assert.equal(toQuantity(9007199254740993n), '0x20000000000001');
  });

  it('shards large address filters while committing one logical range', async () => {
    const addresses = Array.from(
      { length: 5 },
      (_, index) => `0x${String(index + 1).padStart(40, '0')}`
    );
    const filters = [];
    const consumed = [];
    const poller = createEvmLogPoller({
      client: {
        request: async (method, params) => {
          if (method === 'eth_blockNumber') return '0x64';
          if (method === 'eth_getLogs') {
            filters.push(params[0]);
            return [rpcLog(100, String(filters.length))];
          }
          if (method === 'eth_getBlockByNumber') return blockFromParams(params);
          throw new Error(`Unexpected method ${method}`);
        },
      },
      startBlock: 100,
      confirmations: 0,
      rangeSize: 1,
      minRangeSize: 1,
      maxRangeSize: 1,
      maxAddressesPerRequest: 2,
      filter: { address: addresses, topics: ['0xtopic'] },
      onLogs: async (logs) => consumed.push(...logs),
    });

    const status = await poller.pollOnce();

    assert.deepEqual(filters.map((filter) => filter.address), [
      addresses.slice(0, 2),
      addresses.slice(2, 4),
      addresses.slice(4),
    ]);
    assert.equal(filters.every((filter) => filter.fromBlock === '0x64'), true);
    assert.equal(filters.every((filter) => filter.toBlock === '0x64'), true);
    assert.equal(consumed.length, 3);
    assert.equal(status.nextBlock, '101');
    assert.equal(status.metrics.ranges, 1);
    assert.equal(status.metrics.logRequests, 3);
    assert.equal(status.metrics.addressShardedRanges, 1);
  });

  it('does not advance the range when any address shard fails', async () => {
    const addresses = Array.from(
      { length: 3 },
      (_, index) => `0x${String(index + 1).padStart(40, '0')}`
    );
    let requests = 0;
    let commits = 0;
    const poller = createEvmLogPoller({
      client: {
        request: async (method, params) => {
          if (method === 'eth_blockNumber') return '0x64';
          if (method === 'eth_getLogs') {
            requests += 1;
            if (requests === 2) throw new Error('second shard unavailable');
            return [rpcLog(100, 'first')];
          }
          if (method === 'eth_getBlockByNumber') return blockFromParams(params);
          throw new Error(`Unexpected method ${method}`);
        },
      },
      startBlock: 100,
      confirmations: 0,
      rangeSize: 1,
      minRangeSize: 1,
      maxRangeSize: 1,
      maxAddressesPerRequest: 2,
      filter: { address: addresses, topics: ['0xtopic'] },
      onRange: async () => { commits += 1; },
    });

    await assert.rejects(poller.pollOnce(), /second shard unavailable/);

    const status = poller.getStatus();
    assert.equal(status.nextBlock, '100');
    assert.equal(status.metrics.ranges, 0);
    assert.equal(status.metrics.logRequests, 2);
    assert.equal(commits, 0);
  });

  it('resolves dynamic filters before each range without changing cursor coverage', async () => {
    const filters = [];
    let activeAddress = '0x0000000000000000000000000000000000000001';
    const poller = createEvmLogPoller({
      client: {
        request: async (method, params) => {
          if (method === 'eth_blockNumber') return '0x67';
          if (method === 'eth_getLogs') {
            filters.push(params[0]);
            activeAddress = '0x0000000000000000000000000000000000000002';
            return [];
          }
          if (method === 'eth_getBlockByNumber') return blockFromParams(params);
          throw new Error(`Unexpected method ${method}`);
        },
      },
      startBlock: 100,
      confirmations: 0,
      rangeSize: 2,
      minRangeSize: 2,
      maxRangeSize: 2,
      filter: { topics: ['0xtopic'], fromBlock: '0x0' },
      getFilter: () => ({ address: [activeAddress], toBlock: 'latest' }),
    });

    const status = await poller.pollOnce();
    assert.deepEqual(filters, [
      { topics: ['0xtopic'], address: ['0x0000000000000000000000000000000000000001'], fromBlock: '0x64', toBlock: '0x65' },
      { topics: ['0xtopic'], address: ['0x0000000000000000000000000000000000000002'], fromBlock: '0x66', toBlock: '0x67' },
    ]);
    assert.equal(status.nextBlock, '104');
    assert.throws(() => createEvmLogPoller({ client: { request() {} }, getFilter: true }), /must be a function/);
  });
});
