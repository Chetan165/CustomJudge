const { createApp } = require("./app");
const config = require("../core/config");
const { createLogger } = require("../core/logger");

const log = createLogger("api");
const app = createApp();

const server = app.listen(config.port, () => {
  log.info("listening", { port: config.port, env: config.env });
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.info("shutting down");
    server.close(() => process.exit(0));
  });
}
