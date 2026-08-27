const path = require("path");
const config = require("../core/config");
const sandbox = require("../sandbox");
const binaryCache = require("./binaryCache");
const { ensureDir } = require("../core/atomicFs");
const { createRedis } = require("../queue/connection");
const { createLogger } = require("../core/logger");

const log = createLogger("compiler");
const redis = createRedis();

const SOURCE_NAME = "Main.java";
const ARTIFACT_NAME = "solution.jar";
const LEASE_TTL_SECONDS = 120;

// A burst of identical submissions must produce one compile, not N. Losers
// wait for the winner's cache entry rather than duplicating the work.
async function acquireLease(compileKey) {
  const key = `cj:compile:lease:${compileKey}`;
  const ok = await redis.set(key, process.pid, "EX", LEASE_TTL_SECONDS, "NX");
  return ok ? () => redis.del(key).catch(() => {}) : null;
}

async function waitForPeer(compileKey, timeoutMs = LEASE_TTL_SECONDS * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const cached = await binaryCache.lookup(compileKey);
    if (cached) return cached;
  }
  return null;
}

async function compile({ compileKey, sourceCode, languageId, limits }) {
  const cached = await binaryCache.lookup(compileKey);
  if (cached) {
    return {
      cacheHit: true,
      success: cached.success,
      binaryPath: cached.binary_path,
      compileOutput: cached.compile_output,
    };
  }

  const releaseLease = await acquireLease(compileKey);
  if (!releaseLease) {
    const peer = await waitForPeer(compileKey);
    if (peer) {
      return {
        cacheHit: true,
        success: peer.success,
        binaryPath: peer.binary_path,
        compileOutput: peer.compile_output,
      };
    }
    // Peer died mid-compile; fall through and compile ourselves.
    log.warn("compile peer wait expired, compiling locally", { compileKey });
  }

  try {
    const again = await binaryCache.lookup(compileKey);
    if (again) {
      return {
        cacheHit: true,
        success: again.success,
        binaryPath: again.binary_path,
        compileOutput: again.compile_output,
      };
    }

    const dest = binaryCache.binaryPath(compileKey);
    await ensureDir(path.dirname(dest));

    const command = [
      "/bin/sh",
      "-c",
      `${config.compile.JavaCompiler} ${SOURCE_NAME} && ` +
        `${config.compile.JavaJar} cvfe ${ARTIFACT_NAME} Main *.class`,
    ];

    const res = await sandbox.executeWithArtifact({
      command,
      limits: {
        wall_time_limit: limits.wall_time_limit ?? 15,
        cpu_time_limit: limits.wall_time_limit ?? 15,
        memory_limit: Math.max(Number(limits.memory_limit ?? 128000), 512000),
        max_processes: 64,
        max_file_size: 131072,
      },

      mounts: [
        {
          inside: config.compile.JavaHome,
          outside: config.compile.JavaHome,
          rw: false,
        },
        {
          inside: config.compile.JavaEtc,
          outside: config.compile.JavaEtc,
          rw: false,
        },
      ],
      env: {
        JAVA_HOME: config.compile.JavaHome,
        PATH: `${config.compile.JavaHome}/bin:/usr/local/bin:/usr/bin:/bin`,
      },

      inputFiles: [{ name: SOURCE_NAME, content: sourceCode }],
      artifactName: ARTIFACT_NAME,
      artifactDest: dest,
    });
    const compileOutput = [res.stdout, res.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const success = res.exitCode === 0 && !!res.artifact;

    await binaryCache.record({
      compileKey,
      languageId,
      binaryFile: dest,
      success,
      compileOutput: compileOutput || null,
    });

    log.info(success ? "compiled" : "compile failed", {
      compileKey,
      seconds: res.time,
    });

    return {
      cacheHit: false,
      success,
      binaryPath: success ? dest : null,
      compileOutput: compileOutput || null,
    };
  } finally {
    if (releaseLease) await releaseLease();
  }
}

async function close() {
  await redis.quit().catch(() => {});
}

module.exports = { compile, close, SOURCE_NAME, ARTIFACT_NAME };
