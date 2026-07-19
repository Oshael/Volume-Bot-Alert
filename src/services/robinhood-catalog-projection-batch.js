const robinhoodCatalog = require('../models/robinhood-catalog');
const { createRobinhoodTokenReadRepository } = require('../models/robinhood-token-read');

const FRESH_MS = 15 * 60 * 1000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(items.length, concurrency) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

function needsOnchainMetadata(row) {
  return !row?.symbol || !row?.name;
}

function needsSocialMetadata(row, nowMs, ttlMs) {
  if (!row || checkedAtExpired(row.robinhood_blockscout_checked_at, nowMs, ttlMs)) {
    return false;
  }
  return checkedAtExpired(row.robinhood_dexscreener_checked_at, nowMs, ttlMs);
}

function checkedAtExpired(value, nowMs, ttlMs) {
  const checkedAtMs = new Date(value).getTime();
  return !Number.isFinite(checkedAtMs) || checkedAtMs + ttlMs <= nowMs;
}

async function enrichFromBlockscout(input) {
  if (!input.reader?.getTokenMetadata) {
    return { checked: 0, imagesResolved: 0, unavailable: 0, errors: 0 };
  }
  const candidates = input.candidates.filter((candidate) => checkedAtExpired(
    input.metadataByAddress.get(candidate.tokenAddress)?.robinhood_blockscout_checked_at,
    input.asOfMs,
    input.ttlMs
  )).slice(0, input.limit);
  const results = await mapWithConcurrency(candidates, input.concurrency, async (candidate) => {
    const metadata = await input.reader.getTokenMetadata(candidate.tokenAddress);
    await input.catalog.recordBlockscoutMetadata({
      address: candidate.tokenAddress,
      symbol: metadata.symbol,
      name: metadata.name,
      imageUrl: metadata.imageUrl,
    });
    const current = input.metadataByAddress.get(candidate.tokenAddress) || {};
    input.metadataByAddress.set(candidate.tokenAddress, {
      ...current,
      address: candidate.tokenAddress,
      symbol: metadata.symbol || current.symbol,
      name: metadata.name || current.name,
      last_image_url: metadata.imageUrl || current.last_image_url,
      robinhood_blockscout_checked_at: new Date(input.asOfMs),
    });
    return metadata.available === true && Boolean(metadata.imageUrl);
  });
  return {
    checked: results.filter((result) => result.status === 'fulfilled').length,
    imagesResolved: results.filter((result) => result.value === true).length,
    unavailable: results.filter((result) => (
      result.status === 'fulfilled' && result.value !== true
    )).length,
    errors: results.filter((result) => result.status === 'rejected').length,
  };
}

async function loadCandidates(repository, query) {
  const read = repository.listColdRepairCandidates
    || repository.listActiveTokenCandidates
    || repository.listSignalDryRunCandidates;
  const rows = await read.call(repository, {
    asOf: query.asOf,
    windowMs: FRESH_MS,
    limit: query.maxTokens,
    alignToMinute: false,
    statementTimeoutMs: query.statementTimeoutMs,
  });
  return {
    rows: rows.filter((row) => row.adminBlocked !== true),
    excludedBlocked: rows.filter((row) => row.adminBlocked === true).length,
    limitReached: rows.length === query.maxTokens,
  };
}

function projectionSnapshot(candidate) {
  // The post-commit live worker owns freshness; this remains a cold repair path
  // for missed events, market identity and asynchronous metadata enrichment.
  return {
    ...candidate,
    volume5mUsd: null,
    volume1hUsd: null,
    volume6hUsd: null,
    volume24hUsd: null,
    priceChange1hPct: null,
    priceChange6hPct: null,
    priceChange24hPct: null,
  };
}

