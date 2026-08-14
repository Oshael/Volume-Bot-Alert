const { formatDecimal, multiply, parseDecimal, rational } = require('./evm-market-metrics');

const MONEY_PLACES = 36;
const QUALITY_PRIORITY = Object.freeze({
  exact_swap_only: 0,
  transfer_adjusted: 1,
  transferred_assumed_zero: 2,
  partial_history: 3,
  reconciliation_mismatch: 4,
  unavailable: 5,
});
const EVENT_TYPES = new Set(['buy', 'sell', 'transfer_in', 'transfer_out']);

function add(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left, right) {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function divide(left, right) {
  if (right.numerator === 0n) throw new Error('Cannot divide by zero');
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function nonNegativeDecimal(value, label) {
  const parsed = parseDecimal(value ?? '0', label);
  if (parsed.numerator < 0n) throw new Error(`${label} must be non-negative`);
  return parsed;
}

function positiveRaw(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error(`${label} must be a positive integer`);
  return BigInt(raw);
}

function nonNegativeRaw(value, label) {
  const raw = String(value ?? '0').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw);
}

function count(value, label) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

function money(value) {
  return formatDecimal(value, MONEY_PLACES);
}

function strongerQuality(current, candidate) {
  if (!(current in QUALITY_PRIORITY)) throw new Error(`Unsupported position quality: ${current}`);
  return QUALITY_PRIORITY[candidate] > QUALITY_PRIORITY[current] ? candidate : current;
}

function createWalletPosition(input = {}) {
  const quality = input.quality ?? 'exact_swap_only';
  if (!(quality in QUALITY_PRIORITY)) throw new Error(`Unsupported position quality: ${quality}`);
  const quantityRaw = nonNegativeRaw(input.quantityRaw, 'quantityRaw');
  const costBasisUsd = nonNegativeDecimal(input.costBasisUsd, 'costBasisUsd');
  if (quantityRaw === 0n && costBasisUsd.numerator !== 0n) {
    throw new Error('costBasisUsd must be zero when quantityRaw is zero');
  }
  return {
    quantityRaw: quantityRaw.toString(),
    costBasisUsd: money(costBasisUsd),
    realizedPnlUsd: money(parseDecimal(input.realizedPnlUsd ?? '0', 'realizedPnlUsd')),
    buyVolumeUsd: money(nonNegativeDecimal(input.buyVolumeUsd, 'buyVolumeUsd')),
    sellProceedsUsd: money(nonNegativeDecimal(input.sellProceedsUsd, 'sellProceedsUsd')),
    buyMcapWeightedSum: money(nonNegativeDecimal(
      input.buyMcapWeightedSum, 'buyMcapWeightedSum'
    )),
    buyMcapWeightUsd: money(nonNegativeDecimal(input.buyMcapWeightUsd, 'buyMcapWeightUsd')),
    sellMcapWeightedSum: money(nonNegativeDecimal(
      input.sellMcapWeightedSum, 'sellMcapWeightedSum'
    )),
    sellMcapWeightUsd: money(nonNegativeDecimal(
      input.sellMcapWeightUsd, 'sellMcapWeightUsd'
    )),
    buyTxCount: count(input.buyTxCount, 'buyTxCount'),
    sellTxCount: count(input.sellTxCount, 'sellTxCount'),
    zeroCostReceivedRaw: nonNegativeRaw(
      input.zeroCostReceivedRaw, 'zeroCostReceivedRaw'
    ).toString(),
    zeroCostSoldRaw: nonNegativeRaw(input.zeroCostSoldRaw, 'zeroCostSoldRaw').toString(),
    costBasisSource: input.costBasisSource ?? 'swap_only',
    quality,
  };
}

function addMcapWeight(position, prefix, volume, mcap) {
  if (mcap == null || volume.numerator === 0n) return;
  const weightedField = `${prefix}McapWeightedSum`;
  const weightField = `${prefix}McapWeightUsd`;
  position[weightedField] = money(add(
    parseDecimal(position[weightedField], weightedField), multiply(mcap, volume)
  ));
  position[weightField] = money(add(parseDecimal(position[weightField], weightField), volume));
}

function applyBuy(position, event, amount) {
  if (event.newSideTransaction != null && typeof event.newSideTransaction !== 'boolean') {
    throw new Error('newSideTransaction must be boolean');
  }
  const volume = nonNegativeDecimal(event.volumeUsd, 'buy volumeUsd');
  const mcap = event.marketCapUsd == null
    ? null : nonNegativeDecimal(event.marketCapUsd, 'buy marketCapUsd');
  position.quantityRaw = (BigInt(position.quantityRaw) + amount).toString();
  position.costBasisUsd = money(add(parseDecimal(position.costBasisUsd), volume));
  position.buyVolumeUsd = money(add(parseDecimal(position.buyVolumeUsd), volume));
  if (event.newSideTransaction !== false) position.buyTxCount += 1;
  addMcapWeight(position, 'buy', volume, mcap);
}

function applySell(position, event, amount) {
  if (event.newSideTransaction != null && typeof event.newSideTransaction !== 'boolean') {
    throw new Error('newSideTransaction must be boolean');
  }
  const proceeds = nonNegativeDecimal(event.volumeUsd, 'sell volumeUsd');
  const mcap = event.marketCapUsd == null
    ? null : nonNegativeDecimal(event.marketCapUsd, 'sell marketCapUsd');
  const oldQuantity = BigInt(position.quantityRaw);
  const covered = amount < oldQuantity ? amount : oldQuantity;
  const oldCostBasis = parseDecimal(position.costBasisUsd);
  const costBasisSold = oldQuantity === 0n
    ? rational(0n) : multiply(oldCostBasis, rational(covered, oldQuantity));
  const remainingQuantity = oldQuantity - covered;
  position.quantityRaw = remainingQuantity.toString();
  position.costBasisUsd = remainingQuantity === 0n
    ? '0' : money(subtract(oldCostBasis, costBasisSold));
  position.realizedPnlUsd = money(add(
    parseDecimal(position.realizedPnlUsd), subtract(proceeds, costBasisSold)
  ));
  position.sellProceedsUsd = money(add(parseDecimal(position.sellProceedsUsd), proceeds));
  if (event.newSideTransaction !== false) position.sellTxCount += 1;
  addMcapWeight(position, 'sell', proceeds, mcap);
  if (amount > oldQuantity) {
    position.zeroCostSoldRaw = (BigInt(position.zeroCostSoldRaw) + amount - oldQuantity).toString();
    position.costBasisSource = 'transferred_assumed_zero';
    position.quality = strongerQuality(position.quality, 'transferred_assumed_zero');
  }
}

function applyTransferIn(position, amount) {
  position.quantityRaw = (BigInt(position.quantityRaw) + amount).toString();
  position.zeroCostReceivedRaw = (BigInt(position.zeroCostReceivedRaw) + amount).toString();
  position.costBasisSource = 'transferred_assumed_zero';
  position.quality = strongerQuality(position.quality, 'transferred_assumed_zero');
}

function applyTransferOut(position, amount) {
  const oldQuantity = BigInt(position.quantityRaw);
  const covered = amount < oldQuantity ? amount : oldQuantity;
  const remainingQuantity = oldQuantity - covered;
  const oldCostBasis = parseDecimal(position.costBasisUsd);
  const movedCost = oldQuantity === 0n
    ? rational(0n) : multiply(oldCostBasis, rational(covered, oldQuantity));
  position.quantityRaw = remainingQuantity.toString();
  position.costBasisUsd = remainingQuantity === 0n
    ? '0' : money(subtract(oldCostBasis, movedCost));
  position.quality = strongerQuality(
    position.quality, amount > oldQuantity ? 'partial_history' : 'transfer_adjusted'
  );
}

function applyWalletPositionEvent(input, event = {}) {
  if (!EVENT_TYPES.has(event.type)) throw new Error(`Unsupported financial event: ${event.type}`);
  const position = createWalletPosition(input);
  const amount = positiveRaw(event.amountRaw, `${event.type} amountRaw`);
  if (event.type === 'buy') applyBuy(position, event, amount);
  if (event.type === 'sell') applySell(position, event, amount);
  if (event.type === 'transfer_in') applyTransferIn(position, amount);
  if (event.type === 'transfer_out') applyTransferOut(position, amount);
  return position;
}

function average(weightedValue, weight) {
  return weight.numerator === 0n ? '0' : money(divide(weightedValue, weight));
}

function deriveWalletPositionMetrics(input, valuation = {}) {
  const position = createWalletPosition(input);
  const balance = nonNegativeRaw(
    valuation.holderBalanceRaw ?? position.quantityRaw, 'holderBalanceRaw'
  );
  if (valuation.currentFdvUsd == null || valuation.totalSupplyRaw == null) {
    return { ...position, avgBuyMcapUsd: average(
      parseDecimal(position.buyMcapWeightedSum), parseDecimal(position.buyMcapWeightUsd)
    ), avgSellMcapUsd: average(
      parseDecimal(position.sellMcapWeightedSum), parseDecimal(position.sellMcapWeightUsd)
    ), currentValueUsd: null, unrealizedPnlUsd: null, unrealizedPnlPct: null };
  }
  const supply = positiveRaw(valuation.totalSupplyRaw, 'totalSupplyRaw');
  const fdv = nonNegativeDecimal(valuation.currentFdvUsd, 'currentFdvUsd');
  const currentValue = multiply(rational(balance, supply), fdv);
  const basis = parseDecimal(position.costBasisUsd);
  const unrealized = subtract(currentValue, basis);
  return {
    ...position,
    avgBuyMcapUsd: average(
      parseDecimal(position.buyMcapWeightedSum), parseDecimal(position.buyMcapWeightUsd)
    ),
    avgSellMcapUsd: average(
      parseDecimal(position.sellMcapWeightedSum), parseDecimal(position.sellMcapWeightUsd)
    ),
    currentValueUsd: money(currentValue),
    unrealizedPnlUsd: money(unrealized),
    unrealizedPnlPct: basis.numerator === 0n
      ? null : money(multiply(divide(unrealized, basis), rational(100n))),
  };
}

module.exports = {
  QUALITY_PRIORITY,
  applyWalletPositionEvent,
  createWalletPosition,
  deriveWalletPositionMetrics,
};
