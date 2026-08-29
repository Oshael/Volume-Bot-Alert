const { createHash } = require('node:crypto');

const RULE_VERSION = 'rh_possible_bundle_v1';
const EVIDENCE_VERSION = 'rh_native_funding_v2';
const ADDRESS = /^0x[0-9a-f]{40}$/;

function address(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!ADDRESS.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function unsigned(value, label) {
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
}

function sourceLineage(input) {
  const sourceKind = String(input.sourceKind || '');
  if (sourceKind === 'seed') {
    const sourceRunId = unsigned(input.sourceRunId, 'sourceRunId');
    if (sourceRunId < 1n) throw new Error('possible bundle source is invalid');
    return { sourceKind, sourceRunId: sourceRunId.toString(), sourceVersion: null };
  }
  if (sourceKind === 'live') {
    const sourceVersion = unsigned(input.sourceVersion, 'sourceVersion');
    if (sourceVersion < 1n) throw new Error('possible bundle source is invalid');
    return { sourceKind, sourceRunId: null, sourceVersion: sourceVersion.toString() };
  }
  throw new Error('possible bundle source is invalid');
}

function candidateRow(item, tokenAddress) {
  if (address(item.tokenAddress, 'candidate tokenAddress') !== tokenAddress) {
    throw new Error('candidate token does not match materialization token');
  }
  const launchBlock = unsigned(item.launchBlock, 'launchBlock');
  const firstBuyBlock = unsigned(item.firstBuyBlock, 'firstBuyBlock');
  const firstBuyTransactionIndex = unsigned(
    item.firstBuyTransactionIndex, 'firstBuyTransactionIndex'
  );
  if (firstBuyBlock < launchBlock || firstBuyBlock > launchBlock + 3n) {
    throw new Error('candidate first buy is outside launch + 3');
  }
  return Object.freeze({
    tokenAddress, walletAddress: address(item.walletAddress, 'candidate walletAddress'),
    launchBlock: launchBlock.toString(), firstBuyBlock: firstBuyBlock.toString(),
    firstBuyTransactionIndex: firstBuyTransactionIndex.toString(),
  });
}

function evidenceRow(item, tokenAddress, candidates) {
  if (address(item.tokenAddress, 'evidence tokenAddress') !== tokenAddress) {
    throw new Error('evidence token does not match materialization token');
  }
  const candidateWallet = address(item.candidateWallet, 'candidateWallet');
  if (!candidates.has(candidateWallet)) return null;
  const hop = Number(item.hop);
  if (hop !== 1 && hop !== 2) throw new Error('funding evidence hop must be 1 or 2');
  const fromAddress = address(item.fromAddress, 'fromAddress');
  const toAddress = address(item.toAddress, 'toAddress');
  if ((hop === 1 && toAddress !== candidateWallet)
      || (hop === 2 && (toAddress === candidateWallet || fromAddress === candidateWallet))) {
    throw new Error('funding evidence path is invalid');
  }
  const valueWei = unsigned(item.valueWei, 'valueWei');
  if (valueWei === 0n) throw new Error('funding evidence value must be positive');
  return Object.freeze({
    candidateWallet, hop, fromAddress, toAddress, valueWei,
    blockNumber: String(item.blockNumber), transactionIndex: String(item.transactionIndex),
    transactionHash: String(item.transactionHash),
  });
}

function addAmount(map, key, event) {
  const bucket = map.get(key) || { value: 0n, events: [] };
  bucket.value += event.valueWei;
  bucket.events.push(event);
  map.set(key, bucket);
}

function addPath(paths, source, kind, value, events) {
  const path = paths.get(source) || { value: 0n, kinds: new Set(), events: new Map() };
  path.value += value;
  path.kinds.add(kind);
  for (const event of events) path.events.set(`${event.transactionHash}:${event.hop}`, event);
  paths.set(source, path);
}

function candidatePaths(evidence, minimumValueWei, barriers) {
  const direct = new Map();
  const ancestors = new Map();
  for (const event of evidence) {
    const target = event.hop === 1 ? direct : ancestors;
    addAmount(target, `${event.fromAddress}:${event.toAddress}`, event);
  }
  const paths = new Map();
  for (const bucket of direct.values()) {
    const funder = bucket.events[0].fromAddress;
    if (barriers.has(funder)) continue;
    if (bucket.value >= minimumValueWei) {
      addPath(paths, funder, 'direct', bucket.value, bucket.events);
    }
    for (const ancestor of ancestors.values()) {
      if (ancestor.events[0].toAddress !== funder) continue;
      const capacity = ancestor.value < bucket.value ? ancestor.value : bucket.value;
      if (capacity >= minimumValueWei) {
        addPath(paths, ancestor.events[0].fromAddress, 'two_hop', capacity,
          [...ancestor.events, ...bucket.events]);
      }
    }
  }
  return paths;
}

function eventJson(event) {
  return Object.freeze({
    transactionHash: event.transactionHash, hop: event.hop,
    blockNumber: event.blockNumber, transactionIndex: event.transactionIndex,
    fromAddress: event.fromAddress, toAddress: event.toAddress,
    valueWei: event.valueWei.toString(),
  });
}

function compareEvidence(left, right) {
  const blocks = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (blocks !== 0n) return blocks < 0n ? -1 : 1;
  const indexes = BigInt(left.transactionIndex) - BigInt(right.transactionIndex);
  if (indexes !== 0n) return indexes < 0n ? -1 : 1;
  return left.transactionHash.localeCompare(right.transactionHash) || left.hop - right.hop;
}

function connectorKind(source, memberPaths, candidateWallets) {
  const paths = [...memberPaths.values()].filter(Boolean);
  if (candidateWallets.has(source) && paths.some(({ kinds }) => kinds.has('direct'))) {
    return 'member_funder';
  }
  return paths.every(({ kinds }) => kinds.size === 1 && kinds.has('direct'))
    ? 'common_funder' : 'connected_ancestor';
}

function buildConnections(pathsByCandidate, candidates, barriers) {
  const bySource = new Map();
  for (const [wallet, paths] of pathsByCandidate) {
    for (const [source, path] of paths) {
      if (barriers.has(source)) continue;
      const members = bySource.get(source) || new Map();
      members.set(wallet, path);
      bySource.set(source, members);
    }
  }
  const candidateWallets = new Set(candidates.keys());
  const connections = [];
  for (const [sourceAddress, memberPaths] of bySource) {
    if (candidateWallets.has(sourceAddress)) memberPaths.set(sourceAddress, null);
    if (memberPaths.size < 2) continue;
    const fundedPaths = [...memberPaths.values()].filter(Boolean);
    const qualifyingValueWei = fundedPaths.reduce((lowest, path) => (
      lowest == null || path.value < lowest ? path.value : lowest
    ), null);
    const evidence = new Map();
    for (const path of fundedPaths) {
      for (const [key, event] of path.events) evidence.set(key, event);
    }
    connections.push(Object.freeze({
      sourceAddress, kind: connectorKind(sourceAddress, memberPaths, candidateWallets),
      memberWallets: Object.freeze([...memberPaths.keys()].sort()),
      directRecipients: Object.freeze([...memberPaths].filter(([, path]) => (
        path?.kinds.has('direct')
      )).map(([wallet]) => wallet).sort()),
      twoHopRecipients: Object.freeze([...memberPaths].filter(([, path]) => (
        path?.kinds.has('two_hop')
      )).map(([wallet]) => wallet).sort()),
      qualifyingValueWei: qualifyingValueWei.toString(),
      evidence: Object.freeze([...evidence.values()].sort(compareEvidence).map(eventJson)),
    }));
  }
  return Object.freeze(connections.sort((left, right) => (
    left.sourceAddress.localeCompare(right.sourceAddress)
  )));
}

function connectedComponents(candidates, connections) {
  const parent = new Map([...candidates.keys()].map((wallet) => [wallet, wallet]));
  function root(wallet) {
    let current = wallet;
    while (parent.get(current) !== current) current = parent.get(current);
    parent.set(wallet, current);
    return current;
  }
  function union(left, right) {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot < rightRoot) parent.set(rightRoot, leftRoot);
    else if (rightRoot < leftRoot) parent.set(leftRoot, rightRoot);
  }
  for (const connection of connections) {
    for (const wallet of connection.memberWallets.slice(1)) {
      union(connection.memberWallets[0], wallet);
    }
  }
  const components = new Map();
  for (const wallet of candidates.keys()) {
    const key = root(wallet);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(wallet);
  }
  return [...components.values()].map((wallets) => wallets.sort())
    .filter((wallets) => wallets.length >= 2).sort((left, right) => left[0].localeCompare(right[0]));
}

