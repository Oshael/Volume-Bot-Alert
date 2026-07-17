require('dotenv').config();

const WebSocket = require('ws');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);
const DEFAULT_SECONDS = 25;
const DEFAULT_MATCHES = 2;
const DEFAULT_MAX_SEEN = 80;
const TRANSACTION_DETAILS = 'full';
const QUICKNODE_METERED_CHUNK_BYTES = 100_000;
const QUICKNODE_CREDITS_PER_METERED_CHUNK = 15;

const KNOWN_PROGRAMS = Object.freeze({
  pumpswap: Object.freeze({
    label: 'pumpswap',
    address: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  }),
  'meteora-dlmm': Object.freeze({
    label: 'meteora-dlmm',
    address: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  }),
  'raydium-cpmm': Object.freeze({
    label: 'raydium-cpmm',
    address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  }),
  'raydium-amm-v4': Object.freeze({
    label: 'raydium-amm-v4',
    address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  }),
  'raydium-clmm': Object.freeze({
    label: 'raydium-clmm',
    address: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  }),
  'jupiter-v6': Object.freeze({
    label: 'jupiter-v6',
    address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  }),
});

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAddressList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLikelyPubkey(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || '').trim());
}

function normalizeWsUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('QUICKNODE_SOLANA_WS_URL is required');
  }
  const url = new URL(normalized);
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error('QUICKNODE_SOLANA_WS_URL must be a WS(S) URL');
  }
  return url.toString();
}

