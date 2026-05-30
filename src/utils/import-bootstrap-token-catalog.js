const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const tokenCatalog = require('../models/token-catalog');
const { extractDexSocialLinks } = require('./dex-social-links');

const seedPath = path.join(__dirname, '..', '..', 'data', 'initial-monitored-tokens.txt');
const DEX_TIMEOUT_MS = 8000;
const DEX_DELAY_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickDexPair(pairs) {
  return pairs.find((pair) => pair?.chainId === 'solana') || pairs[0] || null;
}

function buildDexMetadata(pair) {
  if (!pair) {
    return null;
  }
  const socialLinks = extractDexSocialLinks(pair);
  return {
    symbol: pair.baseToken?.symbol || null,
    name: pair.baseToken?.name || null,
    mcap: pair.marketCap || pair.fdv || null,
    price: pair.priceUsd || null,
    pairAddress: pair.pairAddress || null,
    pairUrl: pair.url || null,
    imageUrl: pair.info?.imageUrl || pair.info?.header || pair.baseToken?.logoUri || null,
    twitterUrl: socialLinks.twitterUrl,
    communityUrl: socialLinks.communityUrl,
  };
}

function metadataValue(metadata, key) {
  return metadata?.[key] || null;
}

function buildBootstrapTokenPayload(address, metadata) {
  return {
    address,
    chain: 'solana',
    source: 'bootstrap',
    isActiveMonitorCandidate: true,
    symbol: metadataValue(metadata, 'symbol'),
    name: metadataValue(metadata, 'name'),
    mcap: metadataValue(metadata, 'mcap'),
    price: metadataValue(metadata, 'price'),
    pairAddress: metadataValue(metadata, 'pairAddress'),
    pairUrl: metadataValue(metadata, 'pairUrl'),
    imageUrl: metadataValue(metadata, 'imageUrl'),
    twitterUrl: metadataValue(metadata, 'twitterUrl'),
    communityUrl: metadataValue(metadata, 'communityUrl'),
  };
}

async function fetchDexMetadata(address) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEX_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: controller.signal,
      headers: { 'accept': 'application/json' },
    });

    if (!res.ok) return null;
    const data = await res.json();
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    if (!pairs.length) return null;

    return buildDexMetadata(pickDexPair(pairs));
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  try {
    const raw = fs.readFileSync(seedPath, 'utf8');
    const addresses = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index);

    if (!addresses.length) {
      console.log('No bootstrap tokens found in seed file.');
      return;
    }

    let imported = 0;
    let enriched = 0;

    for (const address of addresses) {
      const metadata = await fetchDexMetadata(address);
      await tokenCatalog.upsertToken(buildBootstrapTokenPayload(address, metadata));
      imported++;
      if (metadata?.symbol || metadata?.name) enriched++;
      await sleep(DEX_DELAY_MS);
    }

    console.log(`Imported ${imported} bootstrap token(s) into token_catalog.`);
    console.log(`Enriched ${enriched} token(s) with DexScreener metadata.`);
  } catch (err) {
    console.error('Failed to import bootstrap token catalog seed:', err.message);
    process.exitCode = 1;
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

run();
