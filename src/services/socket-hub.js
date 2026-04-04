/**
 * Socket.io Hub
 * Authenticates clients via the backend session token, distributes real-time data.
 *
 * Events sent to clients:
 * - pump:newToken     - new token created on PumpFun
 * - pump:trade        - trade event on subscribed token
 * - pump:migrate      - token migrated to DEX
 * - pump:status       - PumpFun connection status
 * - sol:price         - SOL/USD price update
 * - auth:revoked      - session revoked; client must logout
 *
 * Events received from clients:
 * - pump:subscribe    - { mint }    - subscribe to a specific PumpFun token
 * - pump:unsubscribe  - { mint }    - unsubscribe from a PumpFun token
 */

const { Server } = require('socket.io');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const Session = require('../models/session');
const User = require('../models/user');
const userAccess = require('../models/user-access');
const solPrice = require('./sol-price');
const pumpfun = require('./pumpfun-ws');
const tokenCatalog = require('../models/token-catalog');
const { getSocketClientIp, isAllowedOrigin } = require('../utils/request-security');
const { logSecurityEvent } = require('../utils/security-events');
const { logTrace } = require('../utils/pump-migrate-trace');

let io = null;
let solPriceTimer = null;
let accessSweepTimer = null;

const SOL_PRICE_BROADCAST_INTERVAL = 30000;
const ACCESS_SWEEP_INTERVAL = 60000;
const socketSubscriptions = new Map();
const mintSubscribers = new Map();
const sessionSockets = new Map();
const userSessions = new Map();
const ipSockets = new Map();
const socketActionState = new Map();

function sanitizeMint(rawMint) {
  if (typeof rawMint !== 'string') return null;
  const mint = rawMint.replace(/[^a-zA-Z0-9]/g, '');
  if (mint.length < 20 || mint.length > 64) return null;
  return mint;
}

function queueCatalogUpsert(token, source = 'unknown') {
  logTrace('pump_migrate_catalog_queue', {
    tokenAddress: token?.address || token?.mint || null,
    source,
    symbol: token?.symbol || null,
    name: token?.name || null,
    marketCap: Number.isFinite(Number(token?.mcap)) ? Number(token.mcap) : null,
  });

  Promise.resolve()
    .then(() => tokenCatalog.upsertToken({ ...token, source }))
    .then((upserted) => {
      logTrace('pump_migrate_catalog_upsert_ok', {
        tokenAddress: upserted?.address || token?.address || token?.mint || null,
        source: upserted?.source || source,
        monitorPriority: upserted?.monitor_priority || null,
        eligibleForMonitoring: upserted?.eligible_for_monitoring == null
          ? null
          : Boolean(upserted.eligible_for_monitoring),
        nextEvaluationAt: upserted?.next_evaluation_at || null,
        migrationGraceUntil: upserted?.migration_grace_until || null,
        marketCap: upserted?.last_mcap == null ? null : Number(upserted.last_mcap),
      });
    })
    .catch((err) => {
      const address = token?.address || token?.mint || 'unknown';
      logTrace('pump_migrate_catalog_upsert_error', {
        tokenAddress: address,
        source,
        error: err.message,
      }, { level: 'error' });
      console.error(`[TokenCatalog] Failed to upsert ${source} token ${address}:`, err.message);
    });
}

function buildCatalogTokenFromPump(msg) {
  const address = sanitizeMint(msg?.mint);
  if (!address) return null;

  const solUsd = solPrice.getPrice();
  const marketCapSol = Number(msg?.marketCapSol);
  const mcap = Number.isFinite(marketCapSol) && solUsd > 0 ? marketCapSol * solUsd : null;

  return {
    address,
    chain: 'solana',
    symbol: msg?.symbol || null,
    name: msg?.name || null,
    mcap,
    imageUrl: msg?.image || null,
    twitterUrl: msg?.twitter || null,
    isActiveMonitorCandidate: true,
  };
}

function ensureSocketSubscriptions(socket) {
  let subscriptions = socketSubscriptions.get(socket.id);
  if (!subscriptions) {
    subscriptions = new Set();
    socketSubscriptions.set(socket.id, subscriptions);
  }
  return subscriptions;
}

