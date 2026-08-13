function fmt(level, scope, msg, meta) {
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${msg}`;
  return meta ? `${line} ${JSON.stringify(meta)}` : line;
}

function createLogger(scope) {
  return {
    info: (msg, meta) => console.log(fmt("INFO", scope, msg, meta)),
    warn: (msg, meta) => console.warn(fmt("WARN", scope, msg, meta)),
    error: (msg, meta) => console.error(fmt("ERROR", scope, msg, meta)),
    debug: (msg, meta) => {
      if (process.env.NODE_ENV !== "production")
        console.log(fmt("DEBUG", scope, msg, meta));
    },
  };
}

module.exports = { createLogger };
