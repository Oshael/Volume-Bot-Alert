const helius = require('./helius');

function normalizeAddress(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function parseInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseRawAmount(value) {
  const normalized = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function extractSupplyValue(result) {
  return result?.value && typeof result.value === 'object' ? result.value : result;
}

function extractAccountRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.token_accounts)) return result.token_accounts;
  if (Array.isArray(result?.tokenAccounts)) return result.tokenAccounts;
  if (Array.isArray(result?.accounts)) return result.accounts;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.value)) return result.value;
  return [];
}

function extractAccountAmount(row) {
  const candidates = [
    row?.amount,
    row?.tokenAmount?.amount,
    row?.token_amount?.amount,
    row?.account?.data?.parsed?.info?.tokenAmount?.amount,
  ];

  for (const candidate of candidates) {
    const amount = parseRawAmount(candidate);
    if (amount != null) {
      return amount;
    }
  }
  return '0';
}

function extractTokenProgram(rows) {
  for (const row of rows) {
    const tokenProgram = String(row?.token_program || row?.tokenProgram || row?.programId || '').trim();
    if (tokenProgram) {
      return tokenProgram;
    }
  }
  return null;
}

function sumRawAmounts(rows) {
  return rows
    .map(extractAccountAmount)
    .reduce((total, amount) => total + BigInt(amount), 0n)
    .toString();
}

function formatRawBalance(rawAmount, decimals) {
  const raw = parseRawAmount(rawAmount);
  if (raw == null) {
    throw new Error('Raw token amount must be an integer string');
  }
  const places = parseInteger(decimals, 'decimals');
  if (places === 0) {
    return raw;
  }

  const padded = raw.padStart(places + 1, '0');
  const whole = padded.slice(0, -places);
  const fraction = padded.slice(-places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function createHeliusTokenBalanceProvider(options = {}) {
  const heliusApi = options.heliusApi || helius;

  return {
    providerName: 'helius',

    async getWalletTokenBalance(input = {}) {
      const walletAddress = normalizeAddress(input.walletAddress, 'walletAddress');
      const mintAddress = normalizeAddress(input.mintAddress, 'mintAddress');
      const [supplyResult, tokenAccountsResult] = await Promise.all([
        heliusApi.getTokenSupply(mintAddress, { commitment: 'confirmed' }),
        heliusApi.getTokenAccounts({ owner: walletAddress, mint: mintAddress, limit: 1000 }),
      ]);
      const supply = extractSupplyValue(supplyResult);
      const decimals = parseInteger(supply?.decimals, 'token supply decimals');
      const accountRows = extractAccountRows(tokenAccountsResult);
      const balanceRaw = sumRawAmounts(accountRows);

      return {
        walletAddress,
        mintAddress,
        tokenProgram: extractTokenProgram(accountRows),
        decimals,
        balanceRaw,
        balanceUiString: formatRawBalance(balanceRaw, decimals),
        rpcProvider: 'helius',
        rpcSlot: supplyResult?.context?.slot ?? tokenAccountsResult?.context?.slot ?? null,
      };
    },
  };
}

module.exports = {
  createHeliusTokenBalanceProvider,
  __private: {
    extractAccountAmount,
    extractAccountRows,
    extractSupplyValue,
    extractTokenProgram,
    formatRawBalance,
    parseRawAmount,
    sumRawAmounts,
  },
};