function createRobinhoodCatalogProjectionBatch(options = {}) {
  const repository = options.repository || createRobinhoodTokenReadRepository();
  const catalog = options.catalog || robinhoodCatalog;
  const metadataReader = options.metadataReader || null;
  const blockscoutReader = options.blockscoutReader || null;
  const socialQueue = options.socialQueue || null;
  const now = options.now || Date.now;

  async function runOnce(input = {}) {
    const asOf = new Date(input.asOf ?? now());
    if (!Number.isFinite(asOf.getTime())) throw new Error('projection asOf must be valid');
    const query = {
      asOf,
      maxTokens: boundedInteger(input.maxTokens, 2000, 1, 5000),
      statementTimeoutMs: boundedInteger(input.statementTimeoutMs, 10_000, 1000, 60_000),
    };
    const concurrency = boundedInteger(input.concurrency, 4, 1, 10);
    const socialTtlMs = boundedInteger(
      input.socialTtlMs, 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000,
    );
    const blockscoutTtlMs = boundedInteger(
      input.blockscoutTtlMs, 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000,
    );
    const candidates = await loadCandidates(repository, query);
    const projections = await mapWithConcurrency(
      candidates.rows,
      concurrency,
      (candidate) => catalog.projectDashboardSnapshot(projectionSnapshot(candidate))
    );
    const projected = projections.filter((result) => result.status === 'fulfilled').length;
    const projectionErrors = projections.length - projected;
    const manualMetadataCandidates = catalog.listManualMetadataCandidates
      ? await catalog.listManualMetadataCandidates({ limit: query.maxTokens }) : [];
    const metadataCandidates = [...new Map(
      [...candidates.rows, ...manualMetadataCandidates]
        .map((candidate) => [candidate.tokenAddress, candidate])
    ).values()];
    const metadataRows = await catalog.listMetadata(
      metadataCandidates.map((candidate) => candidate.tokenAddress)
    );
    const metadataByAddress = new Map(metadataRows.map((row) => [row.address, row]));

    let onchainResolved = 0;
    let onchainUnavailable = 0;
    let onchainErrors = 0;
    if (metadataReader?.getMetadata) {
      const missing = metadataCandidates.filter((candidate) => (
        needsOnchainMetadata(metadataByAddress.get(candidate.tokenAddress))
      ));
      const metadataResults = await mapWithConcurrency(missing, concurrency, async (candidate) => {
        const metadata = await metadataReader.getMetadata(candidate.tokenAddress);
        if (!metadata?.name && !metadata?.symbol) return false;
        await catalog.applyMetadata({
          address: candidate.tokenAddress,
          name: metadata.name,
          symbol: metadata.symbol,
        });
        return true;
      });
      onchainResolved = metadataResults.filter((result) => result.value === true).length;
      onchainUnavailable = metadataResults.filter((result) => (
        result.status === 'fulfilled' && result.value !== true
      )).length;
      onchainErrors = metadataResults.filter((result) => result.status === 'rejected').length;
    }

    const blockscout = await enrichFromBlockscout({
      reader: blockscoutReader,
      catalog,
      candidates: metadataCandidates,
      metadataByAddress,
      asOfMs: asOf.getTime(),
      ttlMs: blockscoutTtlMs,
      limit: boundedInteger(input.blockscoutBatchSize, 10, 1, 50),
      concurrency,
    });

    let socialEnqueued = 0;
    const socialDrainStatuses = [];
    if (socialQueue?.enqueue && socialQueue?.drainOnce) {
      for (const candidate of metadataCandidates) {
        if (
          needsSocialMetadata(metadataByAddress.get(candidate.tokenAddress), asOf.getTime(), socialTtlMs)
          && socialQueue.enqueue(candidate.tokenAddress, {
            blockscoutMissingImage: !metadataByAddress.get(candidate.tokenAddress)?.last_image_url,
            volumeUsd: candidate.volumeUsd,
          })
        ) socialEnqueued += 1;
      }
      const drainLimit = boundedInteger(input.socialDrainLimit, 1, 1, 10);
      for (let index = 0; index < drainLimit; index += 1) {
        const result = await socialQueue.drainOnce();
        socialDrainStatuses.push(result.status);
        if (result.status !== 'processed') break;
      }
    }

    return Object.freeze({
      status: projectionErrors + onchainErrors + blockscout.errors > 0
        ? 'completed-with-errors' : 'completed',
      generatedAt: asOf.toISOString(),
      candidates: candidates.rows.length,
      manualMetadataCandidates: manualMetadataCandidates.length,
      excludedBlocked: candidates.excludedBlocked,
      candidateLimitReached: candidates.limitReached,
      projected,
      projectionErrors,
      onchainResolved,
      onchainUnavailable,
      onchainErrors,
      blockscoutChecked: blockscout.checked,
      blockscoutImagesResolved: blockscout.imagesResolved,
      blockscoutUnavailable: blockscout.unavailable,
      blockscoutErrors: blockscout.errors,
      socialEnqueued,
      socialDrainStatuses: Object.freeze(socialDrainStatuses),
      // Deprecated compatibility field. Inactivity is now derived freshness,
      // never a catalog lifecycle mutation.
      demoted: 0,
    });
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  FRESH_MS,
  createRobinhoodCatalogProjectionBatch,
  __private: {
    boundedInteger, loadCandidates, mapWithConcurrency, projectionSnapshot,
    checkedAtExpired, enrichFromBlockscout, needsOnchainMetadata, needsSocialMetadata,
  },
};
