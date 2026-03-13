import { io, type Socket } from 'socket.io-client';
import { resolveApiBase } from '../api/base';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket) {
    socket.auth = { token };
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  socket = io(resolveApiBase(), {
    transports: ['websocket'],
    auth: { token },
  });

  return socket;
}

export function bindSocketLifecycle(options: {
  token: string;
  onRevoked: (reason: string) => void;
  onStatus?: (message: string) => void;
  onDexTokenData?: (payload: { address: string; data: unknown }) => void;
  onPumpStatus?: (payload: { connected?: boolean }) => void;
  onPumpNewToken?: (payload: Record<string, unknown>) => void;
  onPumpTrade?: (payload: Record<string, unknown>) => void;
  onPumpMigrate?: (payload: Record<string, unknown>) => void;
  onSolPrice?: (payload: { price?: number }) => void;
}) {
  const current = connectSocket(options.token);

  current.off('connect');
  current.off('disconnect');
  current.off('connect_error');
  current.off('auth:revoked');
  current.off('dex:tokenData');
  current.off('pump:status');
  current.off('pump:newToken');
  current.off('pump:trade');
  current.off('pump:migrate');
  current.off('sol:price');

  current.on('connect', () => {
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

  current.on('dex:tokenData', (payload: { address: string; data: unknown }) => {
    options.onDexTokenData?.(payload);
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

  return current;
}

export function requestDexToken(address: string) {
  if (!socket) return;
  socket.emit('dex:subscribe', { address });
}

export function subscribePumpMint(mint: string) {
  if (!socket) return;
  socket.emit('pump:subscribe', { mint });
}

export function unsubscribePumpMint(mint: string) {
  if (!socket) return;
  socket.emit('pump:unsubscribe', { mint });
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
}
