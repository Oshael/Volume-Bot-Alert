const db = require('../models/db');
const { isValidAddress } = require('../models/user-token');

const DEFAULT_STARTING_CASH_USD = 1000;
const DEFAULT_PRICE_MAX_AGE_MS = 5 * 60 * 1000;
const EPSILON = 1e-12;

class MockTradingError extends Error {
  constructor(message, code = 'mock_trading_error', statusCode = 400) {
    super(message);
    this.name = 'MockTradingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeUserId(value) {
  const userId = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new MockTradingError('Valid user id is required', 'invalid_user_id');
  }
  return userId;
}

function normalizeTokenAddress(value) {
  const address = String(value || '').trim();
  if (!isValidAddress(address)) {
    throw new MockTradingError('Invalid token address', 'invalid_token_address');
  }
  return address;
}

function normalizePositiveAmount(value, fieldName) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new MockTradingError(`${fieldName} must be greater than zero`, 'invalid_amount');
  }
  return amount;
}

function normalizeSellQuantity(position, payload = {}) {
  if (!position || !(position.quantity > 0)) {
    throw new MockTradingError('No open mock trading position', 'position_not_found', 404);
  }

  if (payload.quantity != null && String(payload.quantity).trim() !== '') {
    return normalizePositiveAmount(payload.quantity, 'quantity');
  }

  const percent = normalizePositiveAmount(payload.percent, 'percent');
  if (percent > 100) {
    throw new MockTradingError('percent must be between 0 and 100', 'invalid_percent');
  }
  return position.quantity * (percent / 100);
}

function formatNumeric(value, decimals = 12) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number.toFixed(decimals);
}

function weightedAverageNullable(leftValue, leftWeight, rightValue, rightWeight) {
  if (leftValue == null && rightValue == null) return null;
  if (leftValue == null) return rightValue;
  if (rightValue == null) return leftValue;
  const totalWeight = leftWeight + rightWeight;
  return totalWeight > 0
    ? ((leftValue * leftWeight) + (rightValue * rightWeight)) / totalWeight
    : rightValue;
}

function buildBuyState({ account, position = null, priceUsd, marketCapUsd = null, notionalUsd }) {
  if (notionalUsd > account.cashUsd + EPSILON) {
    throw new MockTradingError('Insufficient mock trading cash', 'insufficient_cash');
  }

  const quantityBought = notionalUsd / priceUsd;
  const oldQuantity = position?.quantity || 0;
  const oldCostBasis = position?.costBasisUsd || 0;
  const newQuantity = oldQuantity + quantityBought;
  const newCostBasis = oldCostBasis + notionalUsd;
  const avgEntryPriceUsd = newCostBasis / newQuantity;
  const avgEntryMcapUsd = weightedAverageNullable(
    position?.avgEntryMcapUsd ?? null,
    oldCostBasis,
    marketCapUsd,
    notionalUsd
  );

  return {
    account: {
      ...account,
      cashUsd: account.cashUsd - notionalUsd,
    },
    position: {
      quantity: newQuantity,
      avgEntryPriceUsd,
      avgEntryMcapUsd,
      costBasisUsd: newCostBasis,
      realizedPnlUsd: position?.realizedPnlUsd || 0,
    },
    trade: {
      side: 'buy',
      quantity: quantityBought,
      priceUsd,
      marketCapUsd,
      notionalUsd,
      realizedPnlUsd: 0,
      realizedPnlPct: null,
      priceReturnPct: position ? ((priceUsd / position.avgEntryPriceUsd) - 1) * 100 : null,
      priceMultiple: position ? priceUsd / position.avgEntryPriceUsd : null,
      mcapMultiple: position?.avgEntryMcapUsd && marketCapUsd ? marketCapUsd / position.avgEntryMcapUsd : null,
    },
  };
}

