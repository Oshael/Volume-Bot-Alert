/**
 * Socket.io Hub
 * Authenticates clients via JWT, distributes real-time data.
 *
 * Events sent to clients:
 * - pump:newToken     — new token created on PumpFun
 * - pump:trade        — trade event on subscribed token
 * - pump:migrate      — token migrated to DEX
 * - pump:status       — PumpFun connection status
 * - sol:price         — SOL/USD price update
 * - dex:tokenData     — DexScreener data for requested token
 *
 * Events received from clients:
 * - dex:subscribe     — { address } — request DexScreener data for a token
 * - pump:subscribe    — { mint }    — subscribe to a specific PumpFun token
 * - pump:unsubscribe  — { mint }    — unsubscribe from a PumpFun token
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const Session = require('../models/session');
const User = require('../models/user');
const solPrice = require('./sol-price');
const pumpfun = require('./pumpfun-ws');
const dexscreener = require('./dexscreener');

let io = null;
let solPriceTimer = null;

const SOL_PRICE_BROADCAST_INTERVAL = 30000; // broadcast price every 30s

/**
 * Initialize Socket.io on the HTTP server.
 * @param {http.Server} httpServer
 */
function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ---- JWT Authentication middleware ----
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, config.jwt.secret);

      // Validate session in DB
      const sessionValid = await Session.isValid(token);
      if (!sessionValid) {
        return next(new Error('Session expired or revoked'));
      }

      // Check user exists and is active
      const user = await User.findById(decoded.userId);
      if (!user || !user.is_active) {
        return next(new Error('User not found or deactivated'));
      }

      socket.user = user;
      socket.token = token;
      next();
    } catch (err) {
      return next(new Error('Invalid token'));
    }
  });

  // ---- Connection handler ----
  io.on('connection', (socket) => {
    console.log(`[Socket.io] ${socket.user.username} connected (${socket.id})`);

    // Send current SOL price immediately
    socket.emit('sol:price', { price: solPrice.getPrice() });

    // Send PumpFun status
    socket.emit('pump:status', pumpfun.getStatus());

    // ---- Client requests DexScreener data for a token ----
    socket.on('dex:subscribe', async (data) => {
      if (!data?.address || typeof data.address !== 'string') return;

      // Sanitize: only allow alphanumeric addresses
      const address = data.address.replace(/[^a-zA-Z0-9]/g, '');
      if (address.length < 20 || address.length > 64) return;

      try {
        const result = await dexscreener.getTokenPairs(address);
        if (result) {
          socket.emit('dex:tokenData', { address, data: result });
        }
      } catch (err) {
        console.error(`[Socket.io] DexScreener error for ${address}:`, err.message);
      }
    });

    // ---- Client subscribes to a PumpFun token ----
    socket.on('pump:subscribe', (data) => {
      if (!data?.mint || typeof data.mint !== 'string') return;
      const mint = data.mint.replace(/[^a-zA-Z0-9]/g, '');
      if (mint.length < 20 || mint.length > 64) return;
      pumpfun.subscribeToken(mint);
    });

    // ---- Client unsubscribes from a PumpFun token ----
    socket.on('pump:unsubscribe', (data) => {
      if (!data?.mint || typeof data.mint !== 'string') return;
      const mint = data.mint.replace(/[^a-zA-Z0-9]/g, '');
      pumpfun.unsubscribeToken(mint);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket.io] ${socket.user.username} disconnected (${reason})`);
    });
  });

  // ---- Start services ----
  startServices();

  console.log('[Socket.io] Initialized');
  return io;
}

function startServices() {
  // Start SOL price polling
  solPrice.start();

  // Broadcast SOL price to all clients periodically
  solPriceTimer = setInterval(() => {
    if (io) {
      io.emit('sol:price', { price: solPrice.getPrice() });
    }
  }, SOL_PRICE_BROADCAST_INTERVAL);

  // Start PumpFun WebSocket with event handler
  pumpfun.start((event) => {
    if (!io) return;

    switch (event.type) {
      case 'newToken':
        io.emit('pump:newToken', event.data);
        break;
      case 'trade':
        io.emit('pump:trade', event.data);
        break;
      case 'migrate':
        io.emit('pump:migrate', event.data);
        break;
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
  if (io) {
    io.close();
    io = null;
  }
}

function getStatus() {
  return {
    clients: io ? io.engine.clientsCount : 0,
    pumpfun: pumpfun.getStatus(),
    solPrice: solPrice.getStatus(),
  };
}

/**
 * Get the Socket.io instance (for use in other modules).
 */
function getIO() {
  return io;
}

module.exports = { init, stop, getStatus, getIO };