function maskEndpoint(value) {
  try {
    const url = new URL(String(value || '').trim());
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1].slice(0, 6)}...`;
      url.pathname = `/${parts.join('/')}/`;
    }
    return url.toString();
  } catch (_) {
    return '(invalid-url)';
  }
}

function resolveProgram(input) {
  const key = String(input || '').trim().toLowerCase();
  if (KNOWN_PROGRAMS[key]) {
    return KNOWN_PROGRAMS[key];
  }

  const address = String(input || '').trim();
  if (!isLikelyPubkey(address)) {
    throw new Error(`Unsupported program alias or invalid pubkey: ${input}`);
  }
  return { label: address.slice(0, 8), address };
}

function resolvePrograms() {
  const configured = parseAddressList(readEnv('QUICKNODE_PROBE_PROGRAMS'));
  const requested = configured.length ? configured : ['pumpswap', 'meteora-dlmm'];
  return requested.map(resolveProgram);
}

function buildRpcPayload(id, method, params = []) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

function buildTransactionSubscribeParams(programAddress, options = {}) {
  const accounts = {
    include: [programAddress],
  };
  if (options.exclude?.length) {
    accounts.exclude = options.exclude;
  }
  if (options.required?.length) {
    accounts.required = options.required;
  }

  return [
    {
      vote: false,
      failed: false,
      accounts,
    },
    {
      commitment: 'confirmed',
      encoding: 'jsonParsed',
      transactionDetails: TRANSACTION_DETAILS,
      showRewards: false,
      maxSupportedTransactionVersion: 0,
    },
  ];
}

function getRawByteLength(raw) {
  if (Buffer.isBuffer(raw)) {
    return raw.length;
  }
  return Buffer.byteLength(String(raw || ''), 'utf8');
}

function createTrafficStats() {
  return {
    messages: 0,
    receivedBytes: 0,
    subscriptionBytes: 0,
    notificationBytes: 0,
    mentionOnlyBytes: 0,
    matchBytes: 0,
    parseErrorBytes: 0,
    otherBytes: 0,
  };
}

function estimateQuickNodeCredits(bytes) {
  const normalized = Number(bytes);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 0;
  }
  return (normalized / QUICKNODE_METERED_CHUNK_BYTES) * QUICKNODE_CREDITS_PER_METERED_CHUNK;
}

function formatTrafficStats(traffic = {}) {
  const receivedBytes = Number(traffic.receivedBytes) || 0;
  const credits = estimateQuickNodeCredits(receivedBytes);
  return [
    `messages=${Number(traffic.messages) || 0}`,
    `receivedBytes=${receivedBytes}`,
    `estimatedCredits=${Math.round(credits * 100) / 100}`,
    `notificationBytes=${Number(traffic.notificationBytes) || 0}`,
    `mentionOnlyBytes=${Number(traffic.mentionOnlyBytes) || 0}`,
    `matchBytes=${Number(traffic.matchBytes) || 0}`,
  ].join(' ');
}

function getTransactionContainer(value) {
  return value?.transaction || {};
}

function getMeta(value) {
  return getTransactionContainer(value)?.meta || {};
}

function getTopLevelInstructions(value) {
  const message = getTransactionContainer(value)?.transaction?.message || {};
  return Array.isArray(message.instructions) ? message.instructions : [];
}

function getInnerInstructions(value) {
  return (Array.isArray(getMeta(value)?.innerInstructions) ? getMeta(value).innerInstructions : [])
    .flatMap((group) => (Array.isArray(group?.instructions) ? group.instructions : []));
}

function collectProgramIds(value) {
  const instructions = [
    ...getTopLevelInstructions(value),
    ...getInnerInstructions(value),
  ];
  return [...new Set(instructions.map((ix) => String(ix?.programId || '').trim()).filter(Boolean))];
}

function wasProgramInvoked(value, programAddress) {
  return collectProgramIds(value).includes(programAddress);
}

function buildBalanceKey(balance = {}) {
  return [
    balance.accountIndex,
    balance.mint,
    balance.owner || '',
  ].join(':');
}

function tokenAmountToNumber(balance = {}) {
  const rawAmount = String(balance?.uiTokenAmount?.amount || '0');
  const decimals = Number(balance?.uiTokenAmount?.decimals || 0);
  const numericRaw = Number(rawAmount);
  if (!Number.isFinite(numericRaw)) {
    return 0;
  }
  return numericRaw / (10 ** decimals);
}

function collectBalanceDeltas(value) {
  const meta = getMeta(value);
  const pre = new Map();
  const post = new Map();

  for (const balance of Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : []) {
    pre.set(buildBalanceKey(balance), balance);
  }
  for (const balance of Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : []) {
    post.set(buildBalanceKey(balance), balance);
  }

  return [...new Set([...pre.keys(), ...post.keys()])]
    .map((key) => {
      const before = pre.get(key) || {};
      const after = post.get(key) || {};
      const sample = post.get(key) || pre.get(key) || {};
      const preAmount = tokenAmountToNumber(before);
      const postAmount = tokenAmountToNumber(after);
      return {
        mint: sample.mint || null,
        owner: sample.owner || null,
        accountIndex: sample.accountIndex,
        pre: preAmount,
        post: postAmount,
        delta: postAmount - preAmount,
      };
    })
    .filter((item) => item.mint && item.delta !== 0);
}

function pickLargestAbs(items) {
  return [...items].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null;
}

function summarizeSwapShape(value) {
  const deltas = collectBalanceDeltas(value);
  const wsolDeltas = deltas.filter((item) => item.mint === WSOL_MINT);
  const stableDeltas = deltas.filter((item) => item.mint === USDC_MINT || item.mint === USDT_MINT);
  const tokenDeltas = deltas.filter((item) => !QUOTE_MINTS.has(item.mint));
  const largestWsol = pickLargestAbs(wsolDeltas);
  const largestStable = pickLargestAbs(stableDeltas);
  const largestToken = pickLargestAbs(tokenDeltas);
  const uniqueNonQuoteMintCount = new Set(tokenDeltas.map((item) => item.mint)).size;

  return {
    tokenMint: largestToken?.mint || null,
    tokenDelta: largestToken?.delta ?? null,
    wsolDelta: largestWsol?.delta ?? null,
    stableMint: largestStable?.mint || null,
    stableDelta: largestStable?.delta ?? null,
    estimatedSolVolume: largestWsol ? Math.abs(largestWsol.delta) : null,
    estimatedUsdVolume: largestStable ? Math.abs(largestStable.delta) : null,
    volumeSource: largestWsol ? 'wsol' : (largestStable?.mint === USDC_MINT ? 'usdc' : (largestStable?.mint === USDT_MINT ? 'usdt' : 'none')),
    tokenDeltaCount: tokenDeltas.length,
    wsolDeltaCount: wsolDeltas.length,
    stableDeltaCount: stableDeltas.length,
    uniqueNonQuoteMintCount,
    topDeltas: [...deltas]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 6),
  };
}

function summarizeNotification(program, value, seen, observedAtMs = Date.now()) {
  const meta = getMeta(value);
  const programs = collectProgramIds(value);
  const shape = summarizeSwapShape(value);
  return {
    program: program.label,
    seen,
    signature: value?.signature || null,
    slot: value?.slot || null,
    blockTime: value?.blockTime || null,
    observedAtMs,
    err: value?.error || meta.err || null,
    programs,
    topLevelInstructions: getTopLevelInstructions(value).length,
    innerInstructions: getInnerInstructions(value).length,
    ...shape,
  };
}

function printMatch(summary) {
  console.log(`[TxProbe] match ${summary.program} seen=${summary.seen} slot=${summary.slot} sig=${summary.signature}`);
  console.log(`  programs=${summary.programs.join(', ')}`);
  console.log(`  token=${summary.tokenMint || 'unknown'} tokenDelta=${summary.tokenDelta ?? 'n/a'} wsolDelta=${summary.wsolDelta ?? 'n/a'} stableDelta=${summary.stableDelta ?? 'n/a'} estSolVol=${summary.estimatedSolVolume ?? 'n/a'} estUsdVol=${summary.estimatedUsdVolume ?? 'n/a'} volumeSource=${summary.volumeSource}`);
  for (const delta of summary.topDeltas) {
    console.log(`  delta mint=${delta.mint} owner=${delta.owner || 'unknown'} account=${delta.accountIndex} delta=${delta.delta}`);
  }
}

function probeProgram(wsUrl, program, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let subscriptionId = null;
    let seen = 0;
    let skippedMentionOnly = 0;
    let settled = false;
    const matches = [];
    const traffic = createTrafficStats();

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      try {
        if (subscriptionId != null && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(buildRpcPayload(2, 'transactionUnsubscribe', [subscriptionId])));
        }
        ws.close();
      } catch (_) {
      }

      const result = {
        program,
        seen,
        skippedMentionOnly,
        matches,
        traffic,
      };
      if (error) reject(Object.assign(error, { result }));
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out after ${options.seconds}s`));
    }, options.seconds * 1000);

    ws.on('open', () => {
      ws.send(JSON.stringify(buildRpcPayload(
        1,
        'transactionSubscribe',
        buildTransactionSubscribeParams(program.address, options),
      )));
    });

    ws.on('message', (raw) => {
      if (settled) return;
      const messageBytes = getRawByteLength(raw);
      traffic.messages += 1;
      traffic.receivedBytes += messageBytes;

      let message = null;
      try {
        message = JSON.parse(String(raw));
      } catch (_) {
        traffic.parseErrorBytes += messageBytes;
        return;
      }

      if (message?.id === 1) {
        traffic.subscriptionBytes += messageBytes;
        if (message.error) {
          clearTimeout(timeout);
          finish(new Error(`transactionSubscribe RPC error ${message.error.code}: ${message.error.message}`));
          return;
        }
        subscriptionId = message.result;
        console.log(`[TxProbe] subscribed ${program.label} id=${subscriptionId}`);
        return;
      }

      if (message?.method !== 'transactionNotification') {
        traffic.otherBytes += messageBytes;
        return;
      }

      traffic.notificationBytes += messageBytes;
      seen += 1;
      const value = message?.params?.result?.value || {};
      if (!wasProgramInvoked(value, program.address)) {
        traffic.mentionOnlyBytes += messageBytes;
        skippedMentionOnly += 1;
        if (skippedMentionOnly <= 3) {
          console.log(`[TxProbe] skipped mention-only ${program.label} sig=${value?.signature || 'unknown'}`);
        }
        if (seen >= options.maxSeen) {
          clearTimeout(timeout);
          finish(new Error(`Reached max seen without enough invoked matches (${seen})`));
        }
        return;
      }

      traffic.matchBytes += messageBytes;
      const summary = summarizeNotification(program, value, seen);
      matches.push(summary);
      printMatch(summary);
      if (matches.length >= options.matches) {
        clearTimeout(timeout);
        finish();
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      finish(error);
    });

    ws.on('close', () => {
      if (!settled && matches.length > 0) {
        clearTimeout(timeout);
        finish();
      }
    });
  });
}

