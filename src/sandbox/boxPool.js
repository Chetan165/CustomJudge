const { createRedis } = require("../queue/connection");
const config = require("../core/config");

// Isolate box IDs are a host-global resource: two concurrent runs sharing an
// ID corrupt each other. Lease them through Redis so every worker process on
// the host draws from one pool.
const redis = createRedis();
const KEY = (id) => `cj:box:${id}`;
const LEASE_TTL_SECONDS = 300;

class NoBoxAvailableError extends Error {
  constructor() {
    super("No isolate box ID available");
    this.code = "NO_BOX_AVAILABLE";
  }
}

async function acquire({ timeoutMs = 30000, pollMs = 50 } = {}) {
  const { boxIdMin, boxIdMax } = config.sandbox;
  const deadline = Date.now() + timeoutMs;
  const span = boxIdMax - boxIdMin + 1;
  let cursor = Math.floor(Math.random() * span);

  while (Date.now() < deadline) {
    for (let i = 0; i < span; i++) {
      const id = boxIdMin + ((cursor + i) % span);
      const ok = await redis.set(KEY(id), process.pid, "EX", LEASE_TTL_SECONDS, "NX");
      if (ok) {
        cursor = (cursor + i + 1) % span;
        return id;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new NoBoxAvailableError();
}

async function release(id) {
  await redis.del(KEY(id)).catch(() => {});
}

async function withBox(fn) {
  const id = await acquire();
  try {
    return await fn(id);
  } finally {
    await release(id);
  }
}

async function close() {
  await redis.quit().catch(() => {});
}

module.exports = { acquire, release, withBox, close, NoBoxAvailableError };
