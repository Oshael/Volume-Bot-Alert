import { apiFetch } from './base';

export interface MockTradingAccount {
  userId: number;
  walletId?: number | null;
  startingCashUsd: number;
  cashUsd: number;
  realizedPnlUsd: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface MockTradingPosition {
  userId: number;
  walletId?: number | null;
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
  walletId?: number | null;
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
  walletId?: number | null;
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
  mockSolUsdcRate?: number | null;
  executedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MockTradingSolUsdPrice {
  provider?: string | null;
  priceUsd?: number | null;
  stale?: boolean | null;
  lastUpdatedAt?: string | null;
  ageSeconds?: number | null;
  lastError?: string | null;
}

export interface MockTradingSummary {
  account: MockTradingAccount;
  wallet?: MockTradingWallet | null;
  openPositionCount: number;
  openPositionValueUsd: number;
  totalEquityUsd: number;
  totalPnlUsd: number;
  totalPnlPct?: number | null;
  solUsdPrice?: MockTradingSolUsdPrice | null;
  generatedAt?: string | null;
}

export interface MockTradingWallet {
  id: number;
  userId: number;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  archivedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
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
    walletId: toNullableNumber(item.walletId),
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
    walletId: toNullableNumber(item.walletId),
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
      walletId: toNullableNumber(payload.account?.walletId),
      startingCashUsd: toNumber(payload.account?.startingCashUsd),
      cashUsd: toNumber(payload.account?.cashUsd),
      realizedPnlUsd: toNumber(payload.account?.realizedPnlUsd),
    },
    wallet: payload.wallet ? normalizeWallet(payload.wallet) : null,
    openPositionCount: toNumber(payload.openPositionCount),
    openPositionValueUsd: toNumber(payload.openPositionValueUsd),
    totalEquityUsd: toNumber(payload.totalEquityUsd),
    totalPnlUsd: toNumber(payload.totalPnlUsd),
    totalPnlPct: toNullableNumber(payload.totalPnlPct),
    solUsdPrice: payload.solUsdPrice ? normalizeSolUsdPrice(payload.solUsdPrice) : null,
  };
}

function normalizeSolUsdPrice(payload: MockTradingSolUsdPrice): MockTradingSolUsdPrice {
  return {
    ...payload,
    priceUsd: toNullableNumber(payload.priceUsd),
    stale: payload.stale === true,
    ageSeconds: toNullableNumber(payload.ageSeconds),
  };
}

function normalizeTrade(item: MockTradingTrade): MockTradingTrade {
  return {
    ...item,
    id: toNumber(item.id),
    userId: toNumber(item.userId),
    walletId: toNullableNumber(item.walletId),
    quantity: toNumber(item.quantity),
    priceUsd: toNumber(item.priceUsd),
    marketCapUsd: toNullableNumber(item.marketCapUsd),
    notionalUsd: toNumber(item.notionalUsd),
    realizedPnlUsd: toNumber(item.realizedPnlUsd),
    realizedPnlPct: toNullableNumber(item.realizedPnlPct),
    priceReturnPct: toNullableNumber(item.priceReturnPct),
    priceMultiple: toNullableNumber(item.priceMultiple),
    mcapMultiple: toNullableNumber(item.mcapMultiple),
    mockSolUsdcRate: toNullableNumber(item.mockSolUsdcRate ?? item.metadata?.mockSolUsdcRate),
    metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : null,
  };
}

function normalizeWallet(item: MockTradingWallet): MockTradingWallet {
  return {
    ...item,
    id: toNumber(item.id),
    userId: toNumber(item.userId),
    name: String(item.name || 'Main'),
    sortOrder: toNumber(item.sortOrder),
    isDefault: item.isDefault === true,
  };
}

function buildWalletQuery(walletId?: number | null) {
  const id = toNullableNumber(walletId);
  return id == null ? '' : `walletId=${encodeURIComponent(String(id))}`;
}

function appendQuery(path: string, queryParts: string[]) {
  const query = queryParts.filter(Boolean).join('&');
  return query ? `${path}?${query}` : path;
}

function withWalletBody<T extends Record<string, unknown>>(body: T, walletId?: number | null) {
  const id = toNullableNumber(walletId);
  return id == null ? body : { ...body, walletId: id };
}

export function fetchMockTradingWallets(token?: string | null) {
  return apiFetch<{ wallets: MockTradingWallet[] }>('/api/admin/mock-trading/wallets', { token })
    .then((payload) => (Array.isArray(payload.wallets) ? payload.wallets.map(normalizeWallet) : []));
}

export function createMockTradingWallet(name: string, token?: string | null) {
  return apiFetch<{ message: string; wallet: MockTradingWallet }>('/api/admin/mock-trading/wallets', {
    method: 'POST',
    body: JSON.stringify({ name }),
    token,
  }).then((payload) => ({ ...payload, wallet: normalizeWallet(payload.wallet) }));
}

