'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCalloutSummaryCandidateRead } = require('../models/callout-summary-candidate-read');
const { compareCandidate, __private } = require('../services/callout-summary-comparison');
const db = require('../models/db');

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function flag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function absoluteOutput(value) {
  const output = String(value || '').trim();
  if (!output || !path.isAbsolute(output) || path.extname(output) !== '.json') {
    const error = new Error('--output must be an absolute .json path');
    error.code = 'CALLOUT_SUMMARY_OUTPUT';
    throw error;
  }
  return output;
}

function reportSources(candidate) {
  return candidate.sources.map(({ id, platform, occurredAt, profile, thesis, links }) => ({
    id, platform, occurredAt,
    profile: {
      platformUserId: profile?.platformUserId || null,
      username: profile?.username || null,
      displayName: profile?.displayName || null,
    },
    thesis,
    links: links || [],
  }));
}

function previewReport(selection) {
  return {
    window: selection.window,
    candidates: selection.candidates.map((candidate, candidateIndex) => ({
      candidateIndex,
      asset: candidate.asset,
      sourceCount: candidate.sourceCount,
      platforms: candidate.platforms,
      sources: reportSources(candidate),
    })),
  };
}

function blindReport(candidate, results) {
  const labels = crypto.randomInt(2) ? ['A', 'B'] : ['B', 'A'];
  const entries = results.map((result, index) => ({ label: labels[index], ...result }));
  return {
    report: {
      promptVersion: __private.PROMPT_VERSION,
      asset: candidate.asset, window: candidate.window,
      sources: reportSources(candidate),
      outputs: entries.map(({ label, text }) => ({ label, text })).sort((a, b) => a.label.localeCompare(b.label)),
    },
    key: {
      promptVersion: __private.PROMPT_VERSION,
      mapping: entries.map(({ label, provider, model, latencyMs, usage }) => (
        { label, provider, model, latencyMs, usage }
      )).sort((a, b) => a.label.localeCompare(b.label)),
    },
  };
}

async function main() {
  const outputPath = absoluteOutput(argument('output'));
  const candidateIndex = Number(argument('candidate', '0'));
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0) {
    throw Object.assign(new Error('--candidate must be a non-negative integer'), {
      code: 'CALLOUT_SUMMARY_CANDIDATE',
    });
  }
  const selection = await createCalloutSummaryCandidateRead().listCandidates({
    from: argument('from'), to: argument('to'),
  });
  if (flag('preview')) {
    await fs.writeFile(outputPath, `${JSON.stringify(previewReport(selection), null, 2)}\n`, {
      mode: 0o600, flag: 'wx',
    });
    console.log(JSON.stringify({
      previewed: true, outputPath, candidates: selection.candidates.length,
    }));
    return;
  }
  const candidate = selection.candidates[candidateIndex];
  if (!candidate) throw Object.assign(new Error('Requested candidate was not found'), {
    code: 'CALLOUT_SUMMARY_CANDIDATE', available: selection.candidates.length,
  });
  const results = await compareCandidate(candidate, {
    geminiApiKey: process.env.GEMINI_API_KEY,
    glmApiKey: process.env.ZAI_API_KEY,
    geminiModel: process.env.CALLOUT_GEMINI_MODEL,
    glmModel: process.env.CALLOUT_GLM_MODEL,
  });
  const blind = blindReport(candidate, results);
  const keyPath = outputPath.replace(/\.json$/, '.key.json');
  await fs.writeFile(outputPath, `${JSON.stringify(blind.report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(keyPath, `${JSON.stringify(blind.key, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ compared: true, outputPath, keyPath, sourceCount: candidate.sourceCount }));
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({
    error: error.code || error.name || 'CALLOUT_SUMMARY_COMPARISON',
    message: error.message, statusCode: error.statusCode || null,
    available: error.available ?? null,
  }));
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { absoluteOutput, blindReport, previewReport, reportSources };
