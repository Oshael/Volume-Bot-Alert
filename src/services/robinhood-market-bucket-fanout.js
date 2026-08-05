const socketHub = require('./socket-hub');
const marketBucketRealtime = require('./market-bucket-realtime');
const robinhoodLiveCatalogWorker = require('./robinhood-live-catalog-worker');
const robinhoodRealtimeAlertWorker = require('./robinhood-realtime-alert-worker');
const robinhoodMarketAggregateWorker = require('./robinhood-market-aggregate-worker');

// Single fan-out for one live market:bucket update. Both the ingestion monolith
// (commitMarketRange) and the robinhood-derived consumer (Corte 5, draining the
// derived outbox) call this, so the live board, socket relay, realtime alerts,
// live catalog and market aggregates behave identically no matter which process
// produced the update.
//
// Socket-first: if a local browser socket already received it, the pg_notify
// relay is skipped (no double publish); otherwise the payload is queued onto the
// relay for the web tier. The three in-memory workers are always fed. Returns
// whether any sink accepted the update.
function createRobinhoodMarketBucketFanout(deps = {}) {
  const hub = deps.socketHub || socketHub;
  const relay = deps.marketBucketRealtime || marketBucketRealtime;
  const liveCatalogWorker = deps.liveCatalogWorker || robinhoodLiveCatalogWorker;
  const realtimeAlertWorker = deps.realtimeAlertWorker || robinhoodRealtimeAlertWorker;
  const marketAggregateWorker = deps.marketAggregateWorker || robinhoodMarketAggregateWorker;

  return function emitMarketBucketUpdate(payload) {
    const socketEmitted = hub.emitMarketBucketUpdate(payload);
    const relayQueued = socketEmitted || relay.enqueue(payload);
    const catalogQueued = liveCatalogWorker.enqueue(payload);
    const alertQueued = realtimeAlertWorker.enqueue(payload);
    const aggregateQueued = marketAggregateWorker.enqueue(payload);
    return socketEmitted || relayQueued || catalogQueued || alertQueued || aggregateQueued;
  };
}

module.exports = { createRobinhoodMarketBucketFanout };
