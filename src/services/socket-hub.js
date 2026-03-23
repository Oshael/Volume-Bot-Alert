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
const solPrice = require('./sol-price');
const pumpfun = require('./pumpfun-ws');
const tokenCatalog = require('../models/token-catalog');

let io = null;
let solPriceTimer = null;

const SOL_PRICE_BROADCAST_INTERVAL = 30000;
const socketSubscriptions = new Map();
const mintSubscribers = new Map();
const sessionSockets = new Map();
const userSessions = new Map();

function sanitizeMint(rawMint) {
  if (typeof rawMint !== 'string') return null;
  const mint = rawMint.replace(/[^a-zA-Z0-9]/g, '');
  if (mint.length < 20 || mint.length > 64) return null;
  return mint;
}

function queueCatalogUpsert(token, source = 'unknown') {
  Promise.resolve()
    .then(() => tokenCatalog.upsertToken({ ...token, source }))
    .catch((err) => {
      const address = token?.address || token?.mint || 'unknown';
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

function trackSessionSocket(socket) {
  const sessionId = socket.sessionId;
  const userId = socket.user?.id;
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
}

function untrackSessionSocket(socket) {
  const sessionId = socket.sessionId;
  const userId = socket.user?.id;
  if (!sessionId || !userId) return;

  const sockets = sessionSockets.get(sessionId);
  if (sockets) {
    sockets.delete(socket.id);
    if (sockets.size === 0) {
      sessionSockets.delete(sessionId);
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

function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use(async (socket, next) => {
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

      socket.user = user;
      socket.token = token;
      socket.sessionId = Session.getSessionIdentity(token, decoded);
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
      const mint = sanitizeMint(data?.mint);
      if (!mint) return;
      subscribeSocketToMint(socket, mint);
    });

    socket.on('pump:unsubscribe', (data) => {
      const mint = sanitizeMint(data?.mint);
      if (!mint) return;
      unsubscribeSocketFromMint(socket, mint);
    });

    socket.on('disconnect', (reason) => {
      cleanupSocketSubscriptions(socket);
      untrackSessionSocket(socket);
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
  solPrice.stop();
  pumpfun.stop();
  socketSubscriptions.clear();
  mintSubscribers.clear();
  sessionSockets.clear();
  userSessions.clear();
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
    pumpfun: pumpfun.getStatus(),
    solPrice: solPrice.getStatus(),
  };
}

function getIO() {
  return io;
}

module.exports = { init, stop, getStatus, getIO, revokeSessionSockets, revokeUserSockets };
