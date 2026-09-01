const { createHash } = require('node:crypto');
const db = require('./db');
const {
  EVIDENCE_VERSION, MAX_SELL_DELAY_MS, MIN_FAST_SELLERS, RULE_VERSION,
} = require('../services/robinhood-bundle-redistribution-policy');
const CHAIN = 'robinhood';
const MAX_GROUPS = 5_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

function address(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ADDRESS.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function unsigned(value, label) {
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function positive(value, label) {
  const normalized = unsigned(value, label);
  if (BigInt(normalized) < 1n) throw new Error(`${label} must be positive`);
  return normalized;
}

function hash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HASH.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function optionalFdv(value, label) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizePolicy(value) {
  const policy = object(value, 'redistribution policy');
  if (Number(policy.minimumDistinctRecipients) !== MIN_FAST_SELLERS
      || Number(policy.minimumRapidSellingRecipients) !== MIN_FAST_SELLERS
      || Number(policy.maximumRecipientSellDelayMs) !== MAX_SELL_DELAY_MS
      || policy.fdvIsClassificationGate !== false) {
    throw new Error('redistribution snapshot policy drift requires a new rule version');
  }
  return Object.freeze({
    minimumDistinctRecipients: MIN_FAST_SELLERS,
    minimumRapidSellingRecipients: MIN_FAST_SELLERS,
    maximumRecipientSellDelayMs: MAX_SELL_DELAY_MS,
    fdvIsClassificationGate: false,
  });
}

function normalizeSource(state) {
  if (state.sourceKind === 'seed') return Object.freeze({
    sourceRunId: positive(state.sourceRunId, 'sourceRunId'), sourceVersion: null,
  });
  if (state.sourceKind === 'live') return Object.freeze({
    sourceRunId: null, sourceVersion: positive(state.sourceVersion, 'sourceVersion'),
  });
  throw new Error('redistribution snapshot lineage is invalid');
}

function normalizePosition(value, indexName, label) {
  const item = object(value, label);
  return Object.freeze({
    blockNumber: unsigned(item.blockNumber, `${label} blockNumber`),
    transactionIndex: unsigned(item.transactionIndex, `${label} transactionIndex`),
    [indexName]: unsigned(item[indexName], `${label} ${indexName}`),
    transactionHash: hash(item.transactionHash, `${label} transactionHash`),
    blockTime: new Date(item.blockTime).toISOString(),
  });
}

function comparePosition(left, right) {
  for (const key of ['blockNumber', 'transactionIndex', 'actionIndex']) {
    const delta = BigInt(left[key]) - BigInt(right[key]);
    if (delta !== 0n) return delta < 0n ? -1 : 1;
  }
  return left.walletAddress.localeCompare(right.walletAddress);
}

function expectedBundleId(tokenAddress, wallets) {
  return `0x${createHash('sha256').update(
    `${tokenAddress}:${RULE_VERSION}:${wallets.sort().join(',')}`
  ).digest('hex')}`;
}

function normalizeRecipient(value, sourceBuy, sourceWallet) {
  const item = object(value, 'redistribution recipient evidence');
  const walletAddress = address(item.walletAddress, 'recipient walletAddress');
  if (walletAddress === sourceWallet) throw new Error('redistribution recipient equals source');
  const transfer = normalizePosition(item.transfer, 'logIndex', 'recipient transfer');
  const firstSell = normalizePosition(item.firstSell, 'actionIndex', 'recipient firstSell');
  const amountRaw = positive(item.transfer.amountRaw, 'recipient transfer amountRaw');
  const delayMs = Number(item.firstSell.delayMs);
  if (BigInt(transfer.blockNumber) <= BigInt(sourceBuy.blockNumber)
      || BigInt(firstSell.blockNumber) <= BigInt(transfer.blockNumber)
      || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_SELL_DELAY_MS) {
    throw new Error('redistribution recipient causal evidence is invalid');
  }
  return Object.freeze({ walletAddress,
    transfer: Object.freeze({ ...transfer, amountRaw }),
    firstSell: Object.freeze({ ...firstSell, delayMs,
      fdvUsd: optionalFdv(item.firstSell.fdvUsd, 'recipient firstSell fdvUsd') }),
  });
}

function assertMembers(group, sourceWallet, recipients) {
  if (!Array.isArray(group.members) || group.members.length !== recipients.length + 1) {
    throw new Error('redistribution group members are invalid');
  }
  const expected = new Map([[sourceWallet, 'redistribution_source'],
    ...recipients.map(({ walletAddress }) => [walletAddress, 'rapid_sell_recipient'])]);
  for (const member of group.members) {
    if (member.tokenAddress !== group.tokenAddress || member.bundleId !== group.bundleId
        || expected.get(member.walletAddress) !== member.connectionKind) {
      throw new Error('redistribution group members are invalid');
    }
    expected.delete(member.walletAddress);
  }
  if (expected.size) throw new Error('redistribution group members are invalid');
}

function memberRows(group, sourceBuy, recipients) {
  const common = { bundleId: group.bundleId, sourceBuy };
  return Object.freeze([Object.freeze({ ...common, walletAddress: group.sourceWallet,
    connectionKind: 'redistribution_source', transfer: null, firstSell: null }),
  ...recipients.map((recipient) => Object.freeze({ ...common,
    walletAddress: recipient.walletAddress, connectionKind: 'rapid_sell_recipient',
    transfer: recipient.transfer, firstSell: recipient.firstSell,
  }))]);
}

function normalizeGroup(value, tokenAddress) {
  const group = object(value, 'redistribution group');
  const sourceWallet = address(group.sourceWallet, 'redistribution sourceWallet');
  if (group.tokenAddress !== tokenAddress || group.ruleVersion !== RULE_VERSION
      || group.signal !== 'coordinated_token_redistribution') {
    throw new Error('redistribution group scope is invalid');
  }
  const evidence = object(group.evidenceJson, 'redistribution group evidence');
  if (evidence.evidenceVersion !== EVIDENCE_VERSION
      || Number(evidence.maximumRecipientSellDelayMs) !== MAX_SELL_DELAY_MS
      || !Array.isArray(evidence.recipients)) {
    throw new Error('redistribution group evidence version is invalid');
  }
  const sourceBuy = Object.freeze({
    ...normalizePosition(evidence.sourceBuy, 'actionIndex', 'source buy'),
    fdvUsd: optionalFdv(evidence.sourceBuy.fdvUsd, 'source buy fdvUsd'),
  });
  const recipients = evidence.recipients.map((item) => (
    normalizeRecipient(item, sourceBuy, sourceWallet)
  )).sort((left, right) => comparePosition(
    { ...left.firstSell, walletAddress: left.walletAddress },
    { ...right.firstSell, walletAddress: right.walletAddress }
  ));
  const recipientWallets = new Set(recipients.map(({ walletAddress }) => walletAddress));
  if (recipientWallets.size !== recipients.length || recipients.length < MIN_FAST_SELLERS
      || Number(group.connectionCount) !== recipients.length
      || Number(group.memberCount) !== recipients.length + 1) {
    throw new Error('redistribution group counts are invalid');
  }
  const bundleId = hash(group.bundleId, 'redistribution bundleId');
  if (bundleId !== expectedBundleId(tokenAddress, [sourceWallet, ...recipientWallets])) {
    throw new Error('redistribution bundleId is invalid');
  }
  assertMembers(group, sourceWallet, recipients);
  const confirmation = recipients[MIN_FAST_SELLERS - 1].firstSell;
  if (optionalFdv(group.confirmationFdvUsd, 'confirmationFdvUsd') !== confirmation.fdvUsd) {
    throw new Error('redistribution confirmation FDV is inconsistent');
  }
  const normalized = Object.freeze({ tokenAddress, bundleId, sourceWallet,
    memberCount: recipients.length + 1, connectionCount: recipients.length,
    confirmation, confirmationFdvUsd: confirmation.fdvUsd,
    evidenceJson: Object.freeze({ evidenceVersion: EVIDENCE_VERSION,
      maximumRecipientSellDelayMs: MAX_SELL_DELAY_MS, sourceBuy,
      recipients: Object.freeze(recipients) }) });
  return Object.freeze({ group: normalized,
    members: memberRows(normalized, sourceBuy, recipients) });
}

function normalizeSnapshot(input, observedAt) {
  const { state = {}, groups = [] } = input || {};
  if (state.ruleVersion !== RULE_VERSION || state.evidenceVersion !== EVIDENCE_VERSION
      || state.status !== 'ready' || !['groups_found', 'no_groups'].includes(state.statusReason)) {
    throw new Error('redistribution snapshot state is invalid');
  }
  const tokenAddress = address(state.tokenAddress, 'snapshot tokenAddress');
  if (!Array.isArray(groups) || groups.length > MAX_GROUPS) {
    throw new Error('redistribution snapshot groups are invalid');
  }
  const normalizedGroups = groups.map((group) => normalizeGroup(group, tokenAddress));
  const sources = new Set(normalizedGroups.map(({ group }) => group.sourceWallet));
  if (sources.size !== normalizedGroups.length
      || (normalizedGroups.length === 0) !== (state.statusReason === 'no_groups')) {
    throw new Error('redistribution snapshot group status is inconsistent');
  }
  return Object.freeze({
    state: Object.freeze({ ...state, ...normalizeSource(state), tokenAddress,
      policyJson: normalizePolicy(state.policyJson),
      throughBlockNumber: unsigned(state.throughBlockNumber, 'throughBlockNumber'),
      throughBlockHash: hash(state.throughBlockHash, 'throughBlockHash'),
      observedAt: new Date(observedAt).toISOString(),
    }),
    groups: Object.freeze(normalizedGroups.map(({ group }) => group)),
    members: Object.freeze(normalizedGroups.flatMap(({ members }) => members)),
  });
}

function samePolicy(left, right) {
  try { return JSON.stringify(normalizePolicy(left))
      === JSON.stringify(normalizePolicy(right)); } catch { return false; }
}

function frontierDecision(current, state) {
  if (!current) return 'replace';
  if (current.evidence_version !== state.evidenceVersion
      || !samePolicy(current.policy_json, state.policyJson)) {
    throw new Error('redistribution snapshot policy drift requires a new rule version');
  }
  if (BigInt(current.through_block_number) > BigInt(state.throughBlockNumber)) return 'ignore';
  if (current.through_block_number !== state.throughBlockNumber) return 'replace';
  if (current.through_block_hash !== state.throughBlockHash) {
    throw new Error('redistribution snapshot frontier fork');
  }
  if (current.source_kind === 'live' && state.sourceKind === 'seed') return 'ignore';
  if (current.source_kind === 'live' && state.sourceKind === 'live'
      && BigInt(current.source_version) > BigInt(state.sourceVersion)) return 'ignore';
  if (current.source_kind === 'seed' && state.sourceKind === 'seed'
      && current.source_run_id !== state.sourceRunId) {
    throw new Error('redistribution snapshot lineage drift at equal frontier');
  }
  return 'replace';
}

async function persistGroups(client, state, groups) {
  if (!groups.length) return;
  await client.query(`INSERT INTO robinhood_bundle_redistribution_groups (
    chain, token_address, rule_version, bundle_id, source_wallet, member_count,
    connection_count, confirmation_block, confirmation_transaction_index,
    confirmation_action_index, confirmation_transaction_hash,
    confirmation_fdv_usd, evidence_json
  ) SELECT $2, $3, $4, item.bundle_id, item.source_wallet, item.member_count,
      item.connection_count, item.confirmation_block::bigint,
      item.confirmation_transaction_index::integer,
      item.confirmation_action_index::integer, item.confirmation_transaction_hash,
      item.confirmation_fdv_usd::numeric, item.evidence_json
    FROM jsonb_to_recordset($1::jsonb) AS item(bundle_id text, source_wallet text,
      member_count integer, connection_count integer, confirmation_block text,
      confirmation_transaction_index text, confirmation_action_index text,
      confirmation_transaction_hash text, confirmation_fdv_usd text, evidence_json jsonb)`,
  [JSON.stringify(groups.map((group) => ({ bundle_id: group.bundleId,
    source_wallet: group.sourceWallet, member_count: group.memberCount,
    connection_count: group.connectionCount, confirmation_block: group.confirmation.blockNumber,
    confirmation_transaction_index: group.confirmation.transactionIndex,
    confirmation_action_index: group.confirmation.actionIndex,
    confirmation_transaction_hash: group.confirmation.transactionHash,
    confirmation_fdv_usd: group.confirmationFdvUsd, evidence_json: group.evidenceJson }))),
  CHAIN, state.tokenAddress, state.ruleVersion]);
}

function memberRecord(member) {
  const row = { bundle_id: member.bundleId, wallet_address: member.walletAddress,
    connection_kind: member.connectionKind, source_buy_block: member.sourceBuy.blockNumber,
    source_buy_transaction_index: member.sourceBuy.transactionIndex,
    source_buy_action_index: member.sourceBuy.actionIndex,
    source_buy_transaction_hash: member.sourceBuy.transactionHash,
    transfer_block: null, transfer_transaction_index: null, transfer_log_index: null,
    transfer_transaction_hash: null, transfer_amount_raw: null, sell_block: null,
    sell_transaction_index: null, sell_action_index: null, sell_transaction_hash: null,
    sell_delay_ms: null, evidence_json: { sourceBuy: member.sourceBuy } };
  if (member.transfer) Object.assign(row, {
    transfer_block: member.transfer.blockNumber,
    transfer_transaction_index: member.transfer.transactionIndex,
    transfer_log_index: member.transfer.logIndex,
    transfer_transaction_hash: member.transfer.transactionHash,
    transfer_amount_raw: member.transfer.amountRaw,
  });
  if (member.firstSell) Object.assign(row, {
    sell_block: member.firstSell.blockNumber,
    sell_transaction_index: member.firstSell.transactionIndex,
    sell_action_index: member.firstSell.actionIndex,
    sell_transaction_hash: member.firstSell.transactionHash,
    sell_delay_ms: member.firstSell.delayMs,
    evidence_json: { sourceBuy: member.sourceBuy,
      transfer: member.transfer, firstSell: member.firstSell },
  });
  return row;
}

async function persistMembers(client, state, members) {
  if (!members.length) return;
  await client.query(`INSERT INTO robinhood_bundle_redistribution_members (
    chain, token_address, rule_version, bundle_id, wallet_address, connection_kind,
    source_buy_block, source_buy_transaction_index, source_buy_action_index,
    source_buy_transaction_hash, transfer_block, transfer_transaction_index,
    transfer_log_index, transfer_transaction_hash, transfer_amount_raw, sell_block,
    sell_transaction_index, sell_action_index, sell_transaction_hash, sell_delay_ms,
    evidence_json
  ) SELECT $2, $3, $4, item.bundle_id, item.wallet_address, item.connection_kind,
      item.source_buy_block::bigint, item.source_buy_transaction_index::integer,
      item.source_buy_action_index::integer, item.source_buy_transaction_hash,
      item.transfer_block::bigint, item.transfer_transaction_index::integer,
      item.transfer_log_index::integer, item.transfer_transaction_hash,
      item.transfer_amount_raw::numeric, item.sell_block::bigint,
      item.sell_transaction_index::integer, item.sell_action_index::integer,
      item.sell_transaction_hash, item.sell_delay_ms::integer, item.evidence_json
    FROM jsonb_to_recordset($1::jsonb) AS item(bundle_id text, wallet_address text,
      connection_kind text, source_buy_block text, source_buy_transaction_index text,
      source_buy_action_index text, source_buy_transaction_hash text,
      transfer_block text, transfer_transaction_index text, transfer_log_index text,
      transfer_transaction_hash text, transfer_amount_raw text, sell_block text,
      sell_transaction_index text, sell_action_index text, sell_transaction_hash text,
      sell_delay_ms text, evidence_json jsonb)`,
  [JSON.stringify(members.map(memberRecord)), CHAIN, state.tokenAddress, state.ruleVersion]);
}

async function replaceWithClient(client, snapshot) {
  const { state, groups, members } = snapshot;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${CHAIN}:${state.tokenAddress}:${state.ruleVersion}`,
  ]);
  const current = (await client.query(`SELECT evidence_version, source_kind,
      source_run_id::text, source_version::text, through_block_number::text,
      through_block_hash, policy_json
    FROM robinhood_bundle_redistribution_states
    WHERE chain = $1 AND token_address = $2 AND rule_version = $3 FOR UPDATE`,
  [CHAIN, state.tokenAddress, state.ruleVersion])).rows[0];
  if (frontierDecision(current, state) === 'ignore') {
    return Object.freeze({ status: 'ignored', reason: 'frontier_behind' });
  }
  await client.query(`INSERT INTO robinhood_bundle_redistribution_states (
    chain, token_address, rule_version, evidence_version, status, status_reason,
    source_kind, source_run_id, source_version, through_block_number,
    through_block_hash, policy_json, observed_at
  ) VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7::bigint, $8::bigint,
    $9::bigint, $10, $11::jsonb, $12::timestamptz)
  ON CONFLICT (chain, token_address, rule_version) DO UPDATE SET
    evidence_version = EXCLUDED.evidence_version, status = EXCLUDED.status,
    status_reason = EXCLUDED.status_reason, source_kind = EXCLUDED.source_kind,
    source_run_id = EXCLUDED.source_run_id, source_version = EXCLUDED.source_version,
    through_block_number = EXCLUDED.through_block_number,
    through_block_hash = EXCLUDED.through_block_hash, policy_json = EXCLUDED.policy_json,
    observed_at = EXCLUDED.observed_at, updated_at = NOW()`,
  [CHAIN, state.tokenAddress, state.ruleVersion, state.evidenceVersion,
    state.statusReason, state.sourceKind, state.sourceRunId, state.sourceVersion,
    state.throughBlockNumber, state.throughBlockHash, JSON.stringify(state.policyJson),
    state.observedAt]);
  await client.query(`DELETE FROM robinhood_bundle_redistribution_groups
    WHERE chain = $1 AND token_address = $2 AND rule_version = $3`,
  [CHAIN, state.tokenAddress, state.ruleVersion]);
  await persistGroups(client, state, groups);
  await persistMembers(client, state, members);
  return Object.freeze({ status: 'published', groups: groups.length, members: members.length });
}

async function replaceRedistributionSnapshotWithClient(client, input, observedAt) {
  return replaceWithClient(client, normalizeSnapshot(
    input, observedAt || new Date().toISOString()
  ));
}

function createRobinhoodBundleRedistributionSnapshotRepository(options = {}) {
  const database = options.database || db;
  const now = options.now || (() => new Date().toISOString());
  async function replaceSnapshot(input) {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const result = await replaceRedistributionSnapshotWithClient(client, input, now());
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ replaceSnapshot });
}

module.exports = { createRobinhoodBundleRedistributionSnapshotRepository,
  replaceRedistributionSnapshotWithClient,
  __private: { frontierDecision, normalizeSnapshot, replaceWithClient } };
