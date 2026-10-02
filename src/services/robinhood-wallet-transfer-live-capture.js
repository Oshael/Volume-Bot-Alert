'use strict';

async function captureLiveRange(deps, range, cursor) {
  if (typeof deps.evidence.readSelectedRange === 'function') {
    const captured = await deps.evidence.readSelectedRange({ ...range, fromTime: cursor?.nextBlockTime });
    if (!captured.globalScan || !Array.isArray(captured.selectedTokenAddresses)) {
      throw new Error('candidate capture is missing its global proof or selection');
    }
    return { captured, tokenAddresses: captured.selectedTokenAddresses,
      captureManifest: { globalScan: captured.globalScan } };
  }
  const tokenAddresses = await deps.source.listTrackedTokenAddresses();
  const captured = await deps.evidence.readRange({ tokenAddresses, ...range });
  return { captured, tokenAddresses, captureManifest: { captureScope: {
    fromBlock: captured.fromBlock, tokenAddresses, filterMode: captured.telemetry.filterMode } } };
}
module.exports = { captureLiveRange };
