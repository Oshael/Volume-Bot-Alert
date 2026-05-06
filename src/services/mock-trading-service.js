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

function normalizeOptionalPositiveAmount(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  return normalizePositiveAmount(value, fieldName);
}

function normalizePercent(value, fieldName = 'percent') {
  const percent = normalizePositiveAmount(value, fieldName);
  if (percent > 100) {
    throw new MockTradingError(`${fieldName} must be between 0 and 100`, 'invalid_percent');
  }
  return percent;
}

function normalizeSellQuantity(position, payload = {}) {
  if (!position || !(position.quantity > 0)) {
    throw new MockTradingError('No open mock trading position', 'position_not_found', 404);
  }

  if (payload.quantity != null && String(payload.quantity).trim() !== '') {
    return normalizePositiveAmount(payload.quantity, 'quantity');
  }

  const percent = normalizePercent(payload.percent, 'percent');
  return position.quantity * (percent / 100);
}

function normalizeTakeProfitInput(payload = {}, catalog = {}) {
  const targetMcapUsd = normalizeOptionalPositiveAmount(payload.takeProfitMcapUsd, 'takeProfitMcapUsd');
  if (targetMcapUsd == null) {
    return null;
  }

  const currentMcapUsd = toFiniteNumber(catalog.marketCapUsd, null);
  if (!(currentMcapUsd > 0)) {
    throw new MockTradingError('Token does not have a valid market cap for take profit', 'mcap_unavailable');
  }
  if (targetMcapUsd <= currentMcapUsd) {
    throw new MockTradingError('takeProfitMcapUsd must be above the current market cap', 'invalid_take_profit_target');
  }

  return {
    targetMcapUsd,
    sellPercent: payload.takeProfitSellPercent == null || String(payload.takeProfitSellPercent).trim() === ''
      ? 100
      : normalizePercent(payload.takeProfitSellPercent, 'takeProfitSellPercent'),
  };
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
    imageUrl: row.last_image_url || null,
    pairAddress: row.last_pair_address || null,
    lastSeenAt: row.last_seen_at || null,
    lastEvaluatedAt: row.last_evaluated_at || null,
  };
}

function mapTrade(row) {
  if (!row) return null;
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tokenAddress: row.token_address,
    symbol: row.trade_symbol || metadata.symbol || null,
    name: row.trade_name || metadata.name || null,
    imageUrl: row.trade_image_url || metadata.imageUrl || null,
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
    metadata,
  };
}

function mapTakeProfitOrder(row, prefix = '') {
  if (!row || row[`${prefix}id`] == null) return null;
  return {
    id: Number(row[`${prefix}id`]),
    userId: Number(row[`${prefix}user_id`]),
    tokenAddress: row[`${prefix}token_address`],
    targetMcapUsd: toFiniteNumber(row[`${prefix}target_mcap_usd`], 0),
    sellPercent: toFiniteNumber(row[`${prefix}sell_percent`], 100),
    status: row[`${prefix}status`] || 'open',
    triggeredTradeId: row[`${prefix}triggered_trade_id`] == null ? null : Number(row[`${prefix}triggered_trade_id`]),
    createdAt: row[`${prefix}created_at`] || null,
    updatedAt: row[`${prefix}updated_at`] || null,
    triggeredAt: row[`${prefix}triggered_at`] || null,
    cancelledAt: row[`${prefix}cancelled_at`] || null,
    metadata: row[`${prefix}metadata`] && typeof row[`${prefix}metadata`] === 'object' ? row[`${prefix}metadata`] : {},
  };
}

function mapTakeProfitOrders(rows) {
  return Array.isArray(rows)
    ? rows.map((row) => mapTakeProfitOrder(row)).filter(Boolean)
    : [];
}

function buildPositionView(position, catalog = {}, takeProfitOrders = []) {
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
    takeProfitOrder: takeProfitOrders[0] || null,
    takeProfitOrders,
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
    `SELECT address, symbol, name, last_image_url, last_price, last_mcap, last_pair_address, last_seen_at, last_evaluated_at
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

async function createTakeProfitOrder(userId, address, takeProfitOrder, runner) {
  if (!takeProfitOrder) {
    return null;
  }

  const { rows } = await runner.query(
    `INSERT INTO mock_trading_take_profit_orders (
       user_id, token_address, target_mcap_usd, sell_percent
     )
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      userId,
      address,
      formatNumeric(takeProfitOrder.targetMcapUsd, 2),
      formatNumeric(takeProfitOrder.sellPercent, 4),
    ]
  );
  return mapTakeProfitOrder(rows[0]);
}

