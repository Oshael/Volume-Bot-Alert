'use strict';

const noxa = require('./noxa-launch-decoder');
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');
const { buildDiscoveryEvidence } = require('./robinhood-head-evidence');

function epochSeconds(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('canonical block timestamp is invalid');
  return String(Math.floor(milliseconds / 1000));
}

function logFromRow(row) {
  return {
    transactionHash: row.transaction_hash,
    transactionIndex: String(row.transaction_index),
    logIndex: String(row.log_index),
    blockNumber: String(row.block_number),
    blockHash: row.block_hash,
    blockTimestamp: epochSeconds(row.block_timestamp),
    address: row.address,
    topics: row.topics,
    data: row.data,
    v3BalanceSnapshot: row.v3_balance_snapshot || null,
  };
}

function decodeStandard(log) {
  if (log.address === v2.ROBINHOOD_V2_FACTORY) return v2.decodePairCreated(log);
  if (log.address === v3.ROBINHOOD_V3_FACTORY) return v3.decodePoolCreated(log);
  if (log.address === v4.ROBINHOOD_V4_POOL_MANAGER) return v4.decodeInitialize(log);
  if (log.address === noxa.NOXA_FACTORY) return null;
  throw new Error(`unsupported canonical discovery emitter ${log.address}`);
}

function captureEntry(log, event, noxaValidation = null) {
  const built = buildDiscoveryEvidence({ event, noxa: noxaValidation });
  return {
    stream: 'discovery', protocol: event.protocol ?? null,
    marketKey: event.marketKey ?? null,
    evidenceVersion: built.evidenceVersion, evidence: built.evidence, log,
  };
}

function createRobinhoodCanonicalDiscoveryCapture(deps = {}) {
  const validator = deps.noxaValidator;
  const resolveV3Pool = deps.resolveV3Pool || (async () => null);

  async function buildEntries(rows = []) {
    const decoded = rows.map((row) => {
      const log = logFromRow(row);
      return { log, event: decodeStandard(log) };
    });
    const batchV3Pools = new Map(decoded
      .filter(({ event }) => event?.protocol === 'uniswap-v3' && event.poolAddress)
      .map(({ event }) => [event.poolAddress, event]));
    const entries = [];
    for (const item of decoded) {
      if (item.event) {
        entries.push(captureEntry(item.log, item.event));
        continue;
      }
      if (typeof validator?.validateOnchain !== 'function') {
        throw new Error('NOXA validator is required for canonical discovery capture');
      }
      const launch = noxa.decodeTokenLaunched(item.log);
      const v3Pool = batchV3Pools.get(launch.poolAddress)
        || await resolveV3Pool(launch.poolAddress);
      const validation = await validator.validateOnchain(launch, {
        blockTag: item.log.blockNumber, v3Pool,
      });
      const event = validation.accepted ? {
        ...validation, protocol: 'uniswap-v3', marketKey: validation.marketDiscoveryKey,
      } : validation;
      entries.push(captureEntry(item.log, event, validation));
    }
    return entries;
  }

  return Object.freeze({ buildEntries });
}

module.exports = {
  createRobinhoodCanonicalDiscoveryCapture,
  logFromRow,
  __private: { decodeStandard, epochSeconds, logFromRow },
};