function buildSellState({ account, position, priceUsd, marketCapUsd = null, quantity }) {
  if (!position || !(position.quantity > 0)) {
    throw new MockTradingError('No open mock trading position', 'position_not_found', 404);
  }
  if (quantity > position.quantity + EPSILON) {
    throw new MockTradingError('Sell quantity exceeds open position', 'insufficient_position');
  }

  const sellQuantity = Math.min(quantity, position.quantity);
  const closeRatio = sellQuantity / position.quantity;
  const notionalUsd = sellQuantity * priceUsd;
  const costBasisSold = position.costBasisUsd * closeRatio;
  const realizedPnlUsd = notionalUsd - costBasisSold;
  const remainingQuantity = position.quantity - sellQuantity;
  const remainingCostBasis = position.costBasisUsd - costBasisSold;
  const priceMultiple = priceUsd / position.avgEntryPriceUsd;
  const mcapMultiple = position.avgEntryMcapUsd && marketCapUsd ? marketCapUsd / position.avgEntryMcapUsd : null;

  return {
    account: {
      ...account,
      cashUsd: account.cashUsd + notionalUsd,
      realizedPnlUsd: account.realizedPnlUsd + realizedPnlUsd,
    },
    position: remainingQuantity <= EPSILON ? null : {
      quantity: remainingQuantity,
      avgEntryPriceUsd: remainingCostBasis / remainingQuantity,
      avgEntryMcapUsd: position.avgEntryMcapUsd,
      costBasisUsd: remainingCostBasis,
      realizedPnlUsd: position.realizedPnlUsd + realizedPnlUsd,
    },
    trade: {
      side: 'sell',
      quantity: sellQuantity,
      priceUsd,
      marketCapUsd,
      notionalUsd,
      realizedPnlUsd,
      realizedPnlPct: costBasisSold > 0 ? (realizedPnlUsd / costBasisSold) * 100 : null,
      priceReturnPct: (priceMultiple - 1) * 100,
      priceMultiple,
      mcapMultiple,
    },
  };
}

