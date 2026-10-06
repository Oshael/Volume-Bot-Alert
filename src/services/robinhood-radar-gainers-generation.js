let reorgRevision = 0n;

function advanceGainersReorgRevision(version) {
  if (version > reorgRevision) reorgRevision = version;
}

function getGainersReorgRevision() {
  return reorgRevision.toString();
}

module.exports = { advanceGainersReorgRevision, getGainersReorgRevision };
