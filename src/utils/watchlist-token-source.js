'use strict';

const WATCHLIST_SOURCE = 'user-watchlist';
const LEGACY_WATCHLIST_SOURCE = 'user-manual';

function isWatchlistSource(value) {
  const source = String(value || '').trim().toLowerCase();
  return source === WATCHLIST_SOURCE || source === LEGACY_WATCHLIST_SOURCE;
}

module.exports = {
  LEGACY_WATCHLIST_SOURCE,
  WATCHLIST_SOURCE,
  isWatchlistSource,
};