async function listOpenTakeProfitOrdersForPosition(userId, address, runner) {
  const { rows } = await runner.query(
    `SELECT *
     FROM mock_trading_take_profit_orders
     WHERE user_id = $1
       AND token_address = $2
       AND status = 'open'
     ORDER BY target_mcap_usd ASC, id ASC`,
    [userId, address]
  );
  return rows.map((row) => mapTakeProfitOrder(row));
}

async function cancelOpenTakeProfitOrders(userId, address, runner, reason = 'position_closed') {
  const { rows } = await runner.query(
    `UPDATE mock_trading_take_profit_orders
     SET status = 'cancelled',
         cancelled_at = NOW(),
         updated_at = NOW(),
         metadata = jsonb_set(metadata, '{cancelReason}', to_jsonb($3::text), true)
     WHERE user_id = $1
       AND token_address = $2
       AND status = 'open'
     RETURNING *`,
    [userId, address, reason]
  );
  return rows.map((row) => mapTakeProfitOrder(row));
}

async function cancelAllOpenTakeProfitOrders(userId, runner, reason = 'portfolio_reset') {
  const { rows } = await runner.query(
    `UPDATE mock_trading_take_profit_orders
     SET status = 'cancelled',
         cancelled_at = NOW(),
         updated_at = NOW(),
         metadata = jsonb_set(metadata, '{cancelReason}', to_jsonb($2::text), true)
     WHERE user_id = $1
       AND status = 'open'
     RETURNING *`,
    [userId, reason]
  );
  return rows.map((row) => mapTakeProfitOrder(row));
}

async function insertTrade(userId, address, trade, runner) {
  const { rows } = await runner.query(
    `INSERT INTO mock_trading_trades (
       user_id, token_address, side, quantity, price_usd, market_cap_usd, notional_usd,
       realized_pnl_usd, realized_pnl_pct, price_return_pct, price_multiple, mcap_multiple,
       source, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
      trade.source || 'token_catalog',
      JSON.stringify(trade.metadata || {}),
    ]
  );
  return mapTrade(rows[0]);
}

function buildTradeMetadata(catalog, extra = {}) {
  return {
    symbol: catalog.symbol || null,
    name: catalog.name || null,
    imageUrl: catalog.imageUrl || null,
    ...extra,
  };
}

async function buyToken(payload = {}, options = {}) {
  const userId = normalizeUserId(payload.userId);
  const address = normalizeTokenAddress(payload.address);
  const notionalUsd = normalizePositiveAmount(payload.notionalUsd, 'notionalUsd');

  return withTransaction(async (client) => {
    const account = await ensureAccount(userId, client, { lock: true, startingCashUsd: options.startingCashUsd });
    const catalog = await loadFreshCatalogPrice(address, client, options);
    const takeProfitInput = normalizeTakeProfitInput(payload, catalog);
    const position = await loadPositionForUpdate(userId, address, client);
    const next = buildBuyState({ account, position, priceUsd: catalog.priceUsd, marketCapUsd: catalog.marketCapUsd, notionalUsd });

    await saveAccount(next.account, client);
    await savePosition(userId, address, next.position, client);
    next.trade.metadata = buildTradeMetadata(catalog, next.trade.metadata);
    const trade = await insertTrade(userId, address, next.trade, client);
    const takeProfitOrder = await createTakeProfitOrder(userId, address, takeProfitInput, client);
    const takeProfitOrders = await listOpenTakeProfitOrdersForPosition(userId, address, client);
    return {
      account: next.account,
      position: {
        ...next.position,
        takeProfitOrder: takeProfitOrder || takeProfitOrders[0] || null,
        takeProfitOrders,
      },
      trade,
      takeProfitOrder,
      takeProfitOrders,
      catalog,
    };
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
    next.trade.metadata = buildTradeMetadata(catalog, next.trade.metadata);
    const trade = await insertTrade(userId, address, next.trade, client);
    if (!next.position) {
      await cancelOpenTakeProfitOrders(userId, address, client, 'position_closed');
    }
    return { account: next.account, position: next.position, trade, catalog };
  });
}

async function createTakeProfitOrderForPosition(payload = {}, options = {}) {
  const userId = normalizeUserId(payload.userId);
  const address = normalizeTokenAddress(payload.address);

  return withTransaction(async (client) => {
    const position = await loadPositionForUpdate(userId, address, client);
    if (!position || !(position.quantity > 0)) {
      throw new MockTradingError('No open mock trading position', 'position_not_found', 404);
    }

    const catalog = await loadFreshCatalogPrice(address, client, options);
    const takeProfitInput = normalizeTakeProfitInput(payload, catalog);
    if (!takeProfitInput) {
      throw new MockTradingError('Take profit MCAP is required', 'invalid_take_profit_target');
    }

    const takeProfitOrder = await createTakeProfitOrder(userId, address, takeProfitInput, client);
    const takeProfitOrders = await listOpenTakeProfitOrdersForPosition(userId, address, client);
    return {
      position: buildPositionView(position, {
        symbol: catalog.symbol,
        name: catalog.name,
        last_price: catalog.priceUsd,
        last_mcap: catalog.marketCapUsd,
      }, takeProfitOrders),
      takeProfitOrder,
      takeProfitOrders,
      catalog,
    };
  });
}

async function resetAccount(payload = {}) {
  const userId = normalizeUserId(payload.userId);
  const startingCashUsd = normalizePositiveAmount(payload.startingCashUsd ?? DEFAULT_STARTING_CASH_USD, 'startingCashUsd');

  return withTransaction(async (client) => {
    await cancelAllOpenTakeProfitOrders(userId, client, 'portfolio_reset');
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

async function addCash(payload = {}) {
  const userId = normalizeUserId(payload.userId);
  const amountUsd = normalizePositiveAmount(payload.amountUsd, 'amountUsd');

  return withTransaction(async (client) => {
    await ensureAccount(userId, client, { lock: true });
    const { rows } = await client.query(
      `UPDATE mock_trading_accounts
       SET starting_cash_usd = starting_cash_usd + $2,
           cash_usd = cash_usd + $2,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, formatNumeric(amountUsd, 6)]
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
  const { rows: orderRows } = await runner.query(
    `SELECT *
     FROM mock_trading_take_profit_orders
     WHERE user_id = $1
       AND status = 'open'
     ORDER BY token_address ASC, target_mcap_usd ASC, id ASC`,
    [userId]
  );
  const ordersByAddress = new Map();
  for (const order of mapTakeProfitOrders(orderRows)) {
    const group = ordersByAddress.get(order.tokenAddress) || [];
    group.push(order);
    ordersByAddress.set(order.tokenAddress, group);
  }
  return rows.map((row) => buildPositionView(mapPosition(row), row, ordersByAddress.get(row.token_address) || []));
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
  const clauses = ['mt.user_id = $1'];
  if (filters.address != null && String(filters.address).trim() !== '') {
    values.push(normalizeTokenAddress(filters.address));
    clauses.push(`mt.token_address = $${values.length}`);
  }
  const { rows } = await runner.query(
    `SELECT
       mt.*,
       COALESCE(NULLIF(mt.metadata->>'symbol', ''), tc.symbol) AS trade_symbol,
       COALESCE(NULLIF(mt.metadata->>'name', ''), tc.name) AS trade_name,
       COALESCE(NULLIF(mt.metadata->>'imageUrl', ''), tc.last_image_url) AS trade_image_url
     FROM mock_trading_trades mt
     LEFT JOIN token_catalog tc
       ON tc.address = mt.token_address
     WHERE ${clauses.join(' AND ')}
     ORDER BY mt.executed_at DESC, mt.id DESC
     LIMIT $2`,
    values
  );
  return rows.map(mapTrade);
}