function noteSocketAction(socket, action) {
  const windowMs = Math.max(1000, Number(config.security?.socket?.actionWindowMs) || 10000);
  const maxActions = Math.max(1, Number(config.security?.socket?.maxActionsPerWindow) || 30);
  const now = Date.now();
  const current = socketActionState.get(socket.id);

  if (!current || (now - current.windowStartedAt) >= windowMs) {
    socketActionState.set(socket.id, {
      windowStartedAt: now,
      count: 1,
    });
    return true;
  }

  current.count += 1;
  if (current.count > maxActions) {
    logSecurityEvent('socket_action_rate_exceeded', {
      socketId: socket.id,
      userId: socket.user?.id,
      sessionId: socket.sessionId,
      ip: socket.clientIp,
      action,
      count: current.count,
      limit: maxActions,
      windowMs,
    });
    return false;
  }

  return true;
}

function trackSessionSocket(socket) {
  const sessionId = socket.sessionId;
  const userId = socket.user?.id;
  const ip = socket.clientIp;
  if (!sessionId || !userId) return;

  let socketsForSession = sessionSockets.get(sessionId);
  if (!socketsForSession) {
    socketsForSession = new Set();
    sessionSockets.set(sessionId, socketsForSession);
  }
  socketsForSession.add(socket.id);

  let sessionsForUser = userSessions.get(userId);
  if (!sessionsForUser) {
    sessionsForUser = new Set();
    userSessions.set(userId, sessionsForUser);
  }
  sessionsForUser.add(sessionId);

  if (!ip) return;

  let socketsForIp = ipSockets.get(ip);
  if (!socketsForIp) {
    socketsForIp = new Set();
    ipSockets.set(ip, socketsForIp);
  }
  socketsForIp.add(socket.id);
}

function untrackSessionSocket(socket) {
  const sessionId = socket.sessionId;
  const userId = socket.user?.id;
  const ip = socket.clientIp;
  if (!sessionId || !userId) return;

  const sockets = sessionSockets.get(sessionId);
  if (sockets) {
    sockets.delete(socket.id);
    if (sockets.size === 0) {
      sessionSockets.delete(sessionId);
    }
  }

  if (ip) {
    const socketsForIp = ipSockets.get(ip);
    if (socketsForIp) {
      socketsForIp.delete(socket.id);
      if (socketsForIp.size === 0) {
        ipSockets.delete(ip);
      }
    }
  }

  if (sessionSockets.has(sessionId)) {
    return;
  }

  const sessions = userSessions.get(userId);
  if (!sessions) return;
  sessions.delete(sessionId);
  if (sessions.size === 0) {
    userSessions.delete(userId);
  }
}

function subscribeSocketToMint(socket, mint) {
  const socketMints = ensureSocketSubscriptions(socket);
  if (socketMints.has(mint)) return false;

  const maxSubscriptionsPerSocket = Math.max(1, Number(config.security?.socket?.maxSubscriptionsPerSocket) || 80);
  if (socketMints.size >= maxSubscriptionsPerSocket) {
    logSecurityEvent('socket_subscription_limit_reached', {
      socketId: socket.id,
      userId: socket.user?.id,
      sessionId: socket.sessionId,
      ip: socket.clientIp,
      currentSubscriptions: socketMints.size,
      attemptedMint: mint,
      limit: maxSubscriptionsPerSocket,
    });
    return false;
  }

  socketMints.add(mint);

  let subscribers = mintSubscribers.get(mint);
  if (!subscribers) {
    subscribers = new Set();
    mintSubscribers.set(mint, subscribers);
  }

  subscribers.add(socket.id);
  if (subscribers.size === 1) {
    pumpfun.subscribeToken(mint);
  }

  return true;
}

function unsubscribeSocketFromMint(socket, mint) {
  const socketMints = socketSubscriptions.get(socket.id);
  if (socketMints) {
    socketMints.delete(mint);
    if (socketMints.size === 0) {
      socketSubscriptions.delete(socket.id);
    }
  }

  const subscribers = mintSubscribers.get(mint);
  if (!subscribers) return false;

  subscribers.delete(socket.id);
  if (subscribers.size === 0) {
    mintSubscribers.delete(mint);
    pumpfun.unsubscribeToken(mint);
    return true;
  }

  return false;
}