function mapAccount(row) {
  if (!row) return null;
  return {
    userId: Number(row.user_id),
    startingCashUsd: toFiniteNumber(row.starting_cash_usd, 0),
    cashUsd: toFiniteNumber(row.cash_usd, 0),
    realizedPnlUsd: toFiniteNumber(row.realized_pnl_usd, 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapPosition(row) {
  if (!row) return null;
  return {
    userId: Number(row.user_id),
    tokenAddress: row.token_address,
    quantity: toFiniteNumber(row.quantity, 0),
    avgEntryPriceUsd: toFiniteNumber(row.avg_entry_price_usd, 0),
    avgEntryMcapUsd: toFiniteNumber(row.avg_entry_mcap_usd, null),
    costBasisUsd: toFiniteNumber(row.cost_basis_usd, 0),
    realizedPnlUsd: toFiniteNumber(row.realized_pnl_usd, 0),
    openedAt: row.opened_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapCatalogPrice(row, now = new Date(), maxAgeMs = DEFAULT_PRICE_MAX_AGE_MS) {
  if (!row) {
    throw new MockTradingError('Token is not available in catalog', 'token_not_found', 404);
  }
  const priceUsd = toFiniteNumber(row.last_price, null);
  if (!(priceUsd > 0)) {
    throw new MockTradingError('Token does not have a valid priceUsd', 'price_unavailable');
  }

  const freshnessSource = row.last_evaluated_at || row.last_seen_at;
  const freshnessMs = Date.parse(String(freshnessSource || ''));
  if (!Number.isFinite(freshnessMs) || now.getTime() - freshnessMs > maxAgeMs) {
    throw new MockTradingError('Token price is stale', 'price_stale');
  }

  return {
    priceUsd,
    marketCapUsd: toFiniteNumber(row.last_mcap, null),
    symbol: row.symbol || null,
    name: row.name || null,
    pairAddress: row.last_pair_address || null,
    lastSeenAt: row.last_seen_at || null,
    lastEvaluatedAt: row.last_evaluated_at || null,
  };
}

function mapTrade(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tokenAddress: row.token_address,
    side: row.side,
    quantity: toFiniteNumber(row.quantity, 0),
    priceUsd: toFiniteNumber(row.price_usd, 0),
    marketCapUsd: toFiniteNumber(row.market_cap_usd, null),
    notionalUsd: toFiniteNumber(row.notional_usd, 0),
    realizedPnlUsd: toFiniteNumber(row.realized_pnl_usd, 0),
    realizedPnlPct: toFiniteNumber(row.realized_pnl_pct, null),
    priceReturnPct: toFiniteNumber(row.price_return_pct, null),
    priceMultiple: toFiniteNumber(row.price_multiple, null),
    mcapMultiple: toFiniteNumber(row.mcap_multiple, null),
    source: row.source || 'token_catalog',
    executedAt: row.executed_at || null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
  };
}

function buildPositionView(position, catalog = {}) {
  const currentPriceUsd = toFiniteNumber(catalog.last_price, null);
  const currentMcapUsd = toFiniteNumber(catalog.last_mcap, null);
  const currentValueUsd = currentPriceUsd == null ? null : position.quantity * currentPriceUsd;
  const unrealizedPnlUsd = currentValueUsd == null ? null : currentValueUsd - position.costBasisUsd;
  const unrealizedPnlPct = unrealizedPnlUsd == null || position.costBasisUsd <= 0
    ? null
    : (unrealizedPnlUsd / position.costBasisUsd) * 100;
  const priceMultiple = currentPriceUsd == null || position.avgEntryPriceUsd <= 0
    ? null
    : currentPriceUsd / position.avgEntryPriceUsd;
  const mcapMultiple = currentMcapUsd == null || !(position.avgEntryMcapUsd > 0)
    ? null
    : currentMcapUsd / position.avgEntryMcapUsd;

  return {
    ...position,
    symbol: catalog.symbol || null,
    name: catalog.name || null,
    currentPriceUsd,
    currentMcapUsd,
    currentValueUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct,
    priceReturnPct: priceMultiple == null ? null : (priceMultiple - 1) * 100,
    priceMultiple,
    mcapMultiple,
  };
}

async function withTransaction(task) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

async function ensureAccount(userId, runner, { lock = false, startingCashUsd = DEFAULT_STARTING_CASH_USD } = {}) {
  await runner.query(
    `INSERT INTO mock_trading_accounts (user_id, starting_cash_usd, cash_usd)
     VALUES ($1, $2, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, formatNumeric(startingCashUsd, 6)]
  );
  const { rows } = await runner.query(
    `SELECT *
     FROM mock_trading_accounts
     WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [userId]
  );
  return mapAccount(rows[0]);
}

async function loadFreshCatalogPrice(address, runner, options = {}) {
  const { rows } = await runner.query(
    `SELECT address, symbol, name, last_price, last_mcap, last_pair_address, last_seen_at, last_evaluated_at
     FROM token_catalog
     WHERE address = $1`,
    [address]
  );
  return mapCatalogPrice(rows[0], options.now || new Date(), options.maxAgeMs || DEFAULT_PRICE_MAX_AGE_MS);
}

async function loadPositionForUpdate(userId, address, runner) {
  const { rows } = await runner.query(
    `SELECT *
     FROM mock_trading_positions
     WHERE user_id = $1 AND token_address = $2
     FOR UPDATE`,
    [userId, address]
  );
  return mapPosition(rows[0]);
}

async function saveAccount(account, runner) {
  await runner.query(
    `UPDATE mock_trading_accounts
     SET cash_usd = $2,
         realized_pnl_usd = $3,
         updated_at = NOW()
     WHERE user_id = $1`,
    [account.userId, formatNumeric(account.cashUsd, 6), formatNumeric(account.realizedPnlUsd, 6)]
  );
}

async function savePosition(userId, address, position, runner) {
  if (!position) {
    await runner.query('DELETE FROM mock_trading_positions WHERE user_id = $1 AND token_address = $2', [userId, address]);
    return;
  }

  await runner.query(
    `INSERT INTO mock_trading_positions (
       user_id, token_address, quantity, avg_entry_price_usd, avg_entry_mcap_usd, cost_basis_usd, realized_pnl_usd
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, token_address) DO UPDATE SET
       quantity = EXCLUDED.quantity,
       avg_entry_price_usd = EXCLUDED.avg_entry_price_usd,
       avg_entry_mcap_usd = EXCLUDED.avg_entry_mcap_usd,
       cost_basis_usd = EXCLUDED.cost_basis_usd,
       realized_pnl_usd = EXCLUDED.realized_pnl_usd,
       updated_at = NOW()`,
    [
      userId,
      address,
      formatNumeric(position.quantity, 18),
      formatNumeric(position.avgEntryPriceUsd, 12),
      formatNumeric(position.avgEntryMcapUsd, 2),
      formatNumeric(position.costBasisUsd, 6),
      formatNumeric(position.realizedPnlUsd, 6),
    ]
  );
}

async function insertTrade(userId, address, trade, runner) {
  const { rows } = await runner.query(
    `INSERT INTO mock_trading_trades (
       user_id, token_address, side, quantity, price_usd, market_cap_usd, notional_usd,
       realized_pnl_usd, realized_pnl_pct, price_return_pct, price_multiple, mcap_multiple
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      userId,
      address,
      trade.side,
      formatNumeric(trade.quantity, 18),
      formatNumeric(trade.priceUsd, 12),
      formatNumeric(trade.marketCapUsd, 2),
      formatNumeric(trade.notionalUsd, 6),
      formatNumeric(trade.realizedPnlUsd, 6),
      formatNumeric(trade.realizedPnlPct, 8),
      formatNumeric(trade.priceReturnPct, 8),
      formatNumeric(trade.priceMultiple, 8),
      formatNumeric(trade.mcapMultiple, 8),
    ]
  );
  return mapTrade(rows[0]);
}

async function buyToken(payload = {}, options = {}) {
  const userId = normalizeUserId(payload.userId);
  const address = normalizeTokenAddress(payload.address);
  const notionalUsd = normalizePositiveAmount(payload.notionalUsd, 'notionalUsd');

  return withTransaction(async (client) => {
    const account = await ensureAccount(userId, client, { lock: true, startingCashUsd: options.startingCashUsd });
    const catalog = await loadFreshCatalogPrice(address, client, options);
    const position = await loadPositionForUpdate(userId, address, client);
    const next = buildBuyState({ account, position, priceUsd: catalog.priceUsd, marketCapUsd: catalog.marketCapUsd, notionalUsd });

    await saveAccount(next.account, client);
    await savePosition(userId, address, next.position, client);
    const trade = await insertTrade(userId, address, next.trade, client);
    return { account: next.account, position: next.position, trade, catalog };
  });
}

async function sellToken(payload = {}, options = {}) {
  const userId = normalizeUserId(payload.userId);
  const address = normalizeTokenAddress(payload.address);

  return withTransaction(async (client) => {
    const account = await ensureAccount(userId, client, { lock: true, startingCashUsd: options.startingCashUsd });
    const position = await loadPositionForUpdate(userId, address, client);
    const quantity = normalizeSellQuantity(position, payload);
    const catalog = await loadFreshCatalogPrice(address, client, options);
    const next = buildSellState({ account, position, priceUsd: catalog.priceUsd, marketCapUsd: catalog.marketCapUsd, quantity });

    await saveAccount(next.account, client);
    await savePosition(userId, address, next.position, client);
    const trade = await insertTrade(userId, address, next.trade, client);
    return { account: next.account, position: next.position, trade, catalog };
  });
}

async function resetAccount(payload = {}) {
  const userId = normalizeUserId(payload.userId);
  const startingCashUsd = normalizePositiveAmount(payload.startingCashUsd ?? DEFAULT_STARTING_CASH_USD, 'startingCashUsd');

  return withTransaction(async (client) => {
    await client.query('DELETE FROM mock_trading_trades WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM mock_trading_positions WHERE user_id = $1', [userId]);
    const { rows } = await client.query(
      `INSERT INTO mock_trading_accounts (user_id, starting_cash_usd, cash_usd, realized_pnl_usd)
       VALUES ($1, $2, $2, 0)
       ON CONFLICT (user_id) DO UPDATE SET
         starting_cash_usd = EXCLUDED.starting_cash_usd,
         cash_usd = EXCLUDED.cash_usd,
         realized_pnl_usd = 0,
         updated_at = NOW()
       RETURNING *`,
      [userId, formatNumeric(startingCashUsd, 6)]
    );
    return mapAccount(rows[0]);
  });
}

async function listPositions(userIdValue, runner = db) {
  const userId = normalizeUserId(userIdValue);
  const { rows } = await runner.query(
    `SELECT p.*, tc.symbol, tc.name, tc.last_price, tc.last_mcap
     FROM mock_trading_positions p
     LEFT JOIN token_catalog tc ON tc.address = p.token_address
     WHERE p.user_id = $1
     ORDER BY p.updated_at DESC`,
    [userId]
  );
  return rows.map((row) => buildPositionView(mapPosition(row), row));
}

async function getSummary(userIdValue, runner = db) {
  const userId = normalizeUserId(userIdValue);
  const account = await ensureAccount(userId, runner);
  const positions = await listPositions(userId, runner);
  const openPositionValueUsd = positions.reduce((sum, position) => sum + (position.currentValueUsd || 0), 0);
  const totalEquityUsd = account.cashUsd + openPositionValueUsd;
  const totalPnlUsd = totalEquityUsd - account.startingCashUsd;
  return {
    account,
    openPositionCount: positions.length,
    openPositionValueUsd,
    totalEquityUsd,
    totalPnlUsd,
    totalPnlPct: account.startingCashUsd > 0 ? (totalPnlUsd / account.startingCashUsd) * 100 : null,
    generatedAt: new Date().toISOString(),
  };
}

async function listTrades(filters = {}, runner = db) {
  const userId = normalizeUserId(filters.userId);
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  const values = [userId, limit];
  const clauses = ['user_id = $1'];
  if (filters.address != null && String(filters.address).trim() !== '') {
    values.push(normalizeTokenAddress(filters.address));
    clauses.push(`token_address = $${values.length}`);
  }
  const { rows } = await runner.query(
    `SELECT *
     FROM mock_trading_trades
     WHERE ${clauses.join(' AND ')}
     ORDER BY executed_at DESC, id DESC
     LIMIT $2`,
    values
  );
  return rows.map(mapTrade);
}

module.exports = {
  DEFAULT_PRICE_MAX_AGE_MS,
  DEFAULT_STARTING_CASH_USD,
  MockTradingError,
  buyToken,
  formatNumeric,
  getSummary,
  listPositions,
  listTrades,
  mapAccount,
  mapPosition,
  normalizePositiveAmount,
  normalizeTokenAddress,
  normalizeUserId,
  resetAccount,
  sellToken,
  __private: {
    buildBuyState,
    buildSellState,
    mapCatalogPrice,
    normalizeSellQuantity,
  },
};
