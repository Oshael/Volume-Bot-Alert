const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_DIRECTORY = path.resolve(__dirname, '../../data/gmgn/cooldown');
const FALLBACK_MS = 300000;
const BUFFER_MS = 1000;

function createGmgnCooldown({ directory = DEFAULT_DIRECTORY, now = Date.now } = {}) {
  let untilMs = 0;

  async function getUntilMs() {
    if (!directory) return untilMs;
    let names;
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        return untilMs;
      }
      throw error;
    }
    for (const name of names) {
      if (!/^\d+\.until$/.test(name)) continue;
      const deadline = Number(name.slice(0, -6));
      if (deadline > now()) {
        untilMs = Math.max(untilMs, deadline);
      } else {
        await fs.unlink(path.join(directory, name)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    return untilMs;
  }

  async function block(resetAt) {
    const resetMs = Number(resetAt) * 1000;
    untilMs = Math.max(untilMs, (resetMs > now() ? resetMs : now() + FALLBACK_MS) + BUFFER_MS);
    if (directory) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      // Immutable deadlines preserve concurrent, longer bans without a read/write race.
      await fs.writeFile(path.join(directory, `${untilMs}.until`), '', { flag: 'wx', mode: 0o600 })
        .catch((error) => { if (error.code !== 'EEXIST') throw error; });
    }
    return untilMs;
  }

  return {
    block, getUntilMs, now,
    getStatus: () => ({ directory, untilMs, remainingMs: Math.max(0, untilMs - now()) }),
  };
}

module.exports = { createGmgnCooldown };
