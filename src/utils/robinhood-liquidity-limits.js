// Keep event batching, historical reads and snapshot writes on the same bounded contract.
module.exports = Object.freeze({ POOL_LIQUIDITY_BATCH_SIZE: 100 });
