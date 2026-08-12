function resolveRobinhoodHolderRpcProvider(
  env = process.env, name = 'robinhood-holder', preferredUrlEnv = null
) {
  const preferredUrl = preferredUrlEnv ? env[preferredUrlEnv] : null;
  const url = String(preferredUrl || env.ROBINHOOD_RPC_URL || '').trim();
  if (!url) {
    const error = new Error('ROBINHOOD_RPC_URL is required for holder indexing');
    error.code = 'configuration_error';
    error.fatal = true;
    throw error;
  }
  return Object.freeze({ name, url });
}

module.exports = { resolveRobinhoodHolderRpcProvider };
