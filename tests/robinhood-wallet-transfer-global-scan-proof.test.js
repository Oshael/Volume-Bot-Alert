const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildGlobalScanProof } = require('../src/models/robinhood-wallet-transfer-global-scan-proof');
const tokens = [1, 2, 3].map((id) => `0x${id.toString(16).padStart(40, '0')}`);
const capture = { source: 'canonical-journal', complete: true, selectedLogsValidated: true,
  fromBlock: '100', throughBlock: '109', checkpointHash: `0x${'a'.repeat(64)}`,
  observedLogs: 3, observedTokenAddresses: tokens.slice(0, 2), selectedTokenAddresses: [tokens[0]] };
test('stores only unselected observed contracts and keeps a deterministic proof hash', () => {
  const proof = buildGlobalScanProof(capture);
  assert.deepEqual(proof.excludedTokenAddresses, [tokens[1]]);
  assert.equal(proof.observedContracts, 2);
  assert.equal(proof.selectedContracts, 1);
  assert.equal(buildGlobalScanProof({ ...capture, observedTokenAddresses: [tokens[1], tokens[0], tokens[0]] }).proofHash, proof.proofHash);
  // A selected swap-only token does not change the proof of Transfer absence.
  assert.equal(buildGlobalScanProof({ ...capture, selectedTokenAddresses: [tokens[0], tokens[2]] }).proofHash, proof.proofHash);
});
test('accepts globally proven empty ranges, including an empty selected set', () => {
  const proof = buildGlobalScanProof({ ...capture, observedLogs: 0, observedTokenAddresses: [], selectedTokenAddresses: [] });
  assert.deepEqual(proof.excludedTokenAddresses, []);
  assert.equal(proof.observedContracts, 0);
  assert.equal(buildGlobalScanProof({ ...capture, selectedTokenAddresses: [] }).excludedTokenAddresses.length, 2);
});
test('rejects partial reads, unvalidated selected logs, bad hashes, counts and oversized ranges', () => {
  for (const invalid of [{ source: 'rpc' }, { complete: false }, { selectedLogsValidated: false },
    { observedLogs: 1 }, { observedLogs: 1, observedTokenAddresses: [] },
    { observedLogs: 100001 }, { checkpointHash: 'invalid' },
    { throughBlock: '99' }, { throughBlock: '5100' }, { fromBlock: -1 },
    { observedTokenAddresses: ['invalid'] }, { observedTokenAddresses: Array(10001).fill(tokens[0]) }]) {
    assert.throws(() => buildGlobalScanProof({ ...capture, ...invalid }), /invalid|requires|prove/);
  }
});
