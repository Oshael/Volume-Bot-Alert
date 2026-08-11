/**
 * Socket.io Hub
 * Authenticates clients via the backend session token, distributes real-time data.
 *
 * Events sent to clients:
 * - alert:event       - backend-owned alert event payload
 * - auth:revoked      - session revoked; client must logout
 * - market:bucket     - live market bucket update for subscribed token charts
 * - market:trade      - live Robinhood swap for an explicitly watched trades panel
 * - holder:count      - sequenced Robinhood holder count for a subscribed token
 * - holder:invalidate - holder count must be refreshed after a reorg
 *
 * Events received from clients:
 * - live:presence     - { workspace, mode, hiddenGraceMs? } - live alert presence
 * - market:subscribe  - { chain, address } - subscribe to token market bucket updates
 * - market:unsubscribe - { chain, address } - unsubscribe from token market bucket updates
 *   Legacy { address } input is interpreted as Solana only during migration.
 */

const { Server } = require('socket.io');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const os = require('os');
const config = require('../../config');
const Session = require('../models/session');
const User = require('../models/user');
const userAccess = require('../models/user-access');
const solPrice = require('./sol-price');
const pumpfun = require('./pumpfun-ws');
const pumpfunPreMigrationCapture = require('./pumpfun-pre-migration-capture');
const tokenCatalog = require('../models/token-catalog');
const userAlertProfileCache = require('./user-alert-profile-cache');
const { getSocketClientIp, isAllowedOrigin } = require('../utils/request-security');
const { logSecurityEvent } = require('../utils/security-events');
const { logTrace } = require('../utils/pump-migrate-trace');
const { createTokenIdentity } = require('../utils/token-identity');
const { isTokenChainUserVisible } = require('../utils/token-chain-availability');
const {
  normalizeRobinhoodHolderRealtimeEvent,
} = require('./robinhood-holder-count-event');

let io = null;
let accessSweepTimer = null;

const ACCESS_SWEEP_INTERVAL = 60000;
const WEB_INSTANCE_ID = String(
  process.env.WEB_INSTANCE_ID
  || process.env.INSTANCE_ID
  || `${os.hostname()}:${process.pid}`
).trim();
const sessionSockets = new Map();
const userSessions = new Map();
const ipSockets = new Map();
const socketActionState = new Map();

function createMarketSubscriptionProtocolTelemetry(now = Date.now()) {
  return {
    observedSince: new Date(now).toISOString(),
    canonicalRequests: 0,
    legacyAddressOnlyRequests: 0,
    lastCanonicalAt: null,
    lastLegacyAddressOnlyAt: null,
  };
}

const marketSubscriptionProtocolTelemetry = createMarketSubscriptionProtocolTelemetry();

function recordMarketSubscriptionProtocolUsage(telemetry, payload, now = Date.now()) {
  const entries = Array.isArray(payload?.subscriptions) ? payload.subscriptions : [payload];
  const identities = entries.filter((entry) => (
    entry && typeof entry === 'object' && String(entry.address ?? '').trim()
  ));
  const observedAt = new Date(now).toISOString();
  if (identities.some((entry) => String(entry.chain ?? '').trim())) {
    telemetry.canonicalRequests += 1;
    telemetry.lastCanonicalAt = observedAt;
  }
  if (identities.some((entry) => !String(entry.chain ?? '').trim())) {
    telemetry.legacyAddressOnlyRequests += 1;
    telemetry.lastLegacyAddressOnlyAt = observedAt;
  }
  return telemetry;
}

function getUserRoom(userId) {
  const normalizedUserId = Number.parseInt(String(userId || '').trim(), 10);
  return Number.isInteger(normalizedUserId) && normalizedUserId > 0
    ? `user:${normalizedUserId}`
    : null;
}

function resolveMarketIdentity(payload, options = {}) {
  const explicitChain = String(payload?.chain ?? '').trim();
  const chain = explicitChain || (options.allowLegacySolana ? 'solana' : null);
  if (!chain) return null;
  try {
    return createTokenIdentity(chain, payload?.address);
  } catch (_) {
    return null;
  }
}

function getMarketRoom(identity) {
  return identity?.key ? `market:${identity.key}` : null;
}

function getMarketTradeRoom(identity) {
  return identity?.chain === 'robinhood' && identity.key
    ? `market-trade:${identity.key}` : null;
}

function getMarketTradeSubscriptionRooms(payload, options = {}) {
  if (!Array.isArray(payload?.subscriptions)) return null;
  const rooms = new Set();
  for (const subscription of payload.subscriptions) {
    const identity = resolveMarketIdentity(subscription);
    const room = isTokenChainUserVisible(identity?.chain, options.config || config)
      ? getMarketTradeRoom(identity) : null;
    if (!room) return null;
    rooms.add(room);
  }
  return rooms;
}

