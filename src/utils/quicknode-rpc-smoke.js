require('dotenv').config();

const WebSocket = require('ws');

const DEFAULT_WS_SECONDS = 15;
const DEFAULT_LOGS_SECONDS = 15;
const DEFAULT_LOGS_MAX = 1;
const REQUEST_TIMEOUT_MS = 10000;
const TOKEN_BALANCE_PREVIEW_LIMIT = 8;
const FETCH_TRANSACTION_ATTEMPTS = 4;
const FETCH_TRANSACTION_RETRY_MS = 750;

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '(missing)';

  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1].slice(0, 6)}...`;
      url.pathname = `/${parts.join('/')}/`;
    }
    url.search = '';
    return url.toString();
  } catch (_) {
    return `${raw.slice(0, 24)}...`;
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRpcUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('QUICKNODE_SOLANA_RPC_URL is required');
  }
  const url = new URL(normalized);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('QUICKNODE_SOLANA_RPC_URL must be an HTTP(S) URL');
  }
  return url.toString();
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

function buildRpcPayload(id, method, params = []) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

async function rpcRequest(rpcUrl, method, params = [], id = 1) {
  const startedAt = Date.now();
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify(buildRpcPayload(id, method, params)),
  });
  const elapsedMs = Date.now() - startedAt;

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }

  if (!response.ok) {
    throw new Error(`${method} failed with HTTP ${response.status}`);
  }
  if (body?.error) {
    throw new Error(`${method} returned RPC error ${body.error.code}: ${body.error.message}`);
  }

  return { method, elapsedMs, result: body?.result ?? null };
}

function summarizeResult(method, result) {
  if (method === 'getHealth') {
    return String(result);
  }
  if (method === 'getSlot') {
    return String(result);
  }
  if (method === 'getVersion') {
    return `${result?.['solana-core'] || 'unknown'} / feature-set ${result?.['feature-set'] || 'unknown'}`;
  }
  if (method === 'getLatestBlockhash') {
    return `slot=${result?.context?.slot || 'unknown'} blockhash=${String(result?.value?.blockhash || '').slice(0, 12)}...`;
  }
  return JSON.stringify(result);
}

async function runHttpSmoke(rpcUrl) {
  const checks = [
    ['getHealth', []],
    ['getSlot', [{ commitment: 'confirmed' }]],
    ['getVersion', []],
    ['getLatestBlockhash', [{ commitment: 'confirmed' }]],
  ];

  console.log('[QuickNodeSmoke] HTTP RPC checks');
  for (let index = 0; index < checks.length; index += 1) {
    const [method, params] = checks[index];
    const output = await rpcRequest(rpcUrl, method, params, index + 1);
    console.log(`  ok ${method} ${output.elapsedMs}ms ${summarizeResult(method, output.result)}`);
  }
}

function runSlotSubscribe(wsUrl, seconds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const slots = [];
    let subscriptionId = null;
    let settled = false;

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      try {
        if (subscriptionId != null && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(buildRpcPayload(2, 'slotUnsubscribe', [subscriptionId])));
        }
        ws.close();
      } catch (_) {
      }

      if (error) {
        reject(error);
      } else {
        resolve({ subscriptionId, slots });
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error(`slotSubscribe did not receive a slot within ${seconds}s`));
    }, seconds * 1000);

    ws.on('open', () => {
      ws.send(JSON.stringify(buildRpcPayload(1, 'slotSubscribe')));
    });

    ws.on('message', (raw) => {
      if (settled) {
        return;
      }

      let message = null;
      try {
        message = JSON.parse(String(raw));
      } catch (_) {
        return;
      }

      if (message?.id === 1) {
        if (message.error) {
          clearTimeout(timeout);
          finish(new Error(`slotSubscribe RPC error ${message.error.code}: ${message.error.message}`));
          return;
        }
        subscriptionId = message.result;
        return;
      }

      if (message?.method === 'slotNotification') {
        const slot = Number(message?.params?.result?.slot);
        if (Number.isFinite(slot)) {
          slots.push(slot);
        }
        if (slots.length >= 3) {
          clearTimeout(timeout);
          finish();
        }
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      finish(error);
    });

    ws.on('close', () => {
      if (!settled && slots.length > 0) {
        clearTimeout(timeout);
        finish();
      }
    });
  });
}

function buildLogsSubscribeParams(mention) {
  return [
    { mentions: [mention] },
    { commitment: 'confirmed' },
  ];
}

function summarizeLogNotification(message) {
  const value = message?.params?.result?.value || {};
  const logs = Array.isArray(value.logs) ? value.logs : [];
  return {
    signature: value.signature || null,
    err: value.err || null,
    logCount: logs.length,
    firstLog: logs[0] || null,
  };
}

function addInstructionProgram(programs, instruction) {
  const programId = String(instruction?.programId || '').trim();
  if (programId) {
    programs.add(programId);
  }
}

function addInstructionPrograms(programs, instructions) {
  for (const instruction of Array.isArray(instructions) ? instructions : []) {
    addInstructionProgram(programs, instruction);
  }
}

function addInnerInstructionPrograms(programs, innerInstructions) {
  for (const group of Array.isArray(innerInstructions) ? innerInstructions : []) {
    addInstructionPrograms(programs, group?.instructions);
  }
}

function collectInstructionPrograms(transaction) {
  const programs = new Set();
  addInstructionPrograms(programs, transaction?.transaction?.message?.instructions);
  addInnerInstructionPrograms(programs, transaction?.meta?.innerInstructions);
  return [...programs];
}

function tokenAmountToNumber(balance) {
  const amount = balance?.uiTokenAmount?.uiAmount;
  if (Number.isFinite(Number(amount))) {
    return Number(amount);
  }
  const raw = BigInt(String(balance?.uiTokenAmount?.amount || '0'));
  const decimals = Number(balance?.uiTokenAmount?.decimals || 0);
  return Number(raw) / (10 ** decimals);
}

function buildTokenBalanceKey(balance) {
  return [
    balance?.accountIndex,
    balance?.mint,
    balance?.owner || '',
  ].join(':');
}

function collectTokenBalanceDeltas(transaction) {
  const pre = new Map();
  const post = new Map();

  for (const balance of transaction?.meta?.preTokenBalances || []) {
    pre.set(buildTokenBalanceKey(balance), balance);
  }
  for (const balance of transaction?.meta?.postTokenBalances || []) {
    post.set(buildTokenBalanceKey(balance), balance);
  }

  const keys = new Set([...pre.keys(), ...post.keys()]);
  return [...keys].map((key) => {
    const before = pre.get(key) || {};
    const after = post.get(key) || {};
    const sample = post.get(key) || pre.get(key) || {};
    return {
      mint: sample.mint || null,
      owner: sample.owner || null,
      accountIndex: sample.accountIndex,
      pre: tokenAmountToNumber(before),
      post: tokenAmountToNumber(after),
      delta: tokenAmountToNumber(after) - tokenAmountToNumber(before),
    };
  }).filter((item) => item.delta !== 0);
}

function summarizeTransaction(transaction) {
  const innerInstructionGroups = Array.isArray(transaction?.meta?.innerInstructions)
    ? transaction.meta.innerInstructions.length
    : 0;
  return {
    slot: transaction?.slot || null,
    blockTime: transaction?.blockTime || null,
    fee: transaction?.meta?.fee || null,
    err: transaction?.meta?.err || null,
    programs: collectInstructionPrograms(transaction),
    topLevelInstructionCount: Array.isArray(transaction?.transaction?.message?.instructions)
      ? transaction.transaction.message.instructions.length
      : 0,
    innerInstructionGroups,
    tokenBalanceDeltas: collectTokenBalanceDeltas(transaction)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, TOKEN_BALANCE_PREVIEW_LIMIT),
  };
}

async function fetchTransactionSummary(rpcUrl, signature, id) {
  for (let attempt = 1; attempt <= FETCH_TRANSACTION_ATTEMPTS; attempt += 1) {
    const response = await rpcRequest(rpcUrl, 'getTransaction', [
      signature,
      {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
      },
    ], id + attempt);
    if (response.result) {
      return summarizeTransaction(response.result);
    }
    if (attempt < FETCH_TRANSACTION_ATTEMPTS) {
      await sleep(FETCH_TRANSACTION_RETRY_MS);
    }
  }
  return null;
}

function printTransactionSummary(summary) {
  if (!summary) {
    console.log('     tx unavailable after short retry');
    return;
  }
  console.log(`     tx slot=${summary.slot} blockTime=${summary.blockTime} fee=${summary.fee} err=${summary.err ? JSON.stringify(summary.err) : 'none'}`);
  console.log(`     tx programs=${summary.programs.join(', ') || 'none'}`);
  console.log(`     tx instructions=${summary.topLevelInstructionCount} innerGroups=${summary.innerInstructionGroups}`);
  for (const delta of summary.tokenBalanceDeltas) {
    console.log(`     delta mint=${delta.mint} owner=${delta.owner || 'unknown'} accountIndex=${delta.accountIndex} pre=${delta.pre} post=${delta.post} delta=${delta.delta}`);
  }
}

function runLogsSubscribe(wsUrl, mention, options = {}) {
  return new Promise((resolve, reject) => {
    const seconds = parsePositiveInteger(options.seconds, DEFAULT_LOGS_SECONDS);
    const maxNotifications = parsePositiveInteger(options.maxNotifications, DEFAULT_LOGS_MAX);
    const ws = new WebSocket(wsUrl);
    const notifications = [];
    let subscriptionId = null;
    let settled = false;

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      try {
        if (subscriptionId != null && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(buildRpcPayload(4, 'logsUnsubscribe', [subscriptionId])));
        }
        ws.close();
      } catch (_) {
      }

      if (error) {
        reject(error);
      } else {
        resolve({ subscriptionId, notifications });
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error(`logsSubscribe did not receive a notification within ${seconds}s`));
    }, seconds * 1000);

    ws.on('open', () => {
      ws.send(JSON.stringify(buildRpcPayload(3, 'logsSubscribe', buildLogsSubscribeParams(mention))));
    });

    ws.on('message', (raw) => {
      if (settled) {
        return;
      }

      let message = null;
      try {
        message = JSON.parse(String(raw));
      } catch (_) {
        return;
      }

      if (message?.id === 3) {
        if (message.error) {
          clearTimeout(timeout);
          finish(new Error(`logsSubscribe RPC error ${message.error.code}: ${message.error.message}`));
          return;
        }
        subscriptionId = message.result;
        return;
      }

      if (message?.method === 'logsNotification') {
        notifications.push(summarizeLogNotification(message));
        if (notifications.length >= maxNotifications) {
          clearTimeout(timeout);
          finish();
        }
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      finish(error);
    });

    ws.on('close', () => {
      if (!settled && notifications.length > 0) {
        clearTimeout(timeout);
        finish();
      }
    });
  });
}

async function main() {
  const rpcUrl = normalizeRpcUrl(readEnv('QUICKNODE_SOLANA_RPC_URL'));
  const wsUrl = normalizeWsUrl(readEnv('QUICKNODE_SOLANA_WS_URL'));
  const wsSeconds = parsePositiveInteger(readEnv('QUICKNODE_SMOKE_WS_SECONDS'), DEFAULT_WS_SECONDS);
  const logsMention = readEnv('QUICKNODE_SMOKE_LOGS_MENTION');
  const logsSeconds = parsePositiveInteger(readEnv('QUICKNODE_SMOKE_LOGS_SECONDS'), DEFAULT_LOGS_SECONDS);
  const logsMax = parsePositiveInteger(readEnv('QUICKNODE_SMOKE_LOGS_MAX'), DEFAULT_LOGS_MAX);
  const fetchLogsTransactions = readEnv('QUICKNODE_SMOKE_FETCH_LOG_TX') === '1'
    || readEnv('QUICKNODE_SMOKE_FETCH_LOG_TX') === 'true';

  console.log(`[QuickNodeSmoke] RPC ${maskEndpoint(rpcUrl)}`);
  console.log(`[QuickNodeSmoke] WS  ${maskEndpoint(wsUrl)}`);

  await runHttpSmoke(rpcUrl);

  console.log(`[QuickNodeSmoke] WebSocket slotSubscribe up to ${wsSeconds}s`);
  const wsResult = await runSlotSubscribe(wsUrl, wsSeconds);
  console.log(`  ok slotSubscribe subscription=${wsResult.subscriptionId} slots=${wsResult.slots.join(', ')}`);

  if (logsMention) {
    console.log(`[QuickNodeSmoke] WebSocket logsSubscribe mention=${logsMention} up to ${logsSeconds}s`);
    const logsResult = await runLogsSubscribe(wsUrl, logsMention, {
      seconds: logsSeconds,
      maxNotifications: logsMax,
    });
    for (const item of logsResult.notifications) {
      console.log(`  ok logsSubscribe subscription=${logsResult.subscriptionId} signature=${item.signature} logs=${item.logCount} err=${item.err ? JSON.stringify(item.err) : 'none'}`);
      if (item.firstLog) {
        console.log(`     firstLog=${item.firstLog}`);
      }
      if (fetchLogsTransactions && item.signature) {
        const summary = await fetchTransactionSummary(rpcUrl, item.signature, 1000 + logsResult.notifications.indexOf(item));
        printTransactionSummary(summary);
      }
    }
  }
}

main().catch((error) => {
  console.error(`[QuickNodeSmoke] failed: ${error.message}`);
  process.exitCode = 1;
});
