const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const config = require("../core/config");
const { shardedPath } = require("../core/hash");
const { exists, ensureDir } = require("../core/atomicFs");
const { query } = require("../db/pool");
const { createLogger } = require("../core/logger");

const log = createLogger("binary-cache");

// Windows can't exec an extensionless file; harmless suffix on the dev path.
const BIN_SUFFIX = process.platform === "win32" ? ".exe" : "";

function binaryPath(compileKey) {
  const [shard, rest] = shardedPath(compileKey);
  return path.join(config.paths.binaries, shard, rest + BIN_SUFFIX);
}

async function lookup(compileKey) {
  const res = await query(
    `SELECT * FROM compile_cache WHERE compile_key = $1 AND node_id = $2`,
    [compileKey, config.worker.nodeId],
  );
  const row = res.rows[0];
  if (!row) return null;

  // Cached compile errors need no binary on disk.
  if (!row.success) return row;

  if (!(await exists(row.binary_path))) {
    await query(
      `DELETE FROM compile_cache WHERE compile_key = $1 AND node_id = $2`,
      [compileKey, config.worker.nodeId],
    );
    return null;
  }

  await query(
    `UPDATE compile_cache
        SET last_used_at = now(), hit_count = hit_count + 1
      WHERE compile_key = $1 AND node_id = $2`,
    [compileKey, config.worker.nodeId],
  );
  return row;
}

async function record({ compileKey, languageId, binaryFile, success, compileOutput }) {
  let size = 0;
  if (success && binaryFile) {
    try {
      size = (await fsp.stat(binaryFile)).size;
    } catch {}
  }

  await query(
    `INSERT INTO compile_cache
       (compile_key, node_id, language_id, binary_path, size_bytes, success, compile_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (compile_key, node_id) DO UPDATE
       SET binary_path = EXCLUDED.binary_path,
           size_bytes = EXCLUDED.size_bytes,
           success = EXCLUDED.success,
           compile_output = EXCLUDED.compile_output,
           last_used_at = now()`,
    [
      compileKey,
      config.worker.nodeId,
      Number(languageId),
      success ? binaryFile : null,
      size,
      success,
      compileOutput ?? null,
    ],
  );

  if (success) await evictIfNeeded();
}

async function evictIfNeeded() {
  const limit = config.compile.binaryCacheMaxBytes;
  const res = await query(
    `SELECT COALESCE(SUM(size_bytes),0) AS total
       FROM compile_cache WHERE node_id = $1 AND success = TRUE`,
    [config.worker.nodeId],
  );
  let total = Number(res.rows[0].total);
  if (total <= limit) return;

  const victims = await query(
    `SELECT compile_key, binary_path, size_bytes
       FROM compile_cache
      WHERE node_id = $1 AND success = TRUE
      ORDER BY last_used_at ASC
      LIMIT 200`,
    [config.worker.nodeId],
  );

  for (const v of victims.rows) {
    if (total <= limit * 0.9) break;
    await fsp.rm(v.binary_path, { force: true }).catch(() => {});
    await query(
      `DELETE FROM compile_cache WHERE compile_key = $1 AND node_id = $2`,
      [v.compile_key, config.worker.nodeId],
    );
    total -= Number(v.size_bytes);
    log.info("evicted binary", { compileKey: v.compile_key });
  }
}

module.exports = { binaryPath, lookup, record, evictIfNeeded };
