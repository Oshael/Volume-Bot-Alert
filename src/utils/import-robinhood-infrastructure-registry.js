require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');

const db = require('../models/db');
const {
  runRegistryImport,
} = require('../services/robinhood-infrastructure-registry-import');

function parseArgs(argv) {
  const fileArgument = argv.find((argument) => argument.startsWith('--file='));
  if (!fileArgument?.slice('--file='.length)) throw new Error('--file=<manifest.json> is required');
  return Object.freeze({
    file: path.resolve(fileArgument.slice('--file='.length)),
    apply: argv.includes('--apply'),
  });
}

async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const readFile = options.readFile || fs.readFile;
  const manifest = JSON.parse(await readFile(args.file, 'utf8'));
  return runRegistryImport({ manifest, apply: args.apply }, options);
}

if (require.main === module) main().then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(`[RobinhoodInfrastructureImport] Failed: ${error.message}`);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
