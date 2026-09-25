function sqlLabel(value) {
  return String(value?.text || value || '')
    .replace(/(?:[Ee])?'(?:''|\\.|[^'])*'/g, "'?'")
    .replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown SQL';
}

function callerLabel() {
  const line = new Error().stack?.split('\n')[3] || '';
  const match = line.match(/(?:\/src\/|\\src\\)([^:)]+:\d+)/);
  return match ? `getClient ${match[1].replace(/\\/g, '/')}` : 'getClient';
}

function createPoolHolderTelemetry(pool, now = Date.now) {
  const holders = new Map();
  pool.on('acquire', (client) => {
    holders.set(client, { acquiredAt: now(), origin: 'pool query or direct use' });
  });
  pool.on('release', (_error, client) => { holders.delete(client); });

  return {
    tag(client, origin) {
      const holder = holders.get(client);
      if (holder) holder.origin = origin;
    },
    snapshot() {
      const at = now();
      return [...holders].map(([client, holder]) => {
        const active = client._getActiveQuery?.();
        return {
          pid: Number(client.processID) || null,
          heldMs: Math.max(0, at - holder.acquiredAt),
          origin: holder.origin,
          activeSql: active?.text ? sqlLabel(active.text) : null,
        };
      }).sort((a, b) => b.heldMs - a.heldMs);
    },
  };
}

module.exports = { createPoolHolderTelemetry, sqlLabel, callerLabel };