function getMarketSubscriptionRoom(payload, options = {}) {
  const identity = resolveMarketIdentity(payload, { allowLegacySolana: true });
  const runtimeConfig = options.config || config;
  return isTokenChainUserVisible(identity?.chain, runtimeConfig) ? getMarketRoom(identity) : null;
}

function getMarketSubscriptionRooms(payload, options = {}) {
  if (!Array.isArray(payload?.subscriptions)) return null;
  const rooms = new Set();
  for (const subscription of payload.subscriptions) {
    const room = getMarketSubscriptionRoom(subscription, options);
    if (!room) return null;
    rooms.add(room);
  }
  return rooms;
}

function normalizeMarketBucketUpdate(payload) {
  const identity = resolveMarketIdentity(payload);
  const bucketTsValue = payload?.bucketTs || payload?.candle?.bucketTs;
  const bucketTsMs = new Date(bucketTsValue || '').getTime();
  const sequence = String(payload?.sequence ?? '').trim();
  if (!identity || !Number.isFinite(bucketTsMs) || !sequence) {
    return null;
  }
  return {
    ...payload,
    type: 'market:bucket',
    chain: identity.chain,
    address: identity.address,
    bucketTs: new Date(bucketTsMs).toISOString(),
    sequence,
  };
}

function normalizeMarketTradeUpdate(payload) {
  const identity = resolveMarketIdentity(payload);
  const blockTimeMs = Date.parse(String(payload?.blockTime || ''));
  const transactionHash = String(payload?.transactionHash || '').toLowerCase();
  const walletAddress = String(payload?.walletAddress || '').toLowerCase();
  const actionIndex = Number(payload?.actionIndex);
  const blockNumber = Number(payload?.blockNumber);
  const side = String(payload?.side || '');
  const valid = [
    identity?.chain === 'robinhood',
    Number.isFinite(blockTimeMs),
    /^0x[0-9a-f]{64}$/.test(transactionHash),
    /^0x[0-9a-f]{40}$/.test(walletAddress),
    Number.isSafeInteger(actionIndex) && actionIndex >= 0,
    Number.isSafeInteger(blockNumber) && blockNumber >= 0,
    ['buy', 'sell'].includes(side),
  ].every(Boolean);
  if (!valid) return null;
  const numeric = (value) => (value == null || value === '' ? null : Number(value));
  const event = {
    ...payload, type: 'market:trade', chain: identity.chain, address: identity.address,
    transactionHash, walletAddress, actionIndex, blockNumber, side,
    blockTime: new Date(blockTimeMs).toISOString(),
    amountUsd: numeric(payload.amountUsd), priceUsd: numeric(payload.priceUsd),
    mcUsd: numeric(payload.mcUsd),
  };
  return [event.amountUsd, event.priceUsd, event.mcUsd]
    .every((value) => value == null || Number.isFinite(value)) ? event : null;
}

function sanitizeMint(rawMint) {
  if (typeof rawMint !== 'string') return null;
  const mint = rawMint.replace(/[^a-zA-Z0-9]/g, '');
  if (mint.length < 20 || mint.length > 64) return null;
  return mint;
}

function getSocketMarketRooms(socket) {
  if (!socket.marketRooms) {
    socket.marketRooms = new Set();
  }
  return socket.marketRooms;
}

function enqueueSharedPresenceWrite(socket, operation, context = {}) {
  const previous = socket.sharedPresenceWrite || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(operation)
    .catch((error) => {
      logSecurityEvent(context.event || 'socket_shared_presence_write_failed', {
        socketId: socket.id,
        userId: socket.user?.id,
        sessionId: socket.sessionId,
        ip: socket.clientIp,
        error: error.message,
      });
    });

  socket.sharedPresenceWrite = next;
  return next;
}

