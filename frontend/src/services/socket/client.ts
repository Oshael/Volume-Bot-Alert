import { io, type Socket } from 'socket.io-client';
import { resolveApiBase } from '../api/base';
import type { DashboardAlertEvent } from '../api/catalog';
import type { TokenChain } from '../../utils/token-chain';
import {
  createMarketEventOrderGate,
  normalizeMarketBucketUpdate,
  normalizeMarketTradeUpdate,
  normalizeMarketSubscription,
  type MarketBucketUpdateEvent,
  type MarketSubscriptionIdentity,
  type MarketTradeUpdateEvent,
} from './market-events';

export type { MarketBucketUpdateEvent, MarketTradeUpdateEvent } from './market-events';

let socket: Socket | null = null;
const chartMarketSubscriptions = new Map<string, MarketSubscriptionIdentity>();
const workspaceMarketSubscriptions = new Map<string, MarketSubscriptionIdentity>();
const marketEventOrder = createMarketEventOrderGate();
const marketTradeListeners = new Map<string, {
  identity: MarketSubscriptionIdentity;
  listeners: Set<(event: MarketTradeUpdateEvent) => void>;
}>();
let desiredLivePresence: {
  workspace: 'live';
  mode: 'foreground' | 'hidden' | 'inactive';
  hiddenGraceMs?: number;
} | null = null;

export function connectSocket(): Socket {
  if (socket) {
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  socket = io(resolveApiBase(), {
    transports: ['websocket'],
    withCredentials: true,
  });

  return socket;
}

function getDesiredMarketSubscriptions() {
  return new Map([...workspaceMarketSubscriptions, ...chartMarketSubscriptions]);
}

function emitMarketSubscriptionSync(current = socket) {
  if (!current?.connected) return;
  const subscriptions = [...getDesiredMarketSubscriptions().values()]
    .map(({ chain, address }) => ({ chain, address }));
  current.emit('market:sync', { subscriptions });
}

function emitMarketTradeSubscriptionSync(current = socket) {
  if (!current?.connected) return;
  const subscriptions = [...marketTradeListeners.values()]
    .map(({ identity }) => ({ chain: identity.chain, address: identity.address }));
  current.emit('market:trade:sync', { subscriptions });
}

export function bindSocketLifecycle(options: {
  onRevoked: (reason: string) => void;
  onStatus?: (message: string) => void;
  onAlertEvent?: (payload: DashboardAlertEvent) => void;
  onMarketBucket?: (payload: MarketBucketUpdateEvent) => void;
}) {
  const current = connectSocket();

  current.off('connect');
  current.off('disconnect');
  current.off('connect_error');
  current.off('auth:revoked');
  current.off('alert:event');
  current.off('market:bucket');
  current.off('market:trade');

  current.on('connect', () => {
    if (desiredLivePresence) {
      current.emit('live:presence', desiredLivePresence);
    }
    emitMarketSubscriptionSync(current);
    emitMarketTradeSubscriptionSync(current);
    options.onStatus?.('Socket connected.');
  });

  current.on('disconnect', (reason) => {
    options.onStatus?.(`Socket disconnected: ${reason}`);
  });

  current.on('connect_error', (error) => {
    options.onStatus?.(`Socket error: ${error.message}`);
  });

  current.on('auth:revoked', (payload?: { reason?: string }) => {
    options.onRevoked(payload?.reason || 'session_revoked');
  });

  current.on('alert:event', (payload: DashboardAlertEvent) => {
    options.onAlertEvent?.(payload);
  });

  current.on('market:bucket', (payload: unknown) => {
    const event = normalizeMarketBucketUpdate(payload);
    if (event && marketEventOrder.accept(event)) {
      options.onMarketBucket?.(event);
    }
  });

  current.on('market:trade', (payload: unknown) => {
    const event = normalizeMarketTradeUpdate(payload);
    const identity = event && normalizeMarketSubscription(event.address, event.chain);
    if (!event || !identity) return;
    for (const listener of marketTradeListeners.get(identity.key)?.listeners || []) listener(event);
  });

  return current;
}

export function subscribePumpMint(_mint: string) {
  return false;
}

export function unsubscribePumpMint(_mint: string) {
  return false;
}

export function subscribeMarketChart(address: string, chain: TokenChain = 'solana') {
  const identity = normalizeMarketSubscription(address, chain);
  if (!identity) return false;

  chartMarketSubscriptions.set(identity.key, identity);
  emitMarketSubscriptionSync(connectSocket());
  return true;
}

export function unsubscribeMarketChart(address: string, chain: TokenChain = 'solana') {
  const identity = normalizeMarketSubscription(address, chain);
  if (!identity) return false;

  chartMarketSubscriptions.delete(identity.key);
  if (!workspaceMarketSubscriptions.has(identity.key)) marketEventOrder.clearIdentity(identity);
  emitMarketSubscriptionSync();
  return true;
}

export function subscribeRobinhoodTrades(
  address: string,
  listener: (event: MarketTradeUpdateEvent) => void,
) {
  const identity = normalizeMarketSubscription(address, 'robinhood');
  if (!identity) return null;
  const entry = marketTradeListeners.get(identity.key) || { identity, listeners: new Set() };
  entry.listeners.add(listener);
  marketTradeListeners.set(identity.key, entry);
  emitMarketTradeSubscriptionSync(connectSocket());
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) marketTradeListeners.delete(identity.key);
    emitMarketTradeSubscriptionSync();
  };
}

export function replaceWorkspaceMarketSubscriptions(items: MarketSubscriptionIdentity[]) {
  const previousKeys = [...workspaceMarketSubscriptions.keys()].sort().join('|');
  workspaceMarketSubscriptions.clear();
  for (const item of items) {
    const identity = normalizeMarketSubscription(item.address, item.chain);
    if (identity) workspaceMarketSubscriptions.set(identity.key, identity);
  }
  const nextKeys = [...workspaceMarketSubscriptions.keys()].sort().join('|');
  if (previousKeys !== nextKeys) emitMarketSubscriptionSync();
  return workspaceMarketSubscriptions.size;
}

export function getSocket(): Socket | null {
  return socket;
}

export function getDesiredPumpSubscriptionCount() {
  return 0;
}

export function updateLivePresence(payload: {
  workspace: 'live';
  mode: 'foreground' | 'hidden' | 'inactive';
  hiddenGraceMs?: number;
}) {
  desiredLivePresence = payload.mode === 'hidden'
    ? {
        workspace: 'live',
        mode: 'hidden',
        hiddenGraceMs: Math.max(1, Math.trunc(Number(payload.hiddenGraceMs) || 0)),
      }
    : {
        workspace: 'live',
        mode: payload.mode,
      };

  if (!socket) {
    return;
  }

  socket.emit('live:presence', desiredLivePresence);
}

export function disconnectSocket() {
  chartMarketSubscriptions.clear();
  workspaceMarketSubscriptions.clear();
  marketEventOrder.clear();
  marketTradeListeners.clear();
  socket?.disconnect();
}
