const db = require('./db');
const {
  EVIDENCE_VERSION, RULE_VERSION,
} = require('../services/robinhood-possible-bundle-materializer');

const CHAIN = 'robinhood';
const MAX_GROUPS = 5_000;
const MAX_MEMBERS = 10_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

function positive(value, label) {
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized) || BigInt(normalized) < 1n) {
    throw new Error(`${label} must be positive`);
  }
  return normalized;
}

function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length === 0) throw new Error(`${label} must be a non-empty object`);
  return value;
}

function normalizeSource(state) {
  if (state.sourceKind === 'seed') return Object.freeze({
    sourceRunId: positive(state.sourceRunId, 'sourceRunId'), sourceVersion: null,
  });
  if (state.sourceKind === 'live') return Object.freeze({
    sourceRunId: null, sourceVersion: positive(state.sourceVersion, 'sourceVersion'),
  });
  throw new Error('possible bundle snapshot lineage is invalid');
}

function normalizeSnapshot(snapshot, observedAt) {
  const { state = {}, groups = [], members = [] } = snapshot || {};
  if (state.ruleVersion !== RULE_VERSION || state.evidenceVersion !== EVIDENCE_VERSION
      || state.status !== 'ready') {
    throw new Error('possible bundle snapshot lineage is invalid');
  }
  if (!ADDRESS.test(state.tokenAddress) || !HASH.test(state.throughBlockHash)) {
    throw new Error('possible bundle snapshot frontier is invalid');
  }
  if (!['groups_found', 'no_groups'].includes(state.statusReason)) {
    throw new Error('possible bundle snapshot status reason is invalid');
  }
  if (!Array.isArray(groups) || groups.length > MAX_GROUPS
      || !Array.isArray(members) || members.length > MAX_MEMBERS) {
    throw new Error('possible bundle snapshot exceeds persistence limits');
  }
  const normalizedState = Object.freeze({ ...state, ...normalizeSource(state),
    lookbackBlocks: positive(state.lookbackBlocks, 'lookbackBlocks'),
    minimumValueWei: positive(state.minimumValueWei, 'minimumValueWei'),
    throughBlockNumber: positive(state.throughBlockNumber, 'throughBlockNumber'),
    observedAt: new Date(observedAt).toISOString(),
  });
  const groupIds = new Set();
  const normalizedGroups = groups.map((group) => {
    if (group.tokenAddress !== state.tokenAddress || group.ruleVersion !== RULE_VERSION
        || !HASH.test(group.bundleId) || groupIds.has(group.bundleId)) {
      throw new Error('possible bundle group scope is invalid');
    }
    groupIds.add(group.bundleId);
    return Object.freeze({ ...group,
      memberCount: Number(group.memberCount), connectionCount: Number(group.connectionCount),
      qualifyingValueWei: positive(group.qualifyingValueWei, 'qualifyingValueWei'),
      evidenceJson: object(group.evidenceJson, 'group evidenceJson'),
    });
  });
  const wallets = new Set();
  const memberCounts = new Map();
  const normalizedMembers = members.map((member) => {
    if (member.tokenAddress !== state.tokenAddress || !ADDRESS.test(member.walletAddress)
        || !groupIds.has(member.bundleId) || wallets.has(member.walletAddress)) {
      throw new Error('possible bundle member scope is invalid');
    }
    wallets.add(member.walletAddress);
    memberCounts.set(member.bundleId, (memberCounts.get(member.bundleId) || 0) + 1);
    return Object.freeze({ ...member,
      launchBlock: String(member.launchBlock), firstBuyBlock: String(member.firstBuyBlock),
      firstBuyTransactionIndex: String(member.firstBuyTransactionIndex),
      evidenceJson: object(member.evidenceJson, 'member evidenceJson'),
    });
  });
  if (normalizedGroups.some((group) => group.memberCount !== memberCounts.get(group.bundleId))) {
    throw new Error('possible bundle group member count is inconsistent');
  }
  if ((normalizedGroups.length === 0) !== (state.statusReason === 'no_groups')) {
    throw new Error('possible bundle group status is inconsistent');
  }
  return Object.freeze({ state: normalizedState,
    groups: Object.freeze(normalizedGroups), members: Object.freeze(normalizedMembers) });
}

