const IORedis = require("ioredis");
const config = require("../core/config");

function createRedis(extra = {}) {
  return new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: null,
    ...extra,
  });
}

const connection = createRedis();

module.exports = { connection, createRedis };
