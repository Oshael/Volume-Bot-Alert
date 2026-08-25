'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createCalloutSummaryCandidateRead, __private,
} = require('../src/models/callout-summary-candidate-read');

const FROM = '2026-08-25T14:00:00.000Z';
const TO = '2026-08-25T14:20:00.000Z';
const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01';

function row(index, overrides = {}) {
  return {
    dedupe_key: `callout-${index}`, platform: index % 2 ? 'fomo' : 'pump',
    platform_event_id: `event-${index}`, platform_user_id: `profile-${index}`,
    occurred_at: `2026-08-25T14:${String(index).padStart(2, '0')}:00.000Z`,
    captured_at: `2026-08-25T14:${String(index).padStart(2, '0')}:01.000Z`,
    asset_chain_key: 'robinhood', asset_address_normalized: TOKEN,
    thesis: ` Thesis ${index} `, thesis_sha256: `${index}`.padStart(64, '0'),
    source_metadata: { sourceLinks: [{ link: `https://x.com/post/${index}` }] },
    username: `user-${index}`, x_username: null, display_name: `User ${index}`,
    profile_picture_url: `https://images.example/${index}.png`,
    ...overrides,
  };
}

describe('callout summary candidate reader', () => {
  it('requires an explicit window between 10 and 30 minutes', () => {
    assert.equal(__private.normalizeWindow({ from: FROM, to: TO }).durationMs, 20 * 60_000);
    assert.throws(() => __private.normalizeWindow({
      from: FROM, to: '2026-08-25T14:09:59.000Z',
    }), (error) => error.code === 'INVALID_CALLOUT_SUMMARY_WINDOW');
    assert.throws(() => __private.normalizeWindow({
      from: FROM, to: '2026-08-25T14:30:01.000Z',
    }), (error) => error.code === 'INVALID_CALLOUT_SUMMARY_WINDOW');
  });

  it('reads permanent theses without applying raw-event retention', () => {
    assert.match(__private.SOURCES_SQL, /FROM callout_thesis_archive archived/);
    assert.match(__private.SOURCES_SQL, /asset_chain_key IS NOT NULL/);
    assert.match(__private.SOURCES_SQL, /NULLIF\(BTRIM\(archived\.thesis\), ''\) IS NOT NULL/);
    assert.doesNotMatch(__private.SOURCES_SQL, /callout_events|expires_at/);
  });

  it('combines Pump and Fomo only for the same chain and token', () => {
    const window = __private.normalizeWindow({ from: FROM, to: TO });
    const candidates = __private.groupCandidates(window, [
      row(1), row(2), row(3), row(4),
      row(5, { asset_address_normalized: '0x1111111111111111111111111111111111111111' }),
      row(6, { asset_address_normalized: '0x1111111111111111111111111111111111111111' }),
      row(7, { asset_address_normalized: '0x1111111111111111111111111111111111111111' }),
    ]);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sourceCount, 4);
    assert.deepEqual(candidates[0].platforms, ['fomo', 'pump']);
    assert.equal(candidates[0].asset.address, TOKEN);
    assert.equal(candidates[0].sources[0].thesis, 'Thesis 1');
    assert.deepEqual(candidates[0].sources[0].links, [{ link: 'https://x.com/post/1', text: null, provider: null }]);
  });

  it('produces stable cluster and source fingerprints', () => {
    const window = __private.normalizeWindow({ from: FROM, to: TO });
    const first = __private.candidateFromGroup(window, [row(1), row(2), row(3), row(4)]);
    const replay = __private.candidateFromGroup(window, [row(1), row(2), row(3), row(4)]);
    const changed = __private.candidateFromGroup(window, [row(1), row(2), row(3), row(5)]);
    assert.equal(first.clusterKey, replay.clusterKey);
    assert.equal(first.sourceFingerprint, replay.sourceFingerprint);
    assert.notEqual(first.sourceFingerprint, changed.sourceFingerprint);
  });

  it('fails closed instead of returning candidates from a truncated source set', async () => {
    const calls = [];
    const database = {
      queryWithStatementTimeout: async (sql, params, timeoutMs) => {
        calls.push({ sql, params, timeoutMs });
        return { rows: [row(1), row(2), row(3), row(4), row(5)] };
      },
    };
    const reader = createCalloutSummaryCandidateRead({ database });
    await assert.rejects(reader.listCandidates({ from: FROM, to: TO, sourceLimit: 4 }),
      (error) => error.code === 'CALLOUT_SUMMARY_SOURCE_LIMIT');
    assert.deepEqual(calls[0].params, [FROM, TO, 5]);
    assert.equal(calls[0].timeoutMs, __private.DEFAULT_STATEMENT_TIMEOUT_MS);
  });
});
