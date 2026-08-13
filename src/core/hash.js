const crypto = require("crypto");

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// Compile cache key. Flags are part of the key so a config change
// invalidates cached binaries without manual eviction.
function compileCacheKey(sourceCode, languageId, flags) {
  const payload = JSON.stringify({
    s: sourceCode,
    l: Number(languageId),
    f: Array.isArray(flags) ? flags : String(flags).split(/\s+/).filter(Boolean),
  });
  return sha256(payload);
}

function shardedPath(hash) {
  return [hash.slice(0, 2), hash.slice(2)];
}

module.exports = { sha256, compileCacheKey, shardedPath };