function bundleId(tokenAddress, memberWallets) {
  return `0x${createHash('sha256').update(
    `${tokenAddress}:${RULE_VERSION}:${memberWallets.join(',')}`
  ).digest('hex')}`;
}

function memberKind(wallet, connections) {
  let direct = false;
  let connected = false;
  for (const connection of connections) {
    if (!connection.memberWallets.includes(wallet)) continue;
    if (connection.kind !== 'member_funder') connected = true;
    else if (connection.sourceAddress === wallet) {
      direct ||= connection.directRecipients.length > 0;
      connected ||= connection.twoHopRecipients.length > 0;
    } else {
      direct ||= connection.directRecipients.includes(wallet);
      connected ||= connection.twoHopRecipients.includes(wallet);
    }
  }
  return direct && connected ? 'mixed'
    : direct ? 'direct_member_funding' : 'connected_funding_ancestor';
}

function materializePossibleBundles(input = {}) {
  const tokenAddress = address(input.tokenAddress, 'tokenAddress');
  const minimumValueWei = unsigned(input.minimumValueWei, 'minimumValueWei');
  const lookbackBlocks = unsigned(input.lookbackBlocks, 'lookbackBlocks');
  if (minimumValueWei === 0n || lookbackBlocks === 0n) {
    throw new Error('possible bundle policy values must be positive');
  }
  if (input.evidenceVersion !== EVIDENCE_VERSION) {
    throw new Error(`possible bundle evidence version must be ${EVIDENCE_VERSION}`);
  }
  const { sourceKind, sourceRunId, sourceVersion } = sourceLineage(input);
  const throughBlockNumber = unsigned(input.throughBlockNumber, 'throughBlockNumber');
  const throughBlockHash = String(input.throughBlockHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(throughBlockHash)) throw new Error('throughBlockHash is invalid');
  const barriers = new Set((input.barrierAddresses || []).map((item) => address(item, 'barrier')));
  const candidates = new Map((input.candidates || []).map((item) => {
    const candidate = candidateRow(item, tokenAddress);
    return [candidate.walletAddress, candidate];
  }).filter(([wallet]) => !barriers.has(wallet)));
  const evidenceByCandidate = new Map([...candidates.keys()].map((wallet) => [wallet, []]));
  for (const item of input.evidence || []) {
    const event = evidenceRow(item, tokenAddress, candidates);
    if (event) evidenceByCandidate.get(event.candidateWallet).push(event);
  }
  const pathsByCandidate = new Map([...evidenceByCandidate].map(([wallet, evidence]) => (
    [wallet, candidatePaths(evidence, minimumValueWei, barriers)]
  )));
  const connections = buildConnections(pathsByCandidate, candidates, barriers);
  const groups = connectedComponents(candidates, connections).map((memberWallets) => {
    const memberSet = new Set(memberWallets);
    const groupConnections = connections.filter(({ memberWallets: related }) => (
      related.some((wallet) => memberSet.has(wallet))
    ));
    const id = bundleId(tokenAddress, memberWallets);
    return Object.freeze({
      tokenAddress, ruleVersion: RULE_VERSION, bundleId: id,
      memberCount: memberWallets.length, connectionCount: groupConnections.length,
      qualifyingValueWei: groupConnections.reduce((lowest, connection) => {
        const value = BigInt(connection.qualifyingValueWei);
        return lowest == null || value < lowest ? value : lowest;
      }, null).toString(),
      evidenceJson: Object.freeze({ signal: 'connected_funding_launch_cluster',
        evidenceVersion: EVIDENCE_VERSION, connections: Object.freeze(groupConnections) }),
      members: Object.freeze(memberWallets.map((wallet) => Object.freeze({
        ...candidates.get(wallet), bundleId: id,
        connectionKind: memberKind(wallet, groupConnections),
        evidenceJson: Object.freeze({ signal: 'connected_funding_launch_cluster',
          sources: Object.freeze(groupConnections.filter(({ memberWallets: related }) => (
            related.includes(wallet)
          )).map(({ sourceAddress }) => sourceAddress)) }),
      }))),
    });
  });
  return Object.freeze({
    state: Object.freeze({ tokenAddress, ruleVersion: RULE_VERSION,
      evidenceVersion: EVIDENCE_VERSION, status: 'ready',
      statusReason: groups.length ? 'groups_found' : 'no_groups',
      sourceKind, sourceRunId, sourceVersion,
      lookbackBlocks: lookbackBlocks.toString(), minimumValueWei: minimumValueWei.toString(),
      throughBlockNumber: throughBlockNumber.toString(), throughBlockHash }),
    groups: Object.freeze(groups),
    members: Object.freeze(groups.flatMap(({ members }) => members)),
  });
}

module.exports = { EVIDENCE_VERSION, RULE_VERSION, materializePossibleBundles };
