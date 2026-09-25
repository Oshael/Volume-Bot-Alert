const DEFAULT_RECONNECT_DELAY_MS = 5000;
const hubs = new WeakMap();

function createHub(pool, timers) {
  const subscribers = new Set();
  let connection = null;
  let reconnectTimer = null;
  let tail = Promise.resolve();

  function serialize(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  }

  function notifyFailure(error) {
    for (const sub of subscribers) {
      sub.listening = false;
      sub.lastError = error.message || String(error);
      try { sub.onConnectionError?.(error); } catch (_) {}
      try { sub.logger.error?.(`[${sub.label}] listener error:`, sub.lastError); } catch (_) {}
    }
  }

  function scheduleReconnect() {
    if (!subscribers.size || reconnectTimer) return;
    reconnectTimer = timers.setTimeoutFn(() => {
      reconnectTimer = null;
      void serialize(() => connectAll(true)).catch(() => {});
    }, DEFAULT_RECONNECT_DELAY_MS);
    reconnectTimer?.unref?.();
  }

  function detach(current) {
    current.client.off?.('notification', current.onNotification);
    current.client.off?.('error', current.onError);
    current.client.off?.('end', current.onEnd);
  }

  function drop(current, error) {
    if (connection !== current) return;
    connection = null;
    detach(current);
    try { current.client.release?.(error); } catch (_) {}
    notifyFailure(error);
    scheduleReconnect();
  }

  function markConnected(sub, isReconnect) {
    if (!sub.running || sub.listening) return;
    sub.listening = true;
    sub.lastError = null;
    if (isReconnect) sub.successfulReconnects += 1;
    try { sub.onConnected?.({ isReconnect }); } catch (_) {}
    try { sub.logger.log?.(`[${sub.label}] Listening on ${sub.channel}`); } catch (_) {}
  }

  async function connectAll(isReconnect) {
    if (!subscribers.size || connection) return;
    let client;
    try {
      client = await pool.connect();
      if (!subscribers.size) { client.release?.(); return; }
      const current = { client, channels: new Set(), onNotification: null,
        onError: null, onEnd: null };
      current.onNotification = (message) => {
        for (const sub of subscribers) {
          if (sub.running && sub.listening && sub.channel === message.channel) {
            try { sub.onNotification?.(message, sub.options); } catch (error) {
              try { sub.logger.error?.(`[${sub.label}] notification failed:`, error); } catch (_) {}
            }
          }
        }
      };
      current.onError = (error) => drop(current, error);
      current.onEnd = () => drop(current, new Error('listener connection ended unexpectedly'));
      client.on('notification', current.onNotification);
      client.on('error', current.onError);
      client.on('end', current.onEnd);
      connection = current;
      for (const channel of new Set([...subscribers].map((sub) => sub.channel))) {
        await client.query(`LISTEN ${channel}`);
        if (connection !== current) return;
        current.channels.add(channel);
      }
      if (reconnectTimer) {
        timers.clearTimeoutFn(reconnectTimer);
        reconnectTimer = null;
      }
      for (const sub of subscribers) {
        if (current.channels.has(sub.channel)) markConnected(sub, isReconnect);
      }
    } catch (error) {
      if (connection) drop(connection, error);
      else { notifyFailure(error); scheduleReconnect(); }
      throw error;
    }
  }

  function subscribe(sub) {
    subscribers.add(sub);
    return serialize(async () => {
      if (!sub.running || reconnectTimer) return;
      await connectAll(false);
      if (!sub.running || !connection) return;
      if (!connection.channels.has(sub.channel)) {
        try {
          await connection.client.query(`LISTEN ${sub.channel}`);
          connection.channels.add(sub.channel);
        } catch (error) { drop(connection, error); throw error; }
      }
      markConnected(sub, false);
    });
  }

  function unsubscribe(sub) {
    subscribers.delete(sub);
    sub.listening = false;
    return serialize(async () => {
      if (!subscribers.size && reconnectTimer) {
        timers.clearTimeoutFn(reconnectTimer);
        reconnectTimer = null;
      }
      const current = connection;
      if (!current) return;
      if (!subscribers.size) {
        connection = null;
        detach(current);
        let releaseError;
        try { await current.client.query('UNLISTEN *'); } catch (error) { releaseError = error; }
        try { current.client.release?.(releaseError); } catch (_) {}
      } else if (![...subscribers].some((item) => item.channel === sub.channel)
          && current.channels.has(sub.channel)) {
        try {
          await current.client.query(`UNLISTEN ${sub.channel}`);
          current.channels.delete(sub.channel);
        } catch (error) { drop(current, error); }
      }
    });
  }

  return { subscribe, unsubscribe, reconnectScheduled: () => Boolean(reconnectTimer) };
}

function createSharedPostgresRealtimeListener(deps = {}) {
  const pool = deps.pool;
  const channel = String(deps.channel || '').trim();
  if (!pool || typeof pool.connect !== 'function') throw new Error('Shared listener pool is required');
  if (!/^[a-z_][a-z_0-9]*$/i.test(channel)) throw new Error('Invalid shared listener channel');
  let hub = hubs.get(pool);
  if (!hub) {
    hub = createHub(pool, { setTimeoutFn: deps.setTimeoutFn || setTimeout,
      clearTimeoutFn: deps.clearTimeoutFn || clearTimeout });
    hubs.set(pool, hub);
  }
  const sub = { channel, label: deps.label || 'PostgresRealtimeListener',
    logger: deps.logger || console, onNotification: deps.onNotification,
    onConnected: deps.onConnected, onConnectionError: deps.onConnectionError,
    options: {}, running: false, listening: false, lastError: null, successfulReconnects: 0 };
  return {
    async start(options = {}) {
      if (sub.running) return this.getStatus();
      sub.options = options;
      sub.running = true;
      await hub.subscribe(sub);
      return this.getStatus();
    },
    async stop() {
      if (!sub.running) return;
      sub.running = false;
      await hub.unsubscribe(sub);
    },
    getStatus() {
      return { channel, running: sub.running, listening: sub.listening,
        reconnectScheduled: hub.reconnectScheduled(),
        successfulReconnects: sub.successfulReconnects, lastError: sub.lastError };
    },
  };
}

module.exports = { createSharedPostgresRealtimeListener };
