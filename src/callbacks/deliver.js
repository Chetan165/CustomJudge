const config = require("../core/config");
const { statusById } = require("../core/statuses");
const { encodeField } = require("../core/encoding");
const { createLogger } = require("../core/logger");

const log = createLogger("callback");

// Shape must match what the platform's handler destructures:
// token, status{id,description}, stdout, stderr, compile_output, time, memory.
function buildPayload(row) {
  const b64 = config.callback.base64;
  return {
    token: row.token,
    status: statusById(row.status_id),
    stdout: encodeField(row.stdout, b64),
    stderr: encodeField(row.stderr, b64),
    compile_output: encodeField(row.compile_output, b64),
    message: encodeField(row.message, b64),
    exit_code: row.exit_code ?? null,
    time: row.time != null ? String(Number(row.time).toFixed(3)) : null,
    memory: row.memory != null ? Number(row.memory) : null,
  };
}

async function post(url, payload) {
  const headers = { "Content-Type": "application/json" };
  if (config.callback.authHeader && config.callback.authToken) {
    headers[config.callback.authHeader] = config.callback.authToken;
  }
  const res = await fetch(url, {
    method: config.callback.method,
    headers,
    body: JSON.stringify(payload),
  });
  return res;
}

async function deliver(row) {
  if (!row || !row.callback_url) return { delivered: false, skipped: true };

  const payload = buildPayload(row);
  const max = config.callback.maxAttempts;

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const res = await post(row.callback_url, payload);
      if (res.ok) return { delivered: true, attempts: attempt };
      log.warn("callback non-2xx", {
        token: row.token,
        status: res.status,
        attempt,
      });
    } catch (err) {
      log.warn("callback error", { token: row.token, err: err.message, attempt });
    }
    if (attempt < max) {
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 250, 8000)));
    }
  }

  log.error("callback delivery exhausted", { token: row.token });
  return { delivered: false, attempts: max };
}

module.exports = { deliver, buildPayload };
