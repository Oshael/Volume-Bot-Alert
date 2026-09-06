'use strict';

const FORBIDDEN_METHOD = 'eth_getLogs';

function forbiddenError(role) {
  const error = new Error(`${FORBIDDEN_METHOD} is forbidden for live RPC role ${role}`);
  error.code = 'live_rpc_method_forbidden';
  error.retryable = false;
  return error;
}

function createRobinhoodLiveRpcGuard(client, options = {}) {
  if (typeof client?.request !== 'function') throw new Error('rpcClient.request is required');
  const role = String(options.role || '').trim();
  if (!role) throw new Error('live RPC role is required');
  let forbiddenAttempts = 0;

  function assertAllowed(method) {
    if (method !== FORBIDDEN_METHOD) return;
    forbiddenAttempts += 1;
    throw forbiddenError(role);
  }

  const guarded = {
    providers: client.providers,
    request(method, params, requestOptions) {
      assertAllowed(method);
      return client.request(method, params, requestOptions);
    },
    requestBatch(requests, requestOptions) {
      for (const request of requests || []) assertAllowed(request?.method);
      if (typeof client.requestBatch !== 'function') {
        const error = new Error('rpcClient.requestBatch is unavailable');
        error.code = 'batch_unsupported';
        throw error;
      }
      return client.requestBatch(requests, requestOptions);
    },
    getMetrics: (...args) => client.getMetrics?.(...args) || {},
    getGuardStatus: () => ({ role, forbiddenMethod: FORBIDDEN_METHOD, forbiddenAttempts }),
  };
  if (typeof client.requestProvider === 'function') {
    guarded.requestProvider = (providerName, method, params, requestOptions) => {
      assertAllowed(method);
      return client.requestProvider(providerName, method, params, requestOptions);
    };
  }
  if (typeof client.requestBatchProvider === 'function') {
    guarded.requestBatchProvider = (providerName, requests, requestOptions) => {
      for (const request of requests || []) assertAllowed(request?.method);
      return client.requestBatchProvider(providerName, requests, requestOptions);
    };
  }
  if (typeof client.requestProviders === 'function') {
    guarded.requestProviders = (providerNames, method, params, requestOptions) => {
      assertAllowed(method);
      return client.requestProviders(providerNames, method, params, requestOptions);
    };
  }
  if (typeof client.requestBatchProviders === 'function') {
    guarded.requestBatchProviders = (providerNames, requests, requestOptions) => {
      for (const request of requests || []) assertAllowed(request?.method);
      return client.requestBatchProviders(providerNames, requests, requestOptions);
    };
  }
  return Object.freeze(guarded);
}

module.exports = { FORBIDDEN_METHOD, createRobinhoodLiveRpcGuard };
