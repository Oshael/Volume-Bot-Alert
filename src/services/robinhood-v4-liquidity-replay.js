const v4 = require('./uniswap-v4-decoder');

const CHAIN_ID = 4663n;

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function toHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function integer(value, fallback, min, max, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function createRobinhoodV4LiquidityReplay(options = {}) {
  const repository = options.repository;
  const rpcClient = options.rpcClient;
  if (typeof repository?.ensureState !== 'function' || typeof repository?.commitRange !== 'function') {
    throw new TypeError('V4 liquidity replay repository is required');
  }
  if (typeof rpcClient?.request !== 'function') throw new TypeError('V4 liquidity replay RPC is required');

  async function assertCheckpoint(state) {
    if (state.checkpointBlock == null) return;
    const block = await rpcClient.request(
      'eth_getBlockByNumber', [toHex(state.checkpointBlock), false]
    );
    if (String(block?.hash || '').toLowerCase() !== state.checkpointHash) {
      throw new Error('V4 liquidity replay checkpoint no longer matches the chain');
    }
  }

  async function run(input = {}) {
    const rangeSize = integer(input.rangeSize, 1000, 1, 10_000, 'rangeSize');
    const confirmations = integer(input.confirmations, 2, 0, 1000, 'confirmations');
    const maxRanges = integer(input.maxRanges, 100_000, 1, 1_000_000, 'maxRanges');
    const chainId = quantity(await rpcClient.request('eth_chainId'), 'eth_chainId');
    if (chainId !== CHAIN_ID) throw new Error(`Unexpected Robinhood chain id ${chainId}`);
    const head = quantity(await rpcClient.request('eth_blockNumber'), 'eth_blockNumber');
    const safeHead = head > BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
    const target = input.targetBlock == null
      ? safeHead
      : quantity(input.targetBlock, 'targetBlock');
    if (target > safeHead) throw new Error('V4 liquidity replay target exceeds the safe head');
    const context = await repository.ensureState(target.toString(), {
      restart: input.restart === true,
    });
    let state = context.state;
    if (input.targetBlock != null && BigInt(state.targetBlock) !== target) {
      throw new Error('Persisted V4 replay target differs; use --restart to reconcile from the beginning');
    }
    await assertCheckpoint(state);
    const tracker = v4.createUniswapV4Tracker({ seedPools: context.pools });
    let ranges = 0;
    let persisted = 0;
    let ignored = 0;
    while (state.status !== 'completed' && ranges < maxRanges) {
      const fromBlock = BigInt(state.nextBlock);
      const targetBlock = BigInt(state.targetBlock);
      const toBlock = fromBlock + BigInt(rangeSize - 1) < targetBlock
        ? fromBlock + BigInt(rangeSize - 1)
        : targetBlock;
      const [logs, checkpoint] = await Promise.all([
        rpcClient.request('eth_getLogs', [{
          address: v4.ROBINHOOD_V4_POOL_MANAGER,
          fromBlock: toHex(fromBlock),
          toBlock: toHex(toBlock),
          topics: [v4.TOPICS.modifyLiquidity],
        }]),
        rpcClient.request('eth_getBlockByNumber', [toHex(toBlock), false]),
      ]);
      if (!Array.isArray(logs)) throw new Error('eth_getLogs did not return an array');
      if (quantity(checkpoint?.number, 'checkpoint.number') !== toBlock) {
        throw new Error('Replay checkpoint block does not match its range');
      }
      const checkpointHash = String(checkpoint?.hash || '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(checkpointHash)) throw new Error('Replay checkpoint hash is invalid');
      const events = [];
      for (const log of logs) {
        if (log?.removed === true) throw new Error('Replay RPC returned a removed log');
        if (log?.blockTimestamp == null) throw new Error('Replay log is missing blockTimestamp');
        const logBlock = quantity(log.blockNumber, 'log.blockNumber');
        if (logBlock < fromBlock || logBlock > toBlock) {
          throw new Error('Replay RPC returned a log outside the requested range');
        }
        const event = tracker.processLog(log);
        if (event.kind === 'modify-liquidity') events.push(event);
        else if (event.kind === 'ignored' && event.reason === 'unknown_pool') ignored += 1;
        else throw new Error(`Unexpected V4 replay event: ${event.reason || event.kind}`);
      }
      const committed = await repository.commitRange({
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        checkpointHash,
        events,
      });
      state = committed.state;
      persisted += committed.persisted;
      ranges += 1;
      input.onProgress?.({ ranges, persisted, ignored, state });
    }
    return { ranges, persisted, ignored, state };
  }

  return Object.freeze({ run });
}

module.exports = { CHAIN_ID, createRobinhoodV4LiquidityReplay, __private: { quantity, toHex } };
