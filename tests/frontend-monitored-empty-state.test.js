const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  resolveMonitoredEmptyStateContent,
} = require('../frontend/src/utils/monitored-empty-state.ts');

describe('monitored empty-state content', () => {
  it('distinguishes a load failure from valid empty results', () => {
    assert.deepEqual(resolveMonitoredEmptyStateContent({
      loadError: 'statement timeout', hasSearchQuery: false,
    }), {
      icon: '!',
      text: 'Monitored tokens could not be loaded. Retrying automatically.',
      isError: true,
    });

    assert.equal(resolveMonitoredEmptyStateContent({
      loadError: null, hasSearchQuery: false,
    }).text, 'No monitored tokens are available for the current filters.');
  });

  it('keeps the search-specific empty message when loading succeeded', () => {
    assert.equal(resolveMonitoredEmptyStateContent({
      loadError: null, hasSearchQuery: true,
    }).text, 'No monitored tokens match the current search.');
  });
});
