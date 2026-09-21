'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');

const {
  captureTransferPreimages,
} = require('../src/models/robinhood-wallet-transfer-reorg-journal');

const TOKEN = `0x${'1'.repeat(40)}`;
const FROM = `0x${'2'.repeat(40)}`;
const TO = `0x${'3'.repeat(40)}`;

it('loads edge preimages through the composite primary-key columns', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT INTO robinhood_wallet_transfer_reorg_journal')) {
        return { rowCount: JSON.parse(params[2]).length };
      }
      return { rows: [] };
    },
  };

  await captureTransferPreimages(client, 'rh_transfer_v1', [{
    block: '100',
    blockHash: `0x${'4'.repeat(64)}`,
    blockTime: '2026-09-18T00:00:00.000Z',
    tokenAddress: TOKEN,
    fromWallet: FROM,
    toWallet: TO,
    transferKind: 'dex_flow',
  }]);

  const edgeLookup = calls[0];
  assert.match(edgeLookup.sql, /edge\.token_address=requested\.token_address/);
  assert.match(edgeLookup.sql, /edge\.from_wallet=requested\.from_wallet/);
  assert.match(edgeLookup.sql, /edge\.to_wallet=requested\.to_wallet/);
  assert.doesNotMatch(edgeLookup.sql, /'edge:' \|\| token_address/);
  assert.deepEqual(JSON.parse(edgeLookup.params[2]), [{
    identity_key: `edge:${TOKEN}:${FROM}:${TO}`,
    token_address: TOKEN,
    from_wallet: FROM,
    to_wallet: TO,
  }]);
});

it('loads relationship evidence preimages through the composite slot index', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT INTO robinhood_wallet_transfer_reorg_journal')) {
        return { rowCount: JSON.parse(params[2]).length };
      }
      return { rows: [] };
    },
  };

  await captureTransferPreimages(client, 'rh_transfer_v1', [{
    block: '100',
    blockHash: `0x${'4'.repeat(64)}`,
    blockTime: '2026-09-18T00:00:00.000Z',
    tokenAddress: TOKEN,
    fromWallet: TO,
    toWallet: FROM,
    transferKind: 'wallet_transfer',
  }]);

  const evidenceLookup = calls.find(({ sql }) => (
    sql.includes('JOIN robinhood_wallet_relationship_evidence evidence')
  ));
  assert.ok(evidenceLookup);
  assert.match(evidenceLookup.sql, /FROM jsonb_to_recordset\(\$3::jsonb\)/);
  assert.match(evidenceLookup.sql, /COALESCE\(evidence\.token_address,/);
  assert.match(evidenceLookup.sql, /=requested\.token_address/);
  assert.match(evidenceLookup.sql, /evidence\.left_wallet=requested\.left_wallet/);
  assert.match(evidenceLookup.sql, /evidence\.right_wallet=requested\.right_wallet/);
  assert.match(evidenceLookup.sql, /evidence\.relationship_kind='direct_token_transfer'/);
  assert.match(evidenceLookup.sql, /evidence\.evidence_role=requested\.evidence_role/);
  assert.doesNotMatch(evidenceLookup.sql, /'evidence:' \|\| token_address/);
  assert.deepEqual(JSON.parse(evidenceLookup.params[2]), [
    {
      identity_key: `evidence:${TOKEN}:${FROM}:${TO}:first`,
      token_address: TOKEN,
      left_wallet: FROM,
      right_wallet: TO,
      evidence_role: 'first',
    },
    {
      identity_key: `evidence:${TOKEN}:${FROM}:${TO}:last`,
      token_address: TOKEN,
      left_wallet: FROM,
      right_wallet: TO,
      evidence_role: 'last',
    },
    {
      identity_key: `evidence:${TOKEN}:${FROM}:${TO}:largest`,
      token_address: TOKEN,
      left_wallet: FROM,
      right_wallet: TO,
      evidence_role: 'largest',
    },
  ]);
});
