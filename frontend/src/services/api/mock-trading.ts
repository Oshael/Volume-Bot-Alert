import { apiFetch } from './base';

export interface MockTradingAccount {
  userId: number;
  startingCashUsd: number;
  cashUsd: number;
  realizedPnlUsd: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface MockTradingPosition {
  userId: number;
  tokenAddress: string;
  quantity: number;
  avgEntryPriceUsd: number;
  avgEntryMcapUsd?: number | null;
  costBasisUsd: number;
  realizedPnlUsd: number;
  currentPriceUsd?: number | null;
  currentMcapUsd?: number | null;
  currentValueUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  unrealizedPnlPct?: number | null;
  priceReturnPct?: number | null;
  priceMultiple?: number | null;
  mcapMultiple?: number | null;
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  openedAt?: string | null;
  updatedAt?: string | null;
  takeProfitOrder?: MockTradingTakeProfitOrder | null;
  takeProfitOrders?: MockTradingTakeProfitOrder[];
}

export interface MockTradingTakeProfitOrder {
  id: number;
  userId: number;
  tokenAddress: string;
  targetMcapUsd: number;
  sellPercent: number;
  status: 'open' | 'triggered' | 'cancelled';
  triggeredTradeId?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  triggeredAt?: string | null;
  cancelledAt?: string | null;
}

export interface MockTradingTrade {
  id: number;
  userId: number;
  tokenAddress: string;
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  side: 'buy' | 'sell';
  quantity: number;
  priceUsd: number;
  marketCapUsd?: number | null;
  notionalUsd: number;
  realizedPnlUsd: number;
  realizedPnlPct?: number | null;
  priceReturnPct?: number | null;
  priceMultiple?: number | null;
  mcapMultiple?: number | null;
  executedAt?: string | null;
}

export interface MockTradingSummary {
  account: MockTradingAccount;
  openPositionCount: number;
  openPositionValueUsd: number;
  totalEquityUsd: number;
  totalPnlUsd: number;
  totalPnlPct?: number | null;
  generatedAt?: string | null;
}

function toNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toNullableNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePosition(item: MockTradingPosition): MockTradingPosition {
  return {
    ...item,
    userId: toNumber(item.userId),
    quantity: toNumber(item.quantity),
    avgEntryPriceUsd: toNumber(item.avgEntryPriceUsd),
    avgEntryMcapUsd: toNullableNumber(item.avgEntryMcapUsd),
    costBasisUsd: toNumber(item.costBasisUsd),
    realizedPnlUsd: toNumber(item.realizedPnlUsd),
    currentPriceUsd: toNullableNumber(item.currentPriceUsd),
    currentMcapUsd: toNullableNumber(item.currentMcapUsd),
    currentValueUsd: toNullableNumber(item.currentValueUsd),
    unrealizedPnlUsd: toNullableNumber(item.unrealizedPnlUsd),
    unrealizedPnlPct: toNullableNumber(item.unrealizedPnlPct),
    priceReturnPct: toNullableNumber(item.priceReturnPct),
    priceMultiple: toNullableNumber(item.priceMultiple),
    mcapMultiple: toNullableNumber(item.mcapMultiple),
    takeProfitOrder: item.takeProfitOrder ? normalizeTakeProfitOrder(item.takeProfitOrder) : null,
    takeProfitOrders: Array.isArray(item.takeProfitOrders) ? item.takeProfitOrders.map(normalizeTakeProfitOrder) : [],
  };
}

function normalizeTakeProfitOrder(item: MockTradingTakeProfitOrder): MockTradingTakeProfitOrder {
  return {
    ...item,
    id: toNumber(item.id),
    userId: toNumber(item.userId),
    targetMcapUsd: toNumber(item.targetMcapUsd),
    sellPercent: toNumber(item.sellPercent, 100),
    triggeredTradeId: toNullableNumber(item.triggeredTradeId),
  };
}

function normalizeSummary(payload: MockTradingSummary): MockTradingSummary {
  return {
    ...payload,
    account: {
      ...payload.account,
      userId: toNumber(payload.account?.userId),
      startingCashUsd: toNumber(payload.account?.startingCashUsd),
      cashUsd: toNumber(payload.account?.cashUsd),
      realizedPnlUsd: toNumber(payload.account?.realizedPnlUsd),
    },
    openPositionCount: toNumber(payload.openPositionCount),
    openPositionValueUsd: toNumber(payload.openPositionValueUsd),
    totalEquityUsd: toNumber(payload.totalEquityUsd),
    totalPnlUsd: toNumber(payload.totalPnlUsd),
    totalPnlPct: toNullableNumber(payload.totalPnlPct),
  };
}

function normalizeTrade(item: MockTradingTrade): MockTradingTrade {
  return {
    ...item,
    id: toNumber(item.id),
    userId: toNumber(item.userId),
    quantity: toNumber(item.quantity),
    priceUsd: toNumber(item.priceUsd),
    marketCapUsd: toNullableNumber(item.marketCapUsd),
    notionalUsd: toNumber(item.notionalUsd),
    realizedPnlUsd: toNumber(item.realizedPnlUsd),
    realizedPnlPct: toNullableNumber(item.realizedPnlPct),
    priceReturnPct: toNullableNumber(item.priceReturnPct),
    priceMultiple: toNullableNumber(item.priceMultiple),
    mcapMultiple: toNullableNumber(item.mcapMultiple),
  };
}

export function fetchMockTradingSummary(token?: string | null) {
  return apiFetch<MockTradingSummary>('/api/admin/mock-trading/summary', { token }).then(normalizeSummary);
}

export function fetchMockTradingPositions(token?: string | null) {
  return apiFetch<{ positions: MockTradingPosition[] }>('/api/admin/mock-trading/positions', { token })
    .then((payload) => (Array.isArray(payload.positions) ? payload.positions.map(normalizePosition) : []));
}

export function fetchMockTradingTrades(token?: string | null, limit = 200) {
  const safeLimit = Math.max(1, Math.min(Math.round(limit), 200));
  return apiFetch<{ trades: MockTradingTrade[] }>(`/api/admin/mock-trading/trades?limit=${safeLimit}`, { token })
    .then((payload) => (Array.isArray(payload.trades) ? payload.trades.map(normalizeTrade) : []));
}

export function buyMockTradingToken(
  address: string,
  notionalUsd: number,
  token?: string | null,
  takeProfit?: { targetMcapUsd?: number | null; sellPercent?: number | null },
) {
  const body = {
    address,
    notionalUsd,
    takeProfitMcapUsd: takeProfit?.targetMcapUsd ?? undefined,
    takeProfitSellPercent: takeProfit?.sellPercent ?? undefined,
  };
  return apiFetch<{ message: string; position: MockTradingPosition }>('/api/admin/mock-trading/buy', {
    method: 'POST',
    body: JSON.stringify(body),
    token,
  }).then((payload) => ({ ...payload, position: normalizePosition(payload.position) }));
}

export function sellMockTradingToken(address: string, percent: number, token?: string | null) {
  return apiFetch<{ message: string; position: MockTradingPosition | null }>('/api/admin/mock-trading/sell', {
    method: 'POST',
    body: JSON.stringify({ address, percent }),
    token,
  }).then((payload) => ({ ...payload, position: payload.position ? normalizePosition(payload.position) : null }));
}

export function createMockTradingTakeProfitOrder(
  address: string,
  targetMcapUsd: number,
  sellPercent: number,
  token?: string | null,
) {
  return apiFetch<{ message: string; position: MockTradingPosition; order: MockTradingTakeProfitOrder }>('/api/admin/mock-trading/take-profit-orders', {
    method: 'POST',
    body: JSON.stringify({
      address,
      takeProfitMcapUsd: targetMcapUsd,
      takeProfitSellPercent: sellPercent,
    }),
    token,
  }).then((payload) => ({
    ...payload,
    position: normalizePosition(payload.position),
    order: normalizeTakeProfitOrder(payload.order),
  }));
}

export function cancelMockTradingTakeProfitOrder(orderId: number, token?: string | null) {
  return apiFetch<{ message: string; order: MockTradingTakeProfitOrder }>(`/api/admin/mock-trading/take-profit-orders/${orderId}/cancel`, {
    method: 'POST',
    token,
  }).then((payload) => ({ ...payload, order: normalizeTakeProfitOrder(payload.order) }));
}

export function resetMockTradingPortfolio(startingCashUsd?: number, token?: string | null) {
  const body = startingCashUsd == null ? {} : { startingCashUsd };
  return apiFetch<{ message: string; account: MockTradingAccount }>('/api/admin/mock-trading/reset', {
    method: 'POST',
    body: JSON.stringify(body),
    token,
  }).then((payload) => ({
    ...payload,
    account: {
      ...payload.account,
      userId: toNumber(payload.account?.userId),
      startingCashUsd: toNumber(payload.account?.startingCashUsd),
      cashUsd: toNumber(payload.account?.cashUsd),
      realizedPnlUsd: toNumber(payload.account?.realizedPnlUsd),
    },
  }));
}

export function addMockTradingCash(amountUsd: number, token?: string | null) {
  return apiFetch<{ message: string }>('/api/admin/mock-trading/add-cash', {
    method: 'POST',
    body: JSON.stringify({ amountUsd }),
    token,
  });
}
