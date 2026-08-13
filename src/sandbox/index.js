const config = require("../core/config");
const { createLogger } = require("../core/logger");

const log = createLogger("sandbox");

function loadDriver() {
  if (config.sandbox.driver === "isolate") {
    return require("./isolateDriver");
  }
  if (config.env === "production") {
    throw new Error(
      "SANDBOX_DRIVER=mock is not permitted in production; isolate is required.",
    );
  }
  log.warn("using mock sandbox driver - no isolation, dev only");
  return require("./mockDriver");
}

module.exports = loadDriver();