function clearMintSubscriptions(mint) {
  const subscribers = mintSubscribers.get(mint);
  if (!subscribers) return;

  for (const socketId of subscribers) {
    const socketMints = socketSubscriptions.get(socketId);
    if (!socketMints) continue;
    socketMints.delete(mint);
    if (socketMints.size === 0) {
      socketSubscriptions.delete(socketId);
    }
  }

  mintSubscribers.delete(mint);
}

function cleanupSocketSubscriptions(socket) {
  const socketMints = socketSubscriptions.get(socket.id);
  if (!socketMints || socketMints.size === 0) {
    socketSubscriptions.delete(socket.id);
    return;
  }

  for (const mint of Array.from(socketMints)) {
    unsubscribeSocketFromMint(socket, mint);
  }
}

function emitAndDisconnectSockets(socketIds, reason) {
  if (!io || socketIds.size === 0) return 0;

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    socket.emit('auth:revoked', { reason });
    setTimeout(() => {
      try {
        socket.disconnect(true);
      } catch (_) {}
    }, 25);
  }

  return socketIds.size;
}

function revokeSessionSockets(sessionId, reason = 'session_revoked') {
  if (!io) return 0;
  const sockets = sessionSockets.get(sessionId);
  if (!sockets || sockets.size === 0) return 0;

  return emitAndDisconnectSockets(new Set(sockets), reason);
}

function revokeUserSockets(userId, reason = 'session_revoked') {
  if (!io) return 0;
  const sessions = userSessions.get(userId);
  if (!sessions || sessions.size === 0) return 0;

  const socketIds = new Set();
  for (const sessionId of Array.from(sessions)) {
    const sockets = sessionSockets.get(sessionId);
    if (!sockets) continue;
    for (const socketId of sockets) {
      socketIds.add(socketId);
    }
  }

  return emitAndDisconnectSockets(socketIds, reason);
}

async function sweepAccessEligibility() {
  if (!io || userSessions.size === 0) {
    return;
  }

  for (const userId of Array.from(userSessions.keys())) {
    try {
      const user = await User.findById(userId);
      if (!user || !user.is_active) {
        revokeUserSockets(userId, 'account_deactivated');
        continue;
      }

      const access = userAccess.buildAccessSnapshot(user);
      if (!access.hasProductAccess) {
        revokeUserSockets(userId, access.denialCode || 'access_inactive');
      }
    } catch (err) {
      console.error('Socket access sweep error:', err.message);
    }
  }
}

