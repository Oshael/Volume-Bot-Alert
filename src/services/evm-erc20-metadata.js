const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';
const AGGREGATE3_SELECTOR = '0x82ad56cb';
const SELECTORS = Object.freeze({
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
});
const FIELDS = Object.freeze(Object.keys(SELECTORS));

function normalizeAddress(value, label = 'address') {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function normalizeHex(value, label = 'hex data') {
  const hex = String(value || '').toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`${label} must be even-length hex data`);
  return hex;
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function paddedBytes(hex) {
  const raw = normalizeHex(hex).slice(2);
  return `${word(raw.length / 2)}${raw.padEnd(Math.ceil(raw.length / 64) * 64, '0')}`;
}

function encodeAggregate3(calls) {
  if (!Array.isArray(calls) || calls.length === 0) throw new Error('aggregate3 calls are required');
  const tuples = calls.map((call) => {
    const target = normalizeAddress(call.target, 'call target').slice(2).padStart(64, '0');
    return `${target}${word(call.allowFailure === false ? 0 : 1)}${word(96)}${paddedBytes(call.callData)}`;
  });
  let offset = calls.length * 32;
  const offsets = tuples.map((tuple) => {
    const current = word(offset);
    offset += tuple.length / 2;
    return current;
  }).join('');
  return `${AGGREGATE3_SELECTOR}${word(32)}${word(calls.length)}${offsets}${tuples.join('')}`;
}

function readWord(raw, byteOffset, label) {
  const start = byteOffset * 2;
  const value = raw.slice(start, start + 64);
  if (value.length !== 64) throw new Error(`${label} is outside ABI data`);
  return BigInt(`0x${value}`);
}

function safeOffset(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe decode range`);
  return Number(value);
}

function sliceAbiBytes(raw, tupleStart, relativeOffset, label) {
  const bytesStart = tupleStart + safeOffset(relativeOffset, `${label} offset`);
  const length = safeOffset(readWord(raw, bytesStart, `${label} length`), `${label} length`);
  const dataStart = (bytesStart + 32) * 2;
  const output = raw.slice(dataStart, dataStart + (length * 2));
  if (output.length !== length * 2) throw new Error(`${label} is truncated`);
  return `0x${output}`;
}

function decodeAggregate3(data, expectedCount) {
  const raw = normalizeHex(data, 'aggregate3 result').slice(2);
  const arrayStart = safeOffset(readWord(raw, 0, 'result offset'), 'result offset');
  const count = safeOffset(readWord(raw, arrayStart, 'result count'), 'result count');
  if (count !== expectedCount) throw new Error(`aggregate3 returned ${count} results; expected ${expectedCount}`);
  const headStart = arrayStart + 32;
  return Array.from({ length: count }, (_, index) => {
    const tupleStart = headStart + safeOffset(readWord(raw, headStart + (index * 32), 'tuple offset'), 'tuple offset');
    const success = readWord(raw, tupleStart, 'success');
    if (success !== 0n && success !== 1n) throw new Error('aggregate3 success is not an ABI bool');
    return {
      success: success === 1n,
      returnData: sliceAbiBytes(raw, tupleStart, readWord(raw, tupleStart + 32, 'bytes offset'), 'returnData'),
    };
  });
}

function decodeUintResult(data, bits, label) {
  const raw = normalizeHex(data, label);
  if (raw.length !== 66) throw new Error(`${label} must contain one ABI word`);
  const value = BigInt(raw);
  if (value >= 1n << BigInt(bits)) throw new Error(`${label} exceeds uint${bits}`);
  return value;
}

function decodeTextResult(data, label) {
  const raw = normalizeHex(data, label).slice(2);
  let content;
  if (raw.length === 64) {
    content = raw.replace(/(?:00)+$/, '');
  } else {
    const offset = safeOffset(readWord(raw, 0, `${label} offset`), `${label} offset`);
    const length = safeOffset(readWord(raw, offset, `${label} length`), `${label} length`);
    const start = (offset + 32) * 2;
    content = raw.slice(start, start + (length * 2));
    if (content.length !== length * 2) throw new Error(`${label} is truncated`);
  }
  if (!content) return null;
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content, 'hex')).replace(/\0/g, '').trim() || null;
}

function decodeMetadataResults(address, results) {
  const output = { address, name: null, symbol: null, decimals: null, totalSupplyRaw: null };
  const errors = [];
  for (let index = 0; index < FIELDS.length; index += 1) {
    const field = FIELDS[index];
    const result = results[index];
    if (!result?.success) {
      errors.push(`${field}_call_failed`);
      continue;
    }
    try {
      if (field === 'name' || field === 'symbol') output[field] = decodeTextResult(result.returnData, field);
      if (field === 'decimals') output.decimals = Number(decodeUintResult(result.returnData, 8, field));
      if (field === 'totalSupply') output.totalSupplyRaw = decodeUintResult(result.returnData, 256, field).toString();
    } catch (_) {
      errors.push(`${field}_decode_failed`);
    }
  }
  const usable = output.decimals != null && output.totalSupplyRaw != null;
  return { ...output, usable, status: errors.length ? (usable ? 'partial' : 'unusable') : 'complete', errors };
}

function createErc20MetadataReader(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const rpcClient = options.rpcClient;
  const multicallAddress = normalizeAddress(options.multicallAddress || MULTICALL3_ADDRESS);
  const ttlMs = Math.max(0, Number(options.ttlMs ?? 3600000));
  const failureTtlMs = Math.max(0, Number(options.failureTtlMs ?? 30000));
  const now = options.now || Date.now;
  const cache = new Map();
  const pending = new Map();
  let multicallUsable;
  let multicallCheck = null;

  async function individualCalls(address, blockTag) {
    return Promise.all(FIELDS.map(async (field) => {
      try {
        const returnData = await rpcClient.request('eth_call', [{ to: address, data: SELECTORS[field] }, blockTag]);
        return { success: true, returnData };
      } catch (_) {
        return { success: false, returnData: '0x' };
      }
    }));
  }

  async function canUseMulticall() {
    if (options.useMulticall === false) return false;
    if (multicallUsable != null) return multicallUsable;
    if (multicallCheck) return multicallCheck;
    multicallCheck = rpcClient.request('eth_getCode', [multicallAddress, 'latest'])
      .then((result) => {
        const code = normalizeHex(result, 'Multicall3 code');
        multicallUsable = code !== '0x' && code !== '0x00';
        return multicallUsable;
      })
      .catch(() => false)
      .finally(() => { multicallCheck = null; });
    return multicallCheck;
  }

  async function readFresh(address, blockTag) {
    let results;
    let transport = 'individual';
    if (await canUseMulticall()) {
      try {
        const calls = FIELDS.map((field) => ({ target: address, allowFailure: true, callData: SELECTORS[field] }));
        const data = encodeAggregate3(calls);
        const result = await rpcClient.request('eth_call', [{ to: multicallAddress, data }, blockTag]);
        results = decodeAggregate3(result, calls.length);
        transport = 'multicall3';
      } catch (_) {
        results = null;
      }
    }
    results ||= await individualCalls(address, blockTag);
    return { ...decodeMetadataResults(address, results), transport, blockTag };
  }

  async function getMetadata(tokenAddress, requestOptions = {}) {
    const address = normalizeAddress(tokenAddress, 'token address');
    const blockTag = String(requestOptions.blockTag || 'latest');
    const key = `${address}:${blockTag}`;
    const cached = cache.get(key);
    if (!requestOptions.refresh && cached && cached.expiresAt > now()) return { ...cached.value, cached: true };
    if (pending.has(key)) return pending.get(key);
    const task = readFresh(address, blockTag).then((value) => {
      cache.set(key, { value, expiresAt: now() + (value.usable ? ttlMs : failureTtlMs) });
      return { ...value, cached: false };
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return Object.freeze({
    getMetadata,
    clearCache: () => cache.clear(),
    getCacheSize: () => cache.size,
  });
}

module.exports = {
  AGGREGATE3_SELECTOR,
  FIELDS,
  MULTICALL3_ADDRESS,
  SELECTORS,
  createErc20MetadataReader,
  decodeAggregate3,
  decodeMetadataResults,
  decodeTextResult,
  encodeAggregate3,
};
