import { io, type Socket } from 'socket.io-client';
import { resolveApiBase } from '../api/base';
import type { DashboardAlertEvent } from '../api/catalog';

let socket: Socket | null = null;
const desiredPumpSubscriptions = new Set<string>();
let desiredLivePresence: {
  workspace: 'live';
  mode: 'foreground' | 'hidden' | 'inactive';
  hiddenGraceMs?: number;
} | null = null;

function normalizeMint(value: string) {
  return String(value || '').trim();
}

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

export function bindSocketLifecycle(options: {
  onRevoked: (reason: string) => void;
  onStatus?: (message: string) => void;
  onPumpStatus?: (payload: { connected?: boolean }) => void;
  onPumpNewToken?: (payload: Record<string, unknown>) => void;
  onPumpTrade?: (payload: Record<string, unknown>) => void;
  onPumpMigrate?: (payload: Record<string, unknown>) => void;
  onSolPrice?: (payload: { price?: number }) => void;
  onAlertEvent?: (payload: DashboardAlertEvent) => void;
}) {
  const current = connectSocket();

  current.off('connect');
  current.off('disconnect');
  current.off('connect_error');
  current.off('auth:revoked');
  current.off('pump:status');
  current.off('pump:newToken');
  current.off('pump:trade');
  current.off('pump:migrate');
  current.off('sol:price');
  current.off('alert:event');

  current.on('connect', () => {
    for (const mint of desiredPumpSubscriptions) {
      current.emit('pump:subscribe', { mint });
    }
    if (desiredLivePresence) {
      current.emit('live:presence', desiredLivePresence);
    }
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

  current.on('pump:status', (payload: { connected?: boolean }) => {
    options.onPumpStatus?.(payload);
  });

  current.on('pump:newToken', (payload: Record<string, unknown>) => {
    options.onPumpNewToken?.(payload);
  });

  current.on('pump:trade', (payload: Record<string, unknown>) => {
    options.onPumpTrade?.(payload);
  });

  current.on('pump:migrate', (payload: Record<string, unknown>) => {
    options.onPumpMigrate?.(payload);
  });

  current.on('sol:price', (payload: { price?: number }) => {
    options.onSolPrice?.(payload);
  });

  current.on('alert:event', (payload: DashboardAlertEvent) => {
    options.onAlertEvent?.(payload);
  });

  return current;
}

export function subscribePumpMint(mint: string) {
  const normalizedMint = normalizeMint(mint);
  if (!normalizedMint) return;
  if (desiredPumpSubscriptions.has(normalizedMint)) return;
  desiredPumpSubscriptions.add(normalizedMint);
  if (!socket) return;
  socket.emit('pump:subscribe', { mint: normalizedMint });
}

export function unsubscribePumpMint(mint: string) {
  const normalizedMint = normalizeMint(mint);
  if (!normalizedMint) return;
  const hadSubscription = desiredPumpSubscriptions.delete(normalizedMint);
  if (!socket || !hadSubscription) return;
  socket.emit('pump:unsubscribe', { mint: normalizedMint });
}

export function getSocket(): Socket | null {
  return socket;
}

export function getDesiredPumpSubscriptionCount() {
  return desiredPumpSubscriptions.size;
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
  socket?.disconnect();
}