export function updateMockTradingWallet(walletId: number, name: string, token?: string | null) {
  return apiFetch<{ message: string; wallet: MockTradingWallet }>(`/api/admin/mock-trading/wallets/${encodeURIComponent(String(walletId))}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
    token,
  }).then((payload) => ({ ...payload, wallet: normalizeWallet(payload.wallet) }));
}

export function archiveMockTradingWallet(walletId: number, token?: string | null) {
  return apiFetch<{ message: string; wallet: MockTradingWallet }>(`/api/admin/mock-trading/wallets/${encodeURIComponent(String(walletId))}/archive`, {
    method: 'POST',
    token,
  }).then((payload) => ({ ...payload, wallet: normalizeWallet(payload.wallet) }));
}

export function setDefaultMockTradingWallet(walletId: number, token?: string | null) {
  return apiFetch<{ message: string; wallet: MockTradingWallet }>(`/api/admin/mock-trading/wallets/${encodeURIComponent(String(walletId))}/default`, {
    method: 'POST',
    token,
  }).then((payload) => ({ ...payload, wallet: normalizeWallet(payload.wallet) }));
}

export function fetchMockTradingSummary(token?: string | null, walletId?: number | null) {
  return apiFetch<MockTradingSummary>(appendQuery('/api/admin/mock-trading/summary', [buildWalletQuery(walletId)]), { token }).then(normalizeSummary);
}

export function fetchMockTradingPositions(token?: string | null, walletId?: number | null) {
  return apiFetch<{ positions: MockTradingPosition[] }>(appendQuery('/api/admin/mock-trading/positions', [buildWalletQuery(walletId)]), { token })
    .then((payload) => (Array.isArray(payload.positions) ? payload.positions.map(normalizePosition) : []));
}

export function fetchMockTradingTrades(token?: string | null, limit = 200, walletId?: number | null) {
  const safeLimit = Math.max(1, Math.min(Math.round(limit), 200));
  return apiFetch<{ trades: MockTradingTrade[] }>(
    appendQuery('/api/admin/mock-trading/trades', [`limit=${safeLimit}`, buildWalletQuery(walletId)]),
    { token }
  )
    .then((payload) => (Array.isArray(payload.trades) ? payload.trades.map(normalizeTrade) : []));
}

export function buyMockTradingToken(
  address: string,
  notionalSol: number,
  token?: string | null,
  takeProfit?: { targetMcapUsd?: number | null; sellPercent?: number | null },
  walletId?: number | null,
) {
  const body = withWalletBody({
    address,
    notionalSol,
    takeProfitMcapUsd: takeProfit?.targetMcapUsd ?? undefined,
    takeProfitSellPercent: takeProfit?.sellPercent ?? undefined,
  }, walletId);
  return apiFetch<{ message: string; position: MockTradingPosition }>('/api/admin/mock-trading/buy', {
    method: 'POST',
    body: JSON.stringify(body),
    token,
  }).then((payload) => ({ ...payload, position: normalizePosition(payload.position) }));
}

export function sellMockTradingToken(address: string, percent: number, token?: string | null, walletId?: number | null) {
  return apiFetch<{ message: string; position: MockTradingPosition | null }>('/api/admin/mock-trading/sell', {
    method: 'POST',
    body: JSON.stringify(withWalletBody({ address, percent }, walletId)),
    token,
  }).then((payload) => ({ ...payload, position: payload.position ? normalizePosition(payload.position) : null }));
}

export function createMockTradingTakeProfitOrder(
  address: string,
  targetMcapUsd: number,
  sellPercent: number,
  token?: string | null,
  walletId?: number | null,
) {
  return apiFetch<{ message: string; position: MockTradingPosition; order: MockTradingTakeProfitOrder }>('/api/admin/mock-trading/take-profit-orders', {
    method: 'POST',
    body: JSON.stringify(withWalletBody({
      address,
      takeProfitMcapUsd: targetMcapUsd,
      takeProfitSellPercent: sellPercent,
    }, walletId)),
    token,
  }).then((payload) => ({
    ...payload,
    position: normalizePosition(payload.position),
    order: normalizeTakeProfitOrder(payload.order),
  }));
}

export function cancelMockTradingTakeProfitOrder(orderId: number, token?: string | null, walletId?: number | null) {
  return apiFetch<{ message: string; order: MockTradingTakeProfitOrder }>(`/api/admin/mock-trading/take-profit-orders/${orderId}/cancel`, {
    method: 'POST',
    body: JSON.stringify(withWalletBody({}, walletId)),
    token,
  }).then((payload) => ({ ...payload, order: normalizeTakeProfitOrder(payload.order) }));
}

export function resetMockTradingPortfolio(startingCashUsd?: number, token?: string | null, walletId?: number | null) {
  const body = withWalletBody(startingCashUsd == null ? {} : { startingCashUsd }, walletId);
  return apiFetch<{ message: string; account: MockTradingAccount }>('/api/admin/mock-trading/reset', {
    method: 'POST',
    body: JSON.stringify(body),
    token,
  }).then((payload) => ({
    ...payload,
    account: {
      ...payload.account,
      userId: toNumber(payload.account?.userId),
      walletId: toNullableNumber(payload.account?.walletId),
      startingCashUsd: toNumber(payload.account?.startingCashUsd),
      cashUsd: toNumber(payload.account?.cashUsd),
      realizedPnlUsd: toNumber(payload.account?.realizedPnlUsd),
    },
  }));
}

export function addMockTradingCash(amountSol: number, token?: string | null, walletId?: number | null) {
  return apiFetch<{ message: string }>('/api/admin/mock-trading/add-cash', {
    method: 'POST',
    body: JSON.stringify(withWalletBody({ amountSol }, walletId)),
    token,
  });
}
