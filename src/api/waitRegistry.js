const { createRedis } = require("../queue/connection");
const { createLogger } = require("../core/logger");

const log = createLogger("wait");
const CHANNEL = "cj:finished";

let subscriber = null;
const publisher = createRedis();
const waiters = new Map();

function ensureSubscriber() {
  if (subscriber) return;
  subscriber = createRedis();
  subscriber.subscribe(CHANNEL).catch((e) =>
    log.error("subscribe failed", { err: e.message }),
  );
  subscriber.on("message", (_ch, token) => {
    const list = waiters.get(token);
    if (!list) return;
    waiters.delete(token);
    for (const resolve of list) resolve(token);
  });
}

// Workers publish here so a blocked wait=true request returns promptly instead
// of polling Postgres.
async function publishFinished(token) {
  await publisher.publish(CHANNEL, String(token)).catch(() => {});
}

function waitFor(token, timeoutMs) {
  ensureSubscriber();
  return new Promise((resolve) => {
    const list = waiters.get(token) || [];
    list.push(resolve);
    waiters.set(token, list);

    setTimeout(() => {
      const current = waiters.get(token);
      if (!current) return;
      const idx = current.indexOf(resolve);
      if (idx !== -1) current.splice(idx, 1);
      if (!current.length) waiters.delete(token);
      resolve(null);
    }, timeoutMs);
  });
}

module.exports = { publishFinished, waitFor };
