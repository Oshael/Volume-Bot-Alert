'use strict';

// Bloco 0 (GATE) of the X-post/token match plan. Read-only probe: it does NOT
// touch the X ingestion path, schema, or the alert feed. It samples catalog
// token images, applies the transformations a real memecoin image goes through
// (recompression, resize, crop, overlaid text, mirror) and measures how far the
// perceptual hash drifts from the original. Output is the Hamming distribution
// per transform, plus the negative floor from cross-token comparisons, so we can
// pick a usable threshold budget before spending on proxies and X sessions.
//
// Usage: node src/utils/token-image-phash-probe.js [--limit=40] [--chain=solana]

require('dotenv').config();

const sharp = require('sharp');
const db = require('../models/db');
const { fingerprint, hamming } = require('./image-fingerprint');

const DOWNLOAD_TIMEOUT_MS = 8_000;
const CROP_FRACTIONS = [0.05, 0.1, 0.2];
const JPEG_QUALITIES = [90, 70, 50];
const RESIZE_FRACTIONS = [0.5, 0.25];

function parseArgs(argv) {
  const args = { limit: 40, chain: null };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (key === 'limit') args.limit = Math.max(1, Number.parseInt(value, 10) || 40);
    if (key === 'chain') args.chain = String(value || '').trim() || null;
  }
  return args;
}

async function loadCatalogImages({ limit, chain }) {
  const params = [];
  let where = "last_image_url IS NOT NULL AND last_image_url <> ''";
  if (chain) {
    params.push(chain);
    where += ` AND chain = $${params.length}`;
  }
  params.push(limit);
  const limitIndex = `$${params.length}`;
  const { rows } = await db.query(
    `SELECT chain, address, symbol, name, last_image_url
       FROM token_catalog
      WHERE ${where}
      ORDER BY last_seen_at DESC
      LIMIT ${limitIndex}`,
    params,
  );
  return rows;
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function overlaySvg(width, height) {
  const barHeight = Math.max(16, Math.round(height * 0.18));
  const fontSize = Math.max(10, Math.round(barHeight * 0.6));
  return Buffer.from(
    `<svg width="${width}" height="${height}">` +
      `<rect x="0" y="${height - barHeight}" width="${width}" height="${barHeight}" fill="black" fill-opacity="0.55"/>` +
      `<text x="${Math.round(width / 2)}" y="${height - Math.round(barHeight / 2)}" ` +
      `font-family="sans-serif" font-size="${fontSize}" fill="white" ` +
      `text-anchor="middle" dominant-baseline="central">$TICKER 100x</text>` +
      '</svg>',
  );
}

// Build the transformed variants of one original image buffer.
async function buildVariants(original) {
  const meta = await sharp(original).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  const variants = {};

  for (const q of JPEG_QUALITIES) {
    variants[`jpeg_q${q}`] = await sharp(original).jpeg({ quality: q }).toBuffer();
  }
  for (const f of RESIZE_FRACTIONS) {
    const w = Math.max(8, Math.round(width * f));
    variants[`resize_${Math.round(f * 100)}pct`] = await sharp(original)
      .resize(w, null)
      .toBuffer();
  }
  for (const f of CROP_FRACTIONS) {
    const left = Math.round((width * f) / 2);
    const top = Math.round((height * f) / 2);
    const cropW = Math.max(8, width - left * 2);
    const cropH = Math.max(8, height - top * 2);
    variants[`crop_${Math.round(f * 100)}pct`] = await sharp(original)
      .extract({ left, top, width: cropW, height: cropH })
      .toBuffer();
  }
  variants.text_overlay = await sharp(original)
    .composite([{ input: overlaySvg(width, height), top: 0, left: 0 }])
    .png()
    .toBuffer();
  variants.mirror = await sharp(original).flop().toBuffer();

  return variants;
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: sorted.length, min: sorted[0], median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.log('transform'.padEnd(18), 'n'.padStart(4), 'min'.padStart(5), 'med'.padStart(5), 'p90'.padStart(5), 'max'.padStart(5));
  for (const [label, dist] of rows) {
    if (!dist) {
      console.log(label.padEnd(18), '  no data');
      continue;
    }
    console.log(
      label.padEnd(18),
      String(dist.n).padStart(4),
      String(dist.min).padStart(5),
      String(dist.median).padStart(5),
      String(dist.p90).padStart(5),
      String(dist.max).padStart(5),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const tokens = await loadCatalogImages(args);
  console.log(`Loaded ${tokens.length} catalog tokens with images (limit ${args.limit}${args.chain ? `, chain ${args.chain}` : ''}).`);

  // metric -> transform -> list of distances
  const byMetric = { phash: {}, dhash: {}, min: {} };
  const baselines = [];
  let processed = 0;
  let failed = 0;

  for (const token of tokens) {
    const original = await download(token.last_image_url);
    if (!original) {
      failed += 1;
      continue;
    }
    let base;
    let variants;
    try {
      base = await fingerprint(original);
      variants = await buildVariants(original);
    } catch {
      failed += 1;
      continue;
    }
    baselines.push(base);
    processed += 1;

    for (const [label, buffer] of Object.entries(variants)) {
      let fp;
      try {
        fp = await fingerprint(buffer);
      } catch {
        continue;
      }
      const dp = hamming(base.phash, fp.phash);
      const dd = hamming(base.dhash, fp.dhash);
      (byMetric.phash[label] ||= []).push(dp);
      (byMetric.dhash[label] ||= []).push(dd);
      (byMetric.min[label] ||= []).push(Math.min(dp, dd));
    }
  }

  console.log(`Processed ${processed} images, ${failed} skipped (download/decode failures).`);

  const labels = Object.keys(byMetric.min);
  printTable('pHash Hamming by transform', labels.map((l) => [l, stats(byMetric.phash[l])]));
  printTable('dHash Hamming by transform', labels.map((l) => [l, stats(byMetric.dhash[l])]));
  printTable('min(pHash,dHash) by transform', labels.map((l) => [l, stats(byMetric.min[l])]));

  // Negative floor: compare each baseline against the next one (unrelated tokens).
  const negatives = { phash: [], dhash: [], min: [] };
  for (let i = 0; i < baselines.length; i += 1) {
    const other = baselines[(i + 1) % baselines.length];
    if (other === baselines[i]) continue;
    const dp = hamming(baselines[i].phash, other.phash);
    const dd = hamming(baselines[i].dhash, other.dhash);
    negatives.phash.push(dp);
    negatives.dhash.push(dd);
    negatives.min.push(Math.min(dp, dd));
  }
  printTable('Negative floor (cross-token)', [
    ['phash', stats(negatives.phash)],
    ['dhash', stats(negatives.dhash)],
    ['min', stats(negatives.min)],
  ]);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    db.pool.end().catch(() => {});
  });
