'use strict';
const { createHash } = require('node:crypto');

function captureDigest(block, transactions, events, v3Snapshots) {
  const payload = {
    block: [block.number.toString(), block.hash, block.parentHash, block.timestamp,
      block.captureVersion],
    transactions: [...transactions].sort((a, b) => a.transaction_index - b.transaction_index),
    events: [...events].sort((a, b) => a.log_index - b.log_index),
    v3Snapshots: [...v3Snapshots].sort((a, b) => a.log_index - b.log_index),
  };
  return `0x${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

module.exports = { captureDigest };