function enqueueAlertBacklogReplay(socket, trigger) {
  const backendAlertReplay = require('./backend-alert-replay');
  return backendAlertReplay.replayForSocket(socket, { trigger });
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

      const access = await userAccess.buildResolvedAccessSnapshot(user);
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
    maxHttpBufferSize: Math.max(1024, Number(config.security?.socket?.maxHttpBufferSize) || 65536),
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

      const access = await userAccess.buildResolvedAccessSnapshot(user);
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
    } catch (_err) {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`[Socket.io] ${socket.user.username} connected (${socket.id})`);
    trackSessionSocket(socket);
    const userRoom = getUserRoom(socket.user?.id);
    if (userRoom) {
      socket.join(userRoom);
    }
    void enqueueAlertBacklogReplay(socket, 'connect');

    socket.on('live:presence', (data) => {
      if (!noteSocketAction(socket, 'live:presence')) return;
      try {
        const presence = userAlertProfileCache.upsertLivePresence(socket.user.id, socket.id, data);
        if (presence.mode === 'foreground') {
          void enqueueAlertBacklogReplay(socket, 'foreground');
        }
        enqueueSharedPresenceWrite(
          socket,
          () => userAlertProfileCache.upsertSharedLivePresence(socket.user.id, socket.id, data, {
            sessionKey: socket.sessionId,
            webInstanceId: WEB_INSTANCE_ID,
          }),
          { event: 'socket_shared_presence_upsert_failed' }
        );
      } catch (error) {
        logSecurityEvent('socket_live_presence_rejected', {
          socketId: socket.id,
          userId: socket.user?.id,
          sessionId: socket.sessionId,
          ip: socket.clientIp,
          error: error.message,
        });
      }
    });

    socket.on('market:subscribe', (data) => {
      if (!noteSocketAction(socket, 'market:subscribe')) return;
      recordMarketSubscriptionProtocolUsage(marketSubscriptionProtocolTelemetry, data);
      const room = getMarketSubscriptionRoom(data);
      if (!room) {
        logSecurityEvent('socket_market_subscribe_rejected', {
          socketId: socket.id,
          userId: socket.user?.id,
          sessionId: socket.sessionId,
          ip: socket.clientIp,
          error: 'invalid_address',
        });
        return;
      }

      const marketRooms = getSocketMarketRooms(socket);
      const maxSubscriptions = Math.max(1, Number(config.security?.socket?.maxSubscriptionsPerSocket) || 350);
      if (!marketRooms.has(room) && marketRooms.size >= maxSubscriptions) {
        logSecurityEvent('socket_subscription_limit_reached', {
          event: 'socket_subscription_limit_reached',
          socketId: socket.id,
          userId: socket.user?.id,
          sessionId: socket.sessionId,
          ip: socket.clientIp,
          maxSubscriptions,
        });
        return;
      }

      marketRooms.add(room);
      socket.join(room);
    });

    socket.on('market:unsubscribe', (data) => {
      if (!noteSocketAction(socket, 'market:unsubscribe')) return;
      recordMarketSubscriptionProtocolUsage(marketSubscriptionProtocolTelemetry, data);
      const room = getMarketSubscriptionRoom(data);
      if (!room) {
        return;
      }

      getSocketMarketRooms(socket).delete(room);
      socket.leave(room);
    });

    socket.on('market:sync', (data) => {
      if (!noteSocketAction(socket, 'market:sync')) return;
      recordMarketSubscriptionProtocolUsage(marketSubscriptionProtocolTelemetry, data);
      const nextRooms = getMarketSubscriptionRooms(data);
      const maxSubscriptions = Math.max(
        1,
        Number(config.security?.socket?.maxSubscriptionsPerSocket) || 350
      );
      if (!nextRooms || nextRooms.size > maxSubscriptions) {
        logSecurityEvent('socket_market_sync_rejected', {
          socketId: socket.id,
          userId: socket.user?.id,
          sessionId: socket.sessionId,
          ip: socket.clientIp,
          requestedSubscriptions: nextRooms?.size ?? null,
          maxSubscriptions,
        });
        return;
      }

      const currentRooms = getSocketMarketRooms(socket);
      for (const room of currentRooms) {
        if (!nextRooms.has(room)) socket.leave(room);
      }
      for (const room of nextRooms) {
        if (!currentRooms.has(room)) socket.join(room);
      }
      socket.marketRooms = nextRooms;
    });

    socket.on('market:trade:sync', (data) => {
      if (!noteSocketAction(socket, 'market:trade:sync')) return;
      const nextRooms = getMarketTradeSubscriptionRooms(data);
      const maxSubscriptions = Math.max(
        1, Number(config.security?.socket?.maxSubscriptionsPerSocket) || 350
      );
      if (!nextRooms || nextRooms.size > maxSubscriptions) return;
      const currentRooms = socket.marketTradeRooms || new Set();
      for (const room of currentRooms) if (!nextRooms.has(room)) socket.leave(room);
      for (const room of nextRooms) if (!currentRooms.has(room)) socket.join(room);
      socket.marketTradeRooms = nextRooms;
    });

    socket.on('disconnect', (reason) => {
      untrackSessionSocket(socket);
      userAlertProfileCache.clearLivePresence(socket.id);
      enqueueSharedPresenceWrite(
        socket,
        () => userAlertProfileCache.clearSharedLivePresence(socket.id, {
          webInstanceId: WEB_INSTANCE_ID,
        }),
        { event: 'socket_shared_presence_disconnect_failed' }
      );
      socketActionState.delete(socket.id);
      socket.marketRooms?.clear?.();
      socket.marketTradeRooms?.clear?.();
      console.log(`[Socket.io] ${socket.user.username} disconnected (${reason})`);
    });
  });

  startServices();
  console.log('[Socket.io] Initialized');
  return io;
}

