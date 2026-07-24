const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Robinhood backfill operational artifacts', () => {
  it('starts in its isolated worker group without forcing legacy ingestion', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    const command = scripts['start:worker:robinhood-backfill'];

    assert.match(command, /BACKGROUND_WORKER_GROUPS=robinhood-backfill/);
    assert.doesNotMatch(command, /ROBINHOOD_INGESTION_ENABLED=true/);
    assert.match(command, /PORT=\$\{PORT:-3005\}/);
  });

  it('keeps the systemd environment fail-closed outside the backfill', () => {
    const environment = read('deploy/systemd/robinhood-backfill.env.example');

    assert.match(environment, /^BACKGROUND_WORKER_GROUPS=robinhood-backfill$/m);
    for (const variable of [
      'ROBINHOOD_INGESTION_ENABLED',
      'ROBINHOOD_TRANSPORT_ENABLED',
      'ROBINHOOD_PERSISTENCE_ENABLED',
      'ROBINHOOD_ALERTS_ENABLED',
      'ROBINHOOD_USER_VISIBILITY_ENABLED',
    ]) {
      assert.match(environment, new RegExp(`^${variable}=false$`, 'm'));
    }
    assert.match(environment, /^ROBINHOOD_SCAN_PROVIDER=drpc$/m);
    assert.match(environment, /^ROBINHOOD_DISCOVERY_SCAN_PROVIDER=drpc$/m);
    assert.match(environment, /^ROBINHOOD_USE_ALCHEMY=false$/m);
    assert.match(environment, /^ROBINHOOD_BACKFILL_ALCHEMY_TIMESTAMPS_ENABLED=true$/m);
    assert.match(environment, /^ROBINHOOD_BACKFILL_AGGREGATION_ENABLED=true$/m);
  });
});