function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: Math.max(1024, Number(config.security?.socket?.maxHttpBufferSize) || 16384),
  });

  io.use(async (socket, next) => {
    const origin = socket.handshake.headers?.origin || null;
    const clientIp = getSocketClientIp(socket);

    if (!isAllowedOrigin(origin)) {
      logSecurityEvent('socket_origin_rejected', {
        origin,
        ip: clientIp,
      });
      return next(new Error('Origin not allowed'));
    }

    const authToken = socket.handshake.auth?.token;
    const parsedCookies = cookie.parse(socket.handshake.headers?.cookie || '');
    const cookieToken = parsedCookies[config.authCookie.name];
    const token = cookieToken || (config.nodeEnv === 'test' ? authToken : null);
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      const sessionValid = await Session.isValid(token);
      if (!sessionValid) {
        return next(new Error('Session expired or revoked'));
      }

      const user = await User.findById(decoded.userId);
      if (!user || !user.is_active) {
        return next(new Error('User not found or deactivated'));
      }

      const access = userAccess.buildAccessSnapshot(user);
      if (!access.hasProductAccess) {
        return next(new Error(access.denialReason || 'Access inactive'));
      }

      const sessionId = Session.getSessionIdentity(token, decoded);
      const maxConnectionsPerIp = Math.max(1, Number(config.security?.socket?.maxConnectionsPerIp) || 12);
      const maxSocketsPerSession = Math.max(1, Number(config.security?.socket?.maxSocketsPerSession) || 4);
      const activeSocketsForIp = clientIp ? ipSockets.get(clientIp) : null;
      const activeSocketsForSession = sessionSockets.get(sessionId);

      if (clientIp && activeSocketsForIp && activeSocketsForIp.size >= maxConnectionsPerIp) {
        logSecurityEvent('socket_connection_limit_per_ip', {
          ip: clientIp,
          userId: user.id,
          activeConnections: activeSocketsForIp.size,
          limit: maxConnectionsPerIp,
        });
        return next(new Error('Too many active socket connections'));
      }

      if (activeSocketsForSession && activeSocketsForSession.size >= maxSocketsPerSession) {
        logSecurityEvent('socket_connection_limit_per_session', {
          ip: clientIp,
          userId: user.id,
          sessionId,
          activeConnections: activeSocketsForSession.size,
          limit: maxSocketsPerSession,
        });
        return next(new Error('Too many active sockets for this session'));
      }

      socket.user = user;
      socket.token = token;
      socket.sessionId = sessionId;
      socket.clientIp = clientIp;
      next();
    } catch (err) {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`[Socket.io] ${socket.user.username} connected (${socket.id})`);
    ensureSocketSubscriptions(socket);
    trackSessionSocket(socket);

    socket.emit('sol:price', { price: solPrice.getPrice() });
    socket.emit('pump:status', pumpfun.getStatus());

    socket.on('pump:subscribe', (data) => {
      if (!noteSocketAction(socket, 'pump:subscribe')) return;
      const mint = sanitizeMint(data?.mint);
      if (!mint) return;
      subscribeSocketToMint(socket, mint);
    });

    socket.on('pump:unsubscribe', (data) => {
      if (!noteSocketAction(socket, 'pump:unsubscribe')) return;
      const mint = sanitizeMint(data?.mint);
      if (!mint) return;
      unsubscribeSocketFromMint(socket, mint);
    });

    socket.on('disconnect', (reason) => {
      cleanupSocketSubscriptions(socket);
      untrackSessionSocket(socket);
      socketActionState.delete(socket.id);
      console.log(`[Socket.io] ${socket.user.username} disconnected (${reason})`);
    });
  });

  startServices();
  console.log('[Socket.io] Initialized');
  return io;
}

function startServices() {
  solPrice.start();

  solPriceTimer = setInterval(() => {
    if (io) {
      io.emit('sol:price', { price: solPrice.getPrice() });
    }
  }, SOL_PRICE_BROADCAST_INTERVAL);

  accessSweepTimer = setInterval(() => {
    void sweepAccessEligibility();
  }, ACCESS_SWEEP_INTERVAL);

  pumpfun.start((event) => {
    if (!io) return;

    switch (event.type) {
      case 'newToken': {
        io.emit('pump:newToken', event.data);
        break;
      }
      case 'trade': {
        io.emit('pump:trade', event.data);
        break;
      }
      case 'migrate': {
        const catalogToken = buildCatalogTokenFromPump(event.data);
        if (catalogToken) {
          queueCatalogUpsert(catalogToken, 'pumpfun-migrated');
        }
        if (event.data?.mint) {
          clearMintSubscriptions(event.data.mint);
        }
        io.emit('pump:migrate', event.data);
        break;
      }
      case 'status':
        io.emit('pump:status', event.data);
        break;
    }
  });
}

function stop() {
  if (solPriceTimer) {
    clearInterval(solPriceTimer);
    solPriceTimer = null;
  }
  if (accessSweepTimer) {
    clearInterval(accessSweepTimer);
    accessSweepTimer = null;
  }
  solPrice.stop();
  pumpfun.stop();
  socketSubscriptions.clear();
  mintSubscribers.clear();
  sessionSockets.clear();
  userSessions.clear();
  ipSockets.clear();
  socketActionState.clear();
  if (io) {
    io.close();
    io = null;
  }
}

function getStatus() {
  return {
    clients: io ? io.engine.clientsCount : 0,
    trackedPumpSubscriptions: mintSubscribers.size,
    trackedAuthenticatedUsers: userSessions.size,
    trackedAuthenticatedSessions: sessionSockets.size,
    trackedClientIps: ipSockets.size,
    trackedSocketActionWindows: socketActionState.size,
    pumpfun: pumpfun.getStatus(),
    solPrice: solPrice.getStatus(),
  };
}

function getIO() {
  return io;
}

module.exports = { init, stop, getStatus, getIO, revokeSessionSockets, revokeUserSockets };
