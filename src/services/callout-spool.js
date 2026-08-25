'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|auth[-_]?token|access[-_]?token|refresh[-_]?token|jwt|csrf|csrf[-_]?token|x-csrf-token|ct0|session[-_]?token)$/i;

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function assertSafeRecord(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new TypeError(`Spool record contains forbidden key: ${key}`);
    if (Array.isArray(item)) item.forEach(assertSafeRecord);
    else assertSafeRecord(item);
  }
}

async function spoolBytes(directory, prefix) {
  let names;
  try { names = await fs.readdir(directory); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const sizes = await Promise.all(names.filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.ndjson'))
    .map((name) => fs.stat(path.join(directory, name)).then((stat) => stat.size)));
  return sizes.reduce((total, size) => total + size, 0);
}

function createCalloutSpool(options = {}) {
  const directory = path.resolve(String(options.directory || '').trim());
  const prefix = String(options.prefix || 'callouts').trim();
  if (!options.directory) throw new TypeError('Spool directory is required');
  if (!/^[a-z0-9_-]+$/i.test(prefix)) throw new TypeError('Invalid spool prefix');
  const maxFileBytes = positiveInteger(options.maxFileBytes, 5 * 1024 * 1024);
  const maxFileAgeMs = positiveInteger(options.maxFileAgeMs, 15 * 60 * 1000);
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, 100 * 1024 * 1024);
  const now = options.now || Date.now;
  const writerId = String(options.writerId || `${process.pid}-${randomUUID()}`).replace(/[^a-z0-9_-]/gi, '');
  let filePath = null;
  let fileBytes = 0;
  let openedAt = 0;
  let sequence = 0;
  let queue = Promise.resolve();

  async function appendNow(record) {
    assertSafeRecord(record);
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    if (line.length > maxFileBytes) throw Object.assign(new RangeError('Spool record exceeds file limit'), { code: 'CALLOUT_SPOOL_RECORD_LIMIT' });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const timestamp = now();
    if (!filePath || fileBytes + line.length > maxFileBytes || timestamp - openedAt >= maxFileAgeMs) {
      openedAt = timestamp;
      fileBytes = 0;
      filePath = path.join(directory, `${prefix}-${timestamp}-${writerId}-${sequence++}.ndjson`);
    }
    if (await spoolBytes(directory, prefix) + line.length > maxTotalBytes) {
      throw Object.assign(new RangeError('Spool total limit reached'), { code: 'CALLOUT_SPOOL_TOTAL_LIMIT' });
    }
    await fs.appendFile(filePath, line, { mode: 0o600 });
    fileBytes += line.length;
    return { filePath, bytes: line.length };
  }

  return {
    append(record) {
      const operation = queue.then(() => appendNow(record));
      queue = operation.catch(() => {});
      return operation;
    },
    getStatus: () => ({ filePath, fileBytes, openedAt }),
  };
}

async function readCalloutSpoolBatch(filePath, options = {}) {
  const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
  const limit = positiveInteger(options.limit, 100);
  const data = await fs.readFile(filePath);
  if (offset > data.length) throw new RangeError('Spool cursor exceeds file size');
  const records = [];
  let cursor = offset;
  let trailingPartial = false;
  while (records.length < limit && cursor < data.length) {
    const newline = data.indexOf(0x0a, cursor);
    if (newline < 0) { trailingPartial = true; break; }
    const line = data.subarray(cursor, newline).toString('utf8');
    cursor = newline + 1;
    if (line.trim()) records.push(JSON.parse(line));
  }
  return { records, nextOffset: cursor, eof: cursor >= data.length, trailingPartial };
}

module.exports = { createCalloutSpool, readCalloutSpoolBatch };