async function main() {
  const wsUrl = normalizeWsUrl(readEnv('QUICKNODE_SOLANA_WS_URL'));
  const programs = resolvePrograms();
  const options = {
    seconds: parsePositiveInteger(readEnv('QUICKNODE_PROBE_SECONDS'), DEFAULT_SECONDS),
    matches: parsePositiveInteger(readEnv('QUICKNODE_PROBE_MATCHES'), DEFAULT_MATCHES),
    maxSeen: parsePositiveInteger(readEnv('QUICKNODE_PROBE_MAX_SEEN'), DEFAULT_MAX_SEEN),
    exclude: parseAddressList(readEnv('QUICKNODE_PROBE_EXCLUDE')),
    required: parseAddressList(readEnv('QUICKNODE_PROBE_REQUIRED')),
  };

  console.log(`[TxProbe] WS ${maskEndpoint(wsUrl)}`);
  console.log(`[TxProbe] programs=${programs.map((program) => program.label).join(', ')} seconds=${options.seconds} matches=${options.matches}`);
  if (options.exclude.length) console.log(`[TxProbe] exclude=${options.exclude.join(', ')}`);
  if (options.required.length) console.log(`[TxProbe] required=${options.required.join(', ')}`);

  for (const program of programs) {
    try {
      const result = await probeProgram(wsUrl, program, options);
      console.log(`[TxProbe] summary ${program.label}: seen=${result.seen} matches=${result.matches.length} skippedMentionOnly=${result.skippedMentionOnly}`);
      console.log(`[TxProbe] traffic ${program.label}: ${formatTrafficStats(result.traffic)}`);
    } catch (error) {
      const result = error.result || {};
      console.error(`[TxProbe] ${program.label} failed: ${error.message}`);
      console.error(`[TxProbe] partial ${program.label}: seen=${result.seen || 0} matches=${result.matches?.length || 0} skippedMentionOnly=${result.skippedMentionOnly || 0}`);
      console.error(`[TxProbe] traffic ${program.label}: ${formatTrafficStats(result.traffic)}`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[TxProbe] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildTransactionSubscribeParams,
  createTrafficStats,
  estimateQuickNodeCredits,
  formatTrafficStats,
  getRawByteLength,
  probeProgram,
  resolveProgram,
  summarizeNotification,
  wasProgramInvoked,
};
