'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage162 = require('../src/utils/db-init-stage162');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('permanent callout archive and summary schema', () => {
  it('archives normalized source evidence without extending raw event visibility', () => {
    const sql = stage162.STATEMENTS.join('\n');
    const archive = stage162.STATEMENTS.find((statement) => (
      statement.includes('callout_thesis_archive (')
    ));

    assert.match(archive, /dedupe_key TEXT PRIMARY KEY/);
    assert.match(archive, /thesis TEXT/);
    assert.match(archive, /thesis_sha256 VARCHAR\(64\)/);
    assert.match(archive, /source_metadata JSONB NOT NULL/);
    assert.doesNotMatch(archive, /expires_at|ON DELETE CASCADE/);
    assert.doesNotMatch(sql, /ALTER TABLE callout_events|DROP\s+|DELETE\s+FROM/i);
  });

  it('keeps successful summaries immutable, versioned and attributable', () => {
    const summaries = stage162.STATEMENTS.find((statement) => (
      statement.includes('callout_summary_versions (')
    ));

    assert.match(summaries, /UNIQUE \(cluster_key, version\)/);
    assert.match(summaries, /source_count >= 4/);
    assert.match(summaries, /jsonb_array_length\(source_snapshot\) = source_count/);
    assert.match(summaries, /provider VARCHAR\(32\) NOT NULL/);
    assert.match(summaries, /model TEXT NOT NULL/);
    assert.match(summaries, /prompt_version TEXT NOT NULL/);
    assert.match(summaries, /supersedes_summary_key TEXT/);
    assert.doesNotMatch(summaries, /expires_at|ON DELETE CASCADE/);
  });

  it('requires the complete Stage 162 contract at runtime', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage162-callout-archive-summaries'
    ));

    assert.equal(group.repair, 'node src/utils/db-init-stage162.js');
    assert.deepEqual(
      group.tables.map(({ table }) => table),
      ['callout_thesis_archive', 'callout_summary_versions']
    );
    assert.ok(group.tables.every(({ constraints }) => constraints.length > 0));
    assert.ok(group.tables.every(({ indexes }) => indexes.length > 0));
  });
});