function assertLineage(lineage, state) {
  if (!lineage || lineage.status !== 'completed' || lineage.rule_version !== RULE_VERSION
      || lineage.evidence_version !== EVIDENCE_VERSION
      || lineage.source_through_block !== state.throughBlockNumber
      || lineage.source_through_hash !== state.throughBlockHash
      || lineage.lookback_blocks !== state.lookbackBlocks) {
    throw new Error('possible bundle source run does not match snapshot lineage');
  }
}

function assertLiveLineage(lineage, state) {
  if (!lineage || lineage.rule_version !== RULE_VERSION
      || lineage.evidence_version !== EVIDENCE_VERSION
      || lineage.token_address !== state.tokenAddress
      || lineage.requested_version !== state.sourceVersion
      || lineage.source_through_block !== state.throughBlockNumber
      || lineage.lookback_blocks !== state.lookbackBlocks) {
    throw new Error('possible bundle live queue does not match snapshot lineage');
  }
}

function frontierDecision(current, state) {
  if (!current) return 'replace';
  if (BigInt(current.through_block_number) > BigInt(state.throughBlockNumber)) return 'ignore';
  if (current.evidence_version !== state.evidenceVersion
      || current.lookback_blocks !== state.lookbackBlocks
      || current.minimum_value_wei !== state.minimumValueWei) {
    throw new Error('possible bundle snapshot policy drift requires a new rule version');
  }
  return current.through_block_number === state.throughBlockNumber
    ? equalFrontierDecision(current, state) : 'replace';
}

function equalFrontierDecision(current, state) {
  if (current.through_block_hash !== state.throughBlockHash) {
    throw new Error('possible bundle snapshot frontier fork');
  }
  if (current.source_kind === 'live' && state.sourceKind === 'seed') return 'ignore';
  if (current.source_kind === 'live' && state.sourceKind === 'live'
      && BigInt(current.source_version) > BigInt(state.sourceVersion)) return 'ignore';
  if (current.source_kind === 'seed' && state.sourceKind === 'seed'
      && current.source_run_id !== state.sourceRunId) {
    throw new Error('possible bundle snapshot lineage drift at equal frontier');
  }
  return 'replace';
}

async function persistGroups(client, state, groups) {
  if (!groups.length) return;
  await client.query(`INSERT INTO robinhood_possible_bundle_groups (
    chain, token_address, rule_version, bundle_id, member_count, connection_count,
    qualifying_value_wei, evidence_json
  ) SELECT $2, $3, $4, item.bundle_id, item.member_count, item.connection_count,
           item.qualifying_value_wei::numeric, item.evidence_json
      FROM jsonb_to_recordset($1::jsonb) AS item(bundle_id text, member_count integer,
        connection_count integer, qualifying_value_wei text, evidence_json jsonb)`,
  [JSON.stringify(groups.map((group) => ({ bundle_id: group.bundleId,
    member_count: group.memberCount, connection_count: group.connectionCount,
    qualifying_value_wei: group.qualifyingValueWei, evidence_json: group.evidenceJson }))),
  CHAIN, state.tokenAddress, state.ruleVersion]);
}

async function persistMembers(client, state, members) {
  if (!members.length) return;
  await client.query(`INSERT INTO robinhood_possible_bundle_members (
    chain, token_address, rule_version, bundle_id, wallet_address, launch_block,
    first_buy_block, first_buy_transaction_index, connection_kind, evidence_json
  ) SELECT $2, $3, $4, item.bundle_id, item.wallet_address, item.launch_block::bigint,
           item.first_buy_block::bigint, item.first_buy_transaction_index::integer,
           item.connection_kind, item.evidence_json
      FROM jsonb_to_recordset($1::jsonb) AS item(bundle_id text, wallet_address text,
        launch_block text, first_buy_block text, first_buy_transaction_index text,
        connection_kind text, evidence_json jsonb)`,
  [JSON.stringify(members.map((member) => ({ bundle_id: member.bundleId,
    wallet_address: member.walletAddress, launch_block: member.launchBlock,
    first_buy_block: member.firstBuyBlock,
    first_buy_transaction_index: member.firstBuyTransactionIndex,
    connection_kind: member.connectionKind, evidence_json: member.evidenceJson }))),
  CHAIN, state.tokenAddress, state.ruleVersion]);
}

