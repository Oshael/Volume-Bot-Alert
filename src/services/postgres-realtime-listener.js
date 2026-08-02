const DEFAULT_RECONNECT_DELAY_MS = 5 * 1000;

function formatError(error, fallback) {
  return error?.message || String(error || fallback);
}

function createPostgresRealtimeListener(deps = {}) {
  const channel = String(deps.channel || '').trim();
  if (!channel) throw new Error('PostgreSQL listener channel is required');

  const label = String(deps.label || 'PostgresRealtimeListener').trim();
  const logger = deps.logger || console;
  let options = {};
  let currentListener = null;
  let connectPromise = null;
  let reconnectTimer = null;
  let running = false;
  let listening = false;
  let lastError = null;
  let successfulReconnects = 0;

  function detach(current) {
    current.client.off?.('notification', current.onNotification);
    current.client.off?.('error', current.onError);
    current.client.off?.('end', current.onEnd);
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    const schedule = options.setTimeoutFn || deps.setTimeoutFn || setTimeout;
    const delayMs = Math.max(
      1,
      Number(options.reconnectDelayMs || deps.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS,
    );
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      void connect(true).catch((error) => {
        lastError = formatError(error, 'Unknown listener error');
        logger.error?.(`[${label}] reconnect failed:`, lastError);
        scheduleReconnect();
      });
    }, delayMs);
    reconnectTimer.unref?.();
  }

  function disconnect(current, error = null) {
    if (currentListener !== current) return;
    currentListener = null;
    listening = false;
    detach(current);
    try {
      current.client.release?.(error || undefined);
    } catch (_) {}

    const connectionError = error || new Error('listener connection ended unexpectedly');
    lastError = formatError(connectionError, 'Unknown listener error');
    deps.onConnectionError?.(connectionError);
    logger.error?.(`[${label}] listener error:`, lastError);
    scheduleReconnect();
  }

  async function openConnection(isReconnect) {
    const pool = options.pool || deps.pool;
    if (!pool || typeof pool.connect !== 'function') {
      throw new Error('PostgreSQL listener pool is required');
    }

    const client = await pool.connect();
    if (!running) {
      client.release?.();
      return getStatus();
    }

    const current = { client, onNotification: null, onError: null, onEnd: null };
    current.onNotification = (message) => deps.onNotification?.(message, options);
    current.onError = (error) => disconnect(current, error);
    current.onEnd = () => disconnect(current);
    client.on('notification', current.onNotification);
    client.on('error', current.onError);
    client.on('end', current.onEnd);
    currentListener = current;

    try {
      await client.query(`LISTEN ${channel}`);
    } catch (error) {
      disconnect(current, error);
      throw error;
    }
    if (!running || currentListener !== current) return getStatus();

    listening = true;
    lastError = null;
    if (isReconnect) successfulReconnects += 1;
    deps.onConnected?.({ isReconnect });
    logger.log?.(`[${label}] Listening on ${channel}`);
    return getStatus();
  }

  async function connect(isReconnect = false) {
    if (!running || currentListener) return getStatus();
    if (connectPromise) return connectPromise;
    connectPromise = openConnection(isReconnect);
    try {
      return await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  async function start(startOptions = {}) {
    if (!running) {
      running = true;
      options = startOptions;
    }
    try {
      return await connect(false);
    } catch (error) {
      lastError = formatError(error, 'Unknown listener error');
      scheduleReconnect();
      throw error;
    }
  }

  async function stop() {
    running = false;
    const cancel = options.clearTimeoutFn || deps.clearTimeoutFn || clearTimeout;
    if (reconnectTimer) cancel(reconnectTimer);
    reconnectTimer = null;
    const current = currentListener;
    currentListener = null;
    listening = false;
    if (!current) return;

    detach(current);
    try {
      await current.client.query(`UNLISTEN ${channel}`);
    } catch (_) {}
    current.client.release?.();
  }

  function getStatus() {
    return {
      channel,
      running,
      listening,
      reconnectScheduled: Boolean(reconnectTimer),
      successfulReconnects,
      lastError,
    };
  }

  return { getStatus, start, stop };
}

module.exports = {
  DEFAULT_RECONNECT_DELAY_MS,
  createPostgresRealtimeListener,
};
