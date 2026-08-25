'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage161 = require('../src/utils/db-init-stage161');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Pump/Fomo callout capture schema', () => {
  it('keeps identities while giving raw callouts an exact 72-hour lifetime', () => {
    const sql = stage161.STATEMENTS.join('\n');
    const profiles = stage161.STATEMENTS.find((statement) => statement.includes('callout_profiles ('));
    const wallets = stage161.STATEMENTS.find((statement) => statement.includes('callout_wallet_observations ('));
    const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage161-callout-capture-foundation');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS callout_profiles/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS callout_wallet_observations/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS callout_events/);
    assert.match(sql, /expires_at = captured_at \+ INTERVAL '72 hours'/);
    assert.doesNotMatch(profiles, /expires_at/);
    assert.doesNotMatch(wallets, /expires_at/);
    assert.equal(group.repair, 'node src/utils/db-init-stage161.js');
  });

  it('models wallet ownership as durable evidence rather than one mutable wallet field', () => {
    const sql = stage161.STATEMENTS.join('\n');

    assert.match(sql, /observation_key TEXT PRIMARY KEY/);
    assert.match(sql, /relation_type VARCHAR\(32\) NOT NULL/);
    assert.match(sql, /source_type VARCHAR\(32\) NOT NULL/);
    assert.match(sql, /source_record_id TEXT/);
    assert.match(sql, /first_observed_at TIMESTAMPTZ NOT NULL/);
    assert.match(sql, /last_observed_at TIMESTAMPTZ NOT NULL/);
  });

  it('provides a durable checkpoint for commit-coupled worker progress', () => {
    const sql = stage161.STATEMENTS.join('\n');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS callout_collector_checkpoints/);
    assert.match(sql, /state JSONB NOT NULL/);
    assert.doesNotMatch(sql, /\bUPDATE\b|DELETE\s+FROM|DROP\s+/i);
  });
});