function createRobinhoodPossibleBundleSnapshotRepository(options = {}) {
  const database = options.database || db;
  const now = options.now || (() => new Date().toISOString());

  async function replaceSnapshot(input) {
    const snapshot = normalizeSnapshot(input, now());
    const { state } = snapshot;
    if (state.sourceKind !== 'seed') throw new Error('live snapshots require queue transaction');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const lineage = (await client.query(
        `SELECT status, rule_version, evidence_version, source_through_block::text,
                source_through_hash, lookback_blocks::text
           FROM robinhood_bundle_funding_backfill_runs
          WHERE chain = $1 AND id = $2::bigint`, [CHAIN, state.sourceRunId]
      )).rows[0];
      const result = await replaceSnapshotWithClient(client, snapshot, lineage, now());
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ replaceSnapshot });
}

async function replaceSnapshotWithClient(client, input, lineage, observedAt) {
  const snapshot = normalizeSnapshot(input, observedAt);
  const { state, groups, members } = snapshot;
  if (state.sourceKind === 'seed') assertLineage(lineage, state);
  else assertLiveLineage(lineage, state);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${CHAIN}:${state.tokenAddress}:${state.ruleVersion}`,
  ]);
  const current = (await client.query(
    `SELECT evidence_version, source_kind, source_run_id::text, source_version::text,
            lookback_blocks::text, minimum_value_wei::text,
            through_block_number::text, through_block_hash
       FROM robinhood_possible_bundle_states
      WHERE chain = $1 AND token_address = $2 AND rule_version = $3 FOR UPDATE`,
    [CHAIN, state.tokenAddress, state.ruleVersion]
  )).rows[0];
  if (frontierDecision(current, state) === 'ignore') {
    return Object.freeze({ status: 'ignored', reason: 'frontier_behind' });
  }
  await client.query(`INSERT INTO robinhood_possible_bundle_states (
    chain, token_address, rule_version, evidence_version, status, status_reason,
    source_kind, source_run_id, source_version, lookback_blocks, minimum_value_wei,
    through_block_number, through_block_hash, observed_at
  ) VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7::bigint, $8::bigint, $9::bigint,
    $10::numeric, $11::bigint, $12, $13::timestamptz)
  ON CONFLICT (chain, token_address, rule_version) DO UPDATE SET
    evidence_version = EXCLUDED.evidence_version, status = EXCLUDED.status,
    status_reason = EXCLUDED.status_reason, source_kind = EXCLUDED.source_kind,
    source_run_id = EXCLUDED.source_run_id, source_version = EXCLUDED.source_version,
    lookback_blocks = EXCLUDED.lookback_blocks,
    minimum_value_wei = EXCLUDED.minimum_value_wei,
    through_block_number = EXCLUDED.through_block_number,
    through_block_hash = EXCLUDED.through_block_hash,
    observed_at = EXCLUDED.observed_at, updated_at = NOW()`,
  [CHAIN, state.tokenAddress, state.ruleVersion, state.evidenceVersion,
    state.statusReason, state.sourceKind, state.sourceRunId, state.sourceVersion,
    state.lookbackBlocks, state.minimumValueWei, state.throughBlockNumber,
    state.throughBlockHash, state.observedAt]);
  await client.query(`DELETE FROM robinhood_possible_bundle_groups
    WHERE chain = $1 AND token_address = $2 AND rule_version = $3`,
  [CHAIN, state.tokenAddress, state.ruleVersion]);
  await persistGroups(client, state, groups);
  await persistMembers(client, state, members);
  return Object.freeze({ status: 'published', groups: groups.length, members: members.length });
}

module.exports = { createRobinhoodPossibleBundleSnapshotRepository, replaceSnapshotWithClient,
  __private: {
    assertLineage, assertLiveLineage, frontierDecision, normalizeSnapshot,
    replaceSnapshotWithClient,
  } };
