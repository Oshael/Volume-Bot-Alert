'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { compareCandidate, __private } = require('../src/services/callout-summary-comparison');
const { blindReport } = require('../src/utils/compare-callout-summaries');

function candidate() {
  return {
    sourceCount: 4, asset: { chainKey: 'robinhood', address: '0xtoken' },
    window: { from: '2026-08-25T14:00:00Z', to: '2026-08-25T14:20:00Z' },
    sources: [1, 2, 3, 4].map((id) => ({
      id: `call-${id}`, platform: id % 2 ? 'fomo' : 'pump',
      occurredAt: `2026-08-25T14:0${id}:00Z`, thesis: `Thesis ${id}`,
    })),
  };
}

describe('callout summary provider comparison', () => {
  it('sends the identical guarded prompt to Gemini and GLM', async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (url.includes('generativelanguage')) return {
        ok: true, json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Gemini summary' }] } }],
          usageMetadata: { promptTokenCount: 10 },
        }),
      };
      return { ok: true, json: async () => ({
        choices: [{ message: { content: 'GLM summary' } }], usage: { prompt_tokens: 10 },
      }) };
    };

    const results = await compareCandidate(candidate(), {
      fetchImpl, geminiApiKey: 'gemini-secret', glmApiKey: 'glm-secret',
    });
    const geminiPrompt = requests[0].body.contents[0].parts[0].text;
    const glmPrompt = requests[1].body.messages[1].content;
    assert.equal(geminiPrompt, glmPrompt);
    assert.match(geminiPrompt, /UNTRUSTED_SOURCES_JSON/);
    assert.deepEqual(results.map(({ provider, text }) => ({ provider, text })), [
      { provider: 'gemini', text: 'Gemini summary' },
      { provider: 'glm', text: 'GLM summary' },
    ]);
    assert.equal(requests[0].options.headers['x-goog-api-key'], 'gemini-secret');
    assert.equal(requests[1].options.headers.authorization, 'Bearer glm-secret');
  });

  it('rejects undersized and oversized comparisons before calling a provider', () => {
    assert.throws(() => __private.buildPrompt({ sourceCount: 3, sources: [] }), TypeError);
    const oversized = candidate();
    oversized.sourceCount = __private.MAX_SOURCES + 1;
    oversized.sources = Array.from({ length: oversized.sourceCount }, (_, id) => ({ id }));
    assert.throws(() => __private.buildPrompt(oversized),
      (error) => error.code === 'CALLOUT_SUMMARY_COMPARISON_LIMIT');
  });

  it('requires both credentials before starting either request', () => {
    let requests = 0;
    assert.throws(() => compareCandidate(candidate(), {
      geminiApiKey: 'gemini-secret', fetchImpl: async () => { requests += 1; },
    }), (error) => error.code === 'ZAI_API_KEY');
    assert.equal(requests, 0);
  });

  it('keeps provider identity out of the blind report', () => {
    const blind = blindReport(candidate(), [
      { provider: 'gemini', model: 'g', text: 'one', latencyMs: 1, usage: null },
      { provider: 'glm', model: 'z', text: 'two', latencyMs: 2, usage: null },
    ]);
    assert.deepEqual(blind.report.outputs.map(({ label }) => label), ['A', 'B']);
    assert.equal(JSON.stringify(blind.report).includes('gemini'), false);
    assert.equal(JSON.stringify(blind.report).includes('glm'), false);
    assert.deepEqual(blind.key.mapping.map(({ provider }) => provider).sort(), ['gemini', 'glm']);
  });
});
