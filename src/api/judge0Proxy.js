const config = require("../core/config");
const { createLogger } = require("../core/logger");

const log = createLogger("proxy");

// Non-C++ languages are forwarded verbatim to a real Judge0 so the service is a
// genuine drop-in even though only C++ is optimized.
async function forward(req, res) {
  if (!config.judge0Fallback.url) {
    return res.status(503).json({
      error: "No Judge0 fallback configured for non-C++ languages",
    });
  }

  const url = `${config.judge0Fallback.url.replace(/\/$/, "")}${req.originalUrl}`;

  const headers = { "Content-Type": "application/json" };
  if (config.judge0Fallback.authToken) {
    headers["X-Auth-Token"] = config.judge0Fallback.authToken;
  }
  if (req.get("X-Auth-User")) headers["X-Auth-User"] = req.get("X-Auth-User");

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    return res.send(text);
  } catch (err) {
    log.error("proxy failed", { url, err: err.message });
    return res.status(502).json({ error: `Judge0 fallback unreachable: ${err.message}` });
  }
}

module.exports = { forward };
