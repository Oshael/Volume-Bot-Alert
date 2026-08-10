function resolveRobinhoodHolderRpcProvider(env = process.env, name = 'robinhood-holder') {
  const url = String(env.ROBINHOOD_RPC_URL || '').trim();
  if (!url) {
    const error = new Error('ROBINHOOD_RPC_URL is required for holder indexing');
    error.code = 'configuration_error';
    error.fatal = true;
    throw error;
  }
  return Object.freeze({ name, url });
}

module.exports = { resolveRobinhoodHolderRpcProvider };
