const tokenGateWebhookSync = require('../services/token-gate-webhook-sync-service');
const db = require('../models/db');

async function main() {
  try {
    const result = await tokenGateWebhookSync.syncLinkedWallets();
    if (result.skipped) {
      console.log(`Helius token gate webhook sync skipped: ${result.reason}`);
      return;
    }
    console.log(`Helius token gate webhook synced ${result.walletCount} linked wallet(s)`);
  } catch (err) {
    console.error('Failed to sync Helius token gate webhook:', err.message);
    process.exitCode = 1;
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
