const revisions = { prices: 0n, reorg: 0n };

function advanceGainersRevision(source, version) {
  if (Object.hasOwn(revisions, source) && version > revisions[source]) revisions[source] = version;
}

function getGainersReorgRevision() {
  return revisions.reorg.toString();
}

function getGainersPriceRevision() {
  return revisions.prices.toString();
}

module.exports = { advanceGainersRevision, getGainersReorgRevision, getGainersPriceRevision };
