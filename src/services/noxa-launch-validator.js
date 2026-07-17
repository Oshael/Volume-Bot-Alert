const {
  NOXA_FACTORY,
  UNISWAP_V3_FACTORY,
  buildGetLaunchedTokenCall,
  buildGetPoolCall,
  decodeAddressResult,
  decodeLaunchedTokenResult,
  validateLaunch,
} = require('./noxa-launch-decoder');

function toBlockTag(value) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error('NOXA validation block must be a quantity');
  }
  return `0x${BigInt(raw).toString(16)}`;
}

function codeByteLength(value, label) {
  const code = String(value || '').toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(code)) throw new Error(`${label} returned invalid bytecode`);
  return (code.length - 2) / 2;
}

function createNoxaLaunchValidator(options = {}) {
  const rpcClient = options.rpcClient;
  if (typeof rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');

  async function validateOnchain(launch, context = {}) {
    const blockTag = toBlockTag(context.blockTag ?? launch?.blockNumber);
    const launchedTokenData = await rpcClient.request('eth_call', [{
      to: NOXA_FACTORY,
      data: buildGetLaunchedTokenCall(launch.tokenAddress),
    }, blockTag], { fallbackOnRpcError: true });
    const launchedToken = decodeLaunchedTokenResult(launchedTokenData);
    const [poolData, tokenCode, poolCode] = await Promise.all([
      rpcClient.request('eth_call', [{
        to: UNISWAP_V3_FACTORY,
        data: buildGetPoolCall(
          launch.tokenAddress,
          launch.pairTokenAddress,
          launchedToken.poolFee
        ),
      }, blockTag], { fallbackOnRpcError: true }),
      rpcClient.request('eth_getCode', [launch.tokenAddress, blockTag], {
        fallbackOnRpcError: true,
      }),
      rpcClient.request('eth_getCode', [launch.poolAddress, blockTag], {
        fallbackOnRpcError: true,
      }),
    ]);
    return validateLaunch(launch, {
      v3Pool: context.v3Pool || null,
      launchedToken,
      canonicalPoolAddress: decodeAddressResult(poolData, 'NOXA canonical pool'),
      tokenCodeBytes: codeByteLength(tokenCode, 'NOXA token'),
      poolCodeBytes: codeByteLength(poolCode, 'NOXA pool'),
    });
  }

  return Object.freeze({ validateOnchain });
}

module.exports = {
  codeByteLength,
  createNoxaLaunchValidator,
  toBlockTag,
};