async function listTriggeredTakeProfitCandidates(limitValue = 25, runner = db) {
  const limit = Math.max(1, Math.min(Math.trunc(Number(limitValue) || 25), 100));
  const { rows } = await runner.query(
    `SELECT o.id
     FROM mock_trading_take_profit_orders o
     JOIN mock_trading_positions p
       ON p.user_id = o.user_id
      AND p.token_address = o.token_address
     JOIN token_catalog tc
       ON tc.address = o.token_address
     WHERE o.status = 'open'
       AND tc.last_mcap IS NOT NULL
       AND tc.last_mcap >= o.target_mcap_usd
     ORDER BY o.updated_at ASC, o.id ASC
     LIMIT $1`,
    [limit]
  );
  return rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

async function loadTakeProfitOrderForUpdate(orderId, runner) {
  const id = Number.parseInt(String(orderId || '').trim(), 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new MockTradingError('Valid take profit order id is required', 'invalid_order_id');
  }

  const { rows } = await runner.query(
    `SELECT *
     FROM mock_trading_take_profit_orders
     WHERE id = $1
     FOR UPDATE`,
    [id]
  );
  return mapTakeProfitOrder(rows[0]);
}

async function loadTakeProfitOrder(orderId, runner) {
  const id = Number.parseInt(String(orderId || '').trim(), 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new MockTradingError('Valid take profit order id is required', 'invalid_order_id');
  }

  const { rows } = await runner.query(
    `SELECT *
     FROM mock_trading_take_profit_orders
     WHERE id = $1`,
    [id]
  );
  return mapTakeProfitOrder(rows[0]);
}

async function markTakeProfitOrderTriggered(orderId, tradeId, runner) {
  const { rows } = await runner.query(
    `UPDATE mock_trading_take_profit_orders
     SET status = 'triggered',
         triggered_trade_id = $2,
         triggered_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [orderId, tradeId]
  );
  return mapTakeProfitOrder(rows[0]);
}

async function cancelTakeProfitOrderById(orderId, runner, reason) {
  const { rows } = await runner.query(
    `UPDATE mock_trading_take_profit_orders
     SET status = 'cancelled',
         cancelled_at = NOW(),
         updated_at = NOW(),
         metadata = jsonb_set(metadata, '{cancelReason}', to_jsonb($2::text), true)
     WHERE id = $1
       AND status = 'open'
     RETURNING *`,
    [orderId, reason]
  );
  return mapTakeProfitOrder(rows[0]);
}

async function cancelTakeProfitOrder(payload = {}) {
  const userId = normalizeUserId(payload.userId);
  const orderId = Number.parseInt(String(payload.orderId || '').trim(), 10);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new MockTradingError('Valid take profit order id is required', 'invalid_order_id');
  }

  return withTransaction(async (client) => {
    const order = await loadTakeProfitOrderForUpdate(orderId, client);
    if (!order || order.userId !== userId) {
      throw new MockTradingError('Take profit order not found', 'order_not_found', 404);
    }
    if (order.status !== 'open') {
      throw new MockTradingError('Take profit order is not open', 'order_not_open', 409);
    }
    const cancelled = await cancelTakeProfitOrderById(orderId, client, 'user_cancelled');
    if (!cancelled) {
      throw new MockTradingError('Take profit order is not open', 'order_not_open', 409);
    }
    return cancelled;
  });
}

async function executeTakeProfitOrder(orderId, options = {}) {
  return withTransaction(async (client) => {
    const orderCandidate = await loadTakeProfitOrder(orderId, client);
    if (!orderCandidate || orderCandidate.status !== 'open') {
      return { status: 'skipped', reason: 'order_not_open', order: orderCandidate };
    }

    const account = await ensureAccount(orderCandidate.userId, client, { lock: true, startingCashUsd: options.startingCashUsd });
    const order = await loadTakeProfitOrderForUpdate(orderId, client);
    if (!order || order.status !== 'open') {
      return { status: 'skipped', reason: 'order_not_open', order };
    }

    const position = await loadPositionForUpdate(order.userId, order.tokenAddress, client);
    if (!position || !(position.quantity > 0)) {
      const cancelled = await cancelTakeProfitOrderById(order.id, client, 'position_missing');
      return { status: 'cancelled', reason: 'position_missing', order: cancelled || order };
    }

    const catalog = await loadFreshCatalogPrice(order.tokenAddress, client, options);
    if (!(catalog.marketCapUsd >= order.targetMcapUsd)) {
      return { status: 'skipped', reason: 'target_not_reached', order, catalog };
    }

    const quantity = position.quantity * (order.sellPercent / 100);
    const next = buildSellState({
      account,
      position,
      priceUsd: catalog.priceUsd,
      marketCapUsd: catalog.marketCapUsd,
      quantity,
    });
    next.trade.source = 'take_profit';
    next.trade.metadata = buildTradeMetadata(catalog, {
      takeProfitOrderId: order.id,
      targetMcapUsd: order.targetMcapUsd,
      sellPercent: order.sellPercent,
      triggerMcapUsd: catalog.marketCapUsd,
    });

    await saveAccount(next.account, client);
    await savePosition(order.userId, order.tokenAddress, next.position, client);
    const trade = await insertTrade(order.userId, order.tokenAddress, next.trade, client);
    const triggeredOrder = await markTakeProfitOrderTriggered(order.id, trade.id, client);

    return {
      status: 'triggered',
      account: next.account,
      position: next.position,
      trade,
      order: triggeredOrder,
      catalog,
    };
  });
}

module.exports = {
  DEFAULT_PRICE_MAX_AGE_MS,
  DEFAULT_STARTING_CASH_USD,
  MockTradingError,
  addCash,
  buyToken,
  cancelTakeProfitOrder,
  createTakeProfitOrderForPosition,
  executeTakeProfitOrder,
  formatNumeric,
  getSummary,
  listTriggeredTakeProfitCandidates,
  listPositions,
  listTrades,
  mapAccount,
  mapPosition,
  mapTakeProfitOrder,
  normalizePositiveAmount,
  normalizeTokenAddress,
  normalizeUserId,
  resetAccount,
  sellToken,
  __private: {
    buildBuyState,
    buildSellState,
    normalizeTakeProfitInput,
    mapCatalogPrice,
    normalizeSellQuantity,
  },
};