function startServices() {
  solPrice.start();
  pumpfunPreMigrationCapture.start(config.pumpfunPreMigrationCapture);

  accessSweepTimer = setInterval(() => {
    void sweepAccessEligibility();
  }, ACCESS_SWEEP_INTERVAL);

  pumpfun.start((event) => {
    if (!io) return;

    if (event.type === 'create' || event.type === 'trade') {
      void pumpfunPreMigrationCapture.handleEvent(event).catch((err) => {
        console.error('[PumpFunPreMigration] Capture error:', err.message);
      });
      return;
    }

    if (event.type === 'migrate') {
      void pumpfunPreMigrationCapture.handleEvent(event).catch((err) => {
        console.error('[PumpFunPreMigration] Migration cleanup error:', err.message);
      });
      const catalogToken = buildCatalogTokenFromPump(event.data);
      if (catalogToken) {
        queueCatalogUpsert(catalogToken, 'pumpfun-migrated');
      }
    }
  }, config.pumpfunPreMigrationCapture);
}

function stop() {
  if (accessSweepTimer) {
    clearInterval(accessSweepTimer);
    accessSweepTimer = null;
  }
  solPrice.stop();
  pumpfun.stop();
  pumpfunPreMigrationCapture.stop();
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
    trackedPumpSubscriptions: 0,
    trackedAuthenticatedUsers: userSessions.size,
    trackedAuthenticatedSessions: sessionSockets.size,
    trackedClientIps: ipSockets.size,
    trackedSocketActionWindows: socketActionState.size,
    marketSubscriptionProtocol: { ...marketSubscriptionProtocolTelemetry },
    liveAlertPresence: userAlertProfileCache.getStatus(),
    pumpfun: pumpfun.getStatus(),
    pumpfunPreMigrationCapture: pumpfunPreMigrationCapture.getStatus(),
    solPrice: solPrice.getStatus(),
  };
}

function getIO() {
  return io;
}

function emitBackendAlertEvent(payload, options = {}) {
  if (!io || !payload || typeof payload !== 'object') {
    return false;
  }
  if (!isTokenChainUserVisible(payload.chain, config)) {
    return false;
  }

  const userRoom = getUserRoom(options.userId);
  if (userRoom) {
    const room = io.sockets.adapter.rooms.get(userRoom);
    if (!room || room.size === 0) {
      return false;
    }

    io.to(userRoom).emit('alert:event', payload);
    return true;
  }

  io.emit('alert:event', payload);
  return true;
}

function emitMarketBucketUpdate(payload) {
  if (!io || !payload || typeof payload !== 'object') {
    return false;
  }

  const event = normalizeMarketBucketUpdate(payload);
  const room = getMarketRoom(resolveMarketIdentity(event));
  if (!event || !room || !isTokenChainUserVisible(event.chain, config)) {
    return false;
  }

  const sockets = io.sockets.adapter.rooms.get(room);
  if (!sockets || sockets.size === 0) {
    return false;
  }

  io.to(room).emit('market:bucket', event);
  return true;
}

function emitMarketTradeUpdate(payload) {
  if (!io || !payload || typeof payload !== 'object') return false;
  const event = normalizeMarketTradeUpdate(payload);
  const room = getMarketTradeRoom(resolveMarketIdentity(event));
  if (!event || !room || !isTokenChainUserVisible(event.chain, config)) return false;
  const sockets = io.sockets.adapter.rooms.get(room);
  if (!sockets || sockets.size === 0) return false;
  io.to(room).emit('market:trade', event);
  return true;
}

function emitHolderUpdate(payload) {
  if (!io || !payload || typeof payload !== 'object') return false;
  const event = normalizeRobinhoodHolderRealtimeEvent(payload);
  const room = getMarketRoom(resolveMarketIdentity(event));
  if (!event || !room || !isTokenChainUserVisible('robinhood', config)) return false;
  const sockets = io.sockets.adapter.rooms.get(room);
  if (!sockets || sockets.size === 0) return false;
  io.to(room).emit(event.type, event);
  return true;
}

module.exports = {
  init,
  stop,
  getStatus,
  getIO,
  emitBackendAlertEvent,
  emitMarketBucketUpdate,
  emitMarketTradeUpdate,
  emitHolderUpdate,
  revokeSessionSockets,
  revokeUserSockets,
  __private: {
    createMarketSubscriptionProtocolTelemetry,
    getMarketRoom,
    getMarketTradeRoom,
    getMarketTradeSubscriptionRooms,
    getMarketSubscriptionRoom,
    getMarketSubscriptionRooms,
    normalizeMarketBucketUpdate,
    normalizeMarketTradeUpdate,
    recordMarketSubscriptionProtocolUsage,
    resolveMarketIdentity,
  },
};
