const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const diagnostics = require('../src/utils/collect-vps-load-diagnostics');

describe('vps load diagnostics collector helpers', () => {
  it('parses runtime options with safe defaults', () => {
    const args = diagnostics.parseArgs([
      '--samples',
      '3',
      '--interval-ms',
      '250',
      '--output',
      '/tmp/out.jsonl',
      '--no-db',
    ]);

    assert.equal(args.samples, 3);
    assert.equal(args.intervalMs, 1000);
    assert.equal(args.output, '/tmp/out.jsonl');
    assert.equal(args.noDb, true);
  });

  it('parses ps rows and sorts by cpu usage', () => {
    const output = [
      '10 1 S 2.5 1.0 00:10 node node src/server.js',
      '20 1 R 88.2 0.5 00:02 gmgn-cli gmgn-cli market trending',
    ].join('\n');

    const rows = diagnostics.parsePsRows(
      output,
      ['pid', 'ppid', 'stat', 'pcpu', 'pmem', 'etime', 'comm'],
      2
    );

    assert.equal(rows[0].pid, 20);
    assert.equal(rows[0].pcpu, 88.2);
    assert.equal(rows[0].comm, 'gmgn-cli');
    assert.equal(rows[0].args, 'gmgn-cli market trending');
    assert.equal(rows[1].pid, 10);
  });
});
