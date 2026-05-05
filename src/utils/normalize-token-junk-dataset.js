const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_INPUT_PATH = path.resolve(process.cwd(), 'List of junk tokens.json');
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), 'data/token-junk-dataset.json');

function normalizeLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    throw new Error('Dataset entry is missing label');
  }

  if (raw === 'junk' || raw === 'junk_probable') {
    return 'junk_probable';
  }
  if (raw === 'junk_permanent') {
    return 'junk_permanent';
  }
  if (raw === 'legit' || raw === 'valid') {
    return 'valid';
  }
  if (raw === 'valid_but_weak' || raw === 'weak but legit' || raw === 'weak/monitoring') {
    return 'valid_but_weak';
  }

  throw new Error(`Unsupported dataset label: ${value}`);
}

function normalizeConfidence(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === 'high' || raw === 'medium' || raw === 'low') {
    return raw;
  }
  throw new Error(`Unsupported dataset confidence: ${value}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildCanonicalEntry(rawEntry, index) {
  if (!isPlainObject(rawEntry)) {
    throw new Error(`Dataset entry at index ${index} must be an object`);
  }

  const address = String(rawEntry.address || '').trim();
  const reason = String(rawEntry.reason || '').trim();
  if (!address) {
    throw new Error(`Dataset entry at index ${index} is missing address`);
  }
  if (!reason) {
    throw new Error(`Dataset entry at index ${index} is missing reason`);
  }

  return {
    address,
    label: normalizeLabel(rawEntry.label),
    confidence: normalizeConfidence(rawEntry.confidence),
    reason,
    notes: String(rawEntry.notes || '').trim() || null,
    sourceIndex: index,
    rawLabel: String(rawEntry.label || '').trim() || null,
  };
}

function normalizeDataset(rawDataset) {
  if (!Array.isArray(rawDataset)) {
    throw new Error('Dataset root must be an array');
  }

  const datasetNotes = [];
  const groupedByAddress = new Map();

  rawDataset.forEach((entry, index) => {
    if (typeof entry === 'string') {
      const note = entry.trim();
      if (note) datasetNotes.push(note);
      return;
    }

    const canonical = buildCanonicalEntry(entry, index);
    const existing = groupedByAddress.get(canonical.address);
    if (!existing) {
      groupedByAddress.set(canonical.address, {
        address: canonical.address,
        label: canonical.label,
        confidence: canonical.confidence,
        reason: canonical.reason,
        notes: canonical.notes ? [canonical.notes] : [],
        reasons: [canonical.reason],
        sourceIndices: [canonical.sourceIndex],
        rawLabels: canonical.rawLabel ? [canonical.rawLabel] : [],
      });
      return;
    }

    if (existing.label !== canonical.label) {
      throw new Error(
        `Conflicting labels for ${canonical.address}: ${existing.label} vs ${canonical.label}`
      );
    }

    existing.sourceIndices.push(canonical.sourceIndex);
    if (canonical.rawLabel) {
      existing.rawLabels.push(canonical.rawLabel);
    }
    if (!existing.reasons.includes(canonical.reason)) {
      existing.reasons.push(canonical.reason);
    }
    if (canonical.notes && !existing.notes.includes(canonical.notes)) {
      existing.notes.push(canonical.notes);
    }

    const confidenceRank = { low: 1, medium: 2, high: 3 };
    const existingRank = confidenceRank[existing.confidence] || 0;
    const candidateRank = confidenceRank[canonical.confidence] || 0;
    if (candidateRank > existingRank) {
      existing.confidence = canonical.confidence;
    }
  });

  const entries = [...groupedByAddress.values()]
    .map((entry) => ({
      address: entry.address,
      label: entry.label,
      confidence: entry.confidence,
      reason: entry.reasons[0],
      notes: entry.reasons.length > 1 || entry.notes.length > 0
        ? [
          ...entry.reasons.slice(1).map((reason) => `extra_reason: ${reason}`),
          ...entry.notes,
        ].join(' | ')
        : null,
    }))
    .sort((a, b) => a.address.localeCompare(b.address));

  const labelCounts = entries.reduce((accumulator, entry) => {
    accumulator[entry.label] = (accumulator[entry.label] || 0) + 1;
    return accumulator;
  }, {});

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      sourcePath: DEFAULT_INPUT_PATH,
      totalEntries: entries.length,
      labelCounts,
      datasetNotes,
    },
    entries,
  };
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const inputPath = path.resolve(process.argv[2] || DEFAULT_INPUT_PATH);
  const outputPath = path.resolve(process.argv[3] || DEFAULT_OUTPUT_PATH);
  const normalized = normalizeDataset(readJsonFile(inputPath));
  writeJsonFile(outputPath, normalized);
  console.log(
    `[token-junk-dataset] wrote ${normalized.entries.length} entries to ${outputPath}`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_INPUT_PATH,
  DEFAULT_OUTPUT_PATH,
  normalizeConfidence,
  normalizeDataset,
  normalizeLabel,
};
