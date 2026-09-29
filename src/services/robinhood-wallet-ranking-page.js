const { createHash } = require('node:crypto');
const {
  createRobinhoodWalletRankingGlobal,
} = require('./robinhood-wallet-ranking-global');
const {
  createRobinhoodWalletRankingPositionFrontierRepository,
} = require('../models/robinhood-wallet-ranking-position-frontier');
const {
  createRobinhoodWalletRankingProfileRepository,
} = require('../models/robinhood-wallet-ranking-profile');

const WINDOWS = new Set(['24h', '7d', '30d', 'ALL']);
const PROJECTION_VERSION = 'unified_transfer_v1';
const CLASSIFICATION_VERSION = 'rh_transfer_v1';

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function validCursor(parsed, value) {
  return parsed?.v === 1 && WINDOWS.has(parsed.window)
    && Number.isInteger(parsed.afterRank) && parsed.afterRank >= 1 && parsed.afterRank <= 100
    && /^0x[0-9a-f]{40}$/.test(parsed.afterWallet)
    && /^[0-9a-f]{64}$/.test(parsed.fingerprint)
    && typeof parsed.asOf === 'string'
    && Number.isFinite(Date.parse(parsed.asOf))
    && new Date(parsed.asOf).toISOString() === parsed.asOf
    && Buffer.from(JSON.stringify(parsed)).toString('base64url') === value;
}

function cursorText(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw error('INVALID_RANKING_REQUEST', 'cursor is invalid');
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch (_) {
    throw error('INVALID_RANKING_REQUEST', 'cursor is invalid');
  }
  if (!validCursor(parsed, value)) throw error('INVALID_RANKING_REQUEST', 'cursor is invalid');
  return parsed;
}

function pageLimit(value) {
  if (value != null && !['string', 'number'].includes(typeof value)) {
    throw error('INVALID_RANKING_REQUEST', 'limit is invalid');
  }
  const limit = value == null ? 25 : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw error('INVALID_RANKING_REQUEST', 'limit must be between 1 and 50');
  }
  return limit;
}

function pageAsOf(value, cursor) {
  if (value != null && typeof value !== 'string') {
    throw error('INVALID_RANKING_REQUEST', 'asOf is invalid');
  }
  const suppliedAsOf = value == null ? null : new Date(value);
  if (suppliedAsOf && !Number.isFinite(suppliedAsOf.getTime())) {
    throw error('INVALID_RANKING_REQUEST', 'asOf is invalid');
  }
  if (cursor && suppliedAsOf && cursor.asOf !== suppliedAsOf.toISOString()) {
    throw error('INVALID_RANKING_REQUEST', 'cursor asOf does not match');
  }
  return suppliedAsOf?.toISOString() || cursor?.asOf || null;
}

function normalize(input) {
  if (input.chain != null && input.chain !== 'robinhood') {
    throw error('INVALID_RANKING_REQUEST', 'chain must be robinhood');
  }
  if (!WINDOWS.has(input.window)) {
    throw error('INVALID_RANKING_REQUEST', 'window is invalid');
  }
  const limit = pageLimit(input.limit);
  const cursor = cursorText(input.cursor);
  if (cursor && cursor.window !== input.window) {
    throw error('INVALID_RANKING_REQUEST', 'cursor window does not match');
  }
  return { window: input.window, limit, cursor,
    asOf: pageAsOf(input.asOf, cursor) };
}

function fingerprint(ranking) {
  const state = [ranking.window, ranking.asOf, ranking.coverage,
    ranking.reasons, ranking.candidateWalletCount, ranking.excludedWalletCount,
    ranking.ranked.map((row) => [row.rank, row.walletAddress, row.gainUsd,
      row.openPositionCount])];
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function pageRows(ranking, input) {
  const hash = fingerprint(ranking);
  let start = 0;
  if (input.cursor) {
    const anchor = ranking.ranked[input.cursor.afterRank - 1];
    if (input.cursor.fingerprint !== hash
        || anchor?.walletAddress !== input.cursor.afterWallet) {
      throw error('STALE_RANKING_CURSOR', 'ranking changed; restart pagination');
    }
    start = input.cursor.afterRank;
  }
  const rows = ranking.ranked.slice(start, start + input.limit);
  const hasMore = start + rows.length < ranking.ranked.length;
  const last = rows.at(-1);
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({ v: 1,
    window: ranking.window, asOf: ranking.asOf,
    afterRank: last.rank, afterWallet: last.walletAddress,
    fingerprint: hash,
  })).toString('base64url') : null;
  return { rows, hasMore, nextCursor };
}

function createRobinhoodWalletRankingPage(options = {}) {
  const rankingService = options.rankingService || createRobinhoodWalletRankingGlobal();
  const frontierRepository = options.frontierRepository
    || createRobinhoodWalletRankingPositionFrontierRepository();
  const profileRepository = options.profileRepository
    || createRobinhoodWalletRankingProfileRepository();
  const logger = options.logger || console;
  return {
    async list(input = {}) {
      const query = normalize(input);
      const asOf = query.asOf || await frontierRepository.latestAsOf(PROJECTION_VERSION);
      if (!asOf) throw error('RANKING_NOT_READY', 'ranking checkpoint is unavailable');
      const ranking = await rankingService.getRanking({
        window: query.window, asOf, limit: 100,
        projectionVersion: PROJECTION_VERSION,
        classificationVersion: CLASSIFICATION_VERSION,
      });
      const { rows, hasMore, nextCursor } = pageRows(ranking, query);
      let profiles = [];
      let profileStatus = 'available';
      try {
        profiles = await profileRepository.findByWalletAddresses(
          rows.map((row) => row.walletAddress),
        );
      } catch (failure) {
        profileStatus = 'unavailable';
        logger.warn?.('[RobinhoodWalletRankingPage] profile read failed', {
          code: String(failure?.code || 'PROFILE_READ_FAILED'),
        });
      }
      const byWallet = new Map(profiles.map((profile) => [profile.address, profile]));
      const { ranked: _ranked, ...metadata } = ranking;
      return { ...metadata, chainKey: 'robinhood', pageLimit: query.limit,
        rankingLimit: 100,
        rankingListTruncated: ranking.candidateUniverseComplete === false ? null
          : ranking.candidateWalletCount - ranking.excludedWalletCount > 100,
        items: rows.map((row) => ({ ...row, chainKey: 'robinhood',
          profile: byWallet.get(row.walletAddress) || null })),
        hasMore, nextCursor, profileStatus };
    },
  };
}

module.exports = { createRobinhoodWalletRankingPage };
