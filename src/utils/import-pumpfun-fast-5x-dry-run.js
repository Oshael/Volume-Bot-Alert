const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const pumpfunFast5xDetection = require('../models/pumpfun-fast-5x-detection');

function readJsonFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
}

function extractCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.candidates)) return payload.candidates;
  throw new Error('Expected a JSON array or an object with candidates[]');
}

async function main() {
  const filePath = process.argv[2] || 'pumpfun-fast-dry-run.json';
  const payload = readJsonFile(filePath);
  const candidates = extractCandidates(payload);

  let imported = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      await pumpfunFast5xDetection.upsertDetection(candidate);
      imported += 1;
    } catch (err) {
      skipped += 1;
      console.warn(`Skipped ${candidate?.address || 'unknown'}: ${err.message}`);
    }
  }

  console.log(`Imported PumpFun fast 5x dry-run detections: ${imported}`);
  if (skipped > 0) {
    console.log(`Skipped detections: ${skipped}`);
  }
}

main()
  .catch((err) => {
    console.error('Failed to import PumpFun fast 5x dry-run detections:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
