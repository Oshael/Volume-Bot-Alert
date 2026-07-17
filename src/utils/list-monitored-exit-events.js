#!/usr/bin/env node
const db = require('../models/db');
const monitoredTokenExitEvent = require('../models/monitored-token-exit-event');

function parseArgs(argv) {
  const options = {};
  for (const arg of argv.slice(2)) {
    const [rawKey, rawValue = ''] = String(arg).split('=');
    const key = rawKey.replace(/^--/, '').trim();
    const value = rawValue.trim();
    if (key === 'limit') {
      options.limit = Number.parseInt(value, 10);
    } else if (key === 'address') {
      options.address = value;
    } else if (key === 'reason') {
      options.exitReason = value;
    } else if (key === 'json') {
      options.json = value !== 'false';
    }
  }
  return options;
}

function formatEvent(event) {
  const previous = event.previousSnapshot || {};
  const current = event.currentSnapshot || {};
  return {
    id: event.id,
    createdAt: event.createdAt,
    address: event.tokenAddress,
    reason: event.exitReason,
    source: event.exitSource,
    scope: event.semantics?.scope || monitoredTokenExitEvent.EVENT_SEMANTICS.scope,
    workspaceExit: false,
    previousMcap: previous.mcap ?? null,
    currentMcap: current.mcap ?? null,
    previousEligible: previous.eligibleForMonitoring ?? null,
    currentEligible: current.eligibleForMonitoring ?? null,
    currentSuppressedReason: current.suppressedReason ?? null,
    currentEligibilityState: current.eligibilityState ?? null,
    currentVol24h: current.volume24h ?? null,
  };
}

async function run() {
  const options = parseArgs(process.argv);
  try {
    const events = await monitoredTokenExitEvent.listRecent({ ...options, chain: 'solana' });
    const rows = events.map((event) => options.json ? event : formatEvent(event));
    if (options.json) {
      console.log(JSON.stringify({
        semantics: monitoredTokenExitEvent.EVENT_SEMANTICS,
        events: rows,
        count: rows.length,
      }, null, 2));
    } else {
      console.table(rows);
    }
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, formatEvent };
