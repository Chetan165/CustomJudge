const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const config = require("../core/config");
const boxPool = require("./boxPool");
const { createLogger } = require("../core/logger");

const log = createLogger("isolate");

function run(bin, args, { input, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input !== undefined && input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

// isolate --meta output is `key:value` per line; exit signals may repeat.
function parseMeta(text) {
  const meta = {};
  for (const line of String(text).split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return meta;
}

async function init(boxId) {
  const res = await run(config.sandbox.isolateBin, [
    "--cg",
    `--box-id=${boxId}`,
    "--init",
  ]);
  if (res.code !== 0) {
    throw new Error(`isolate --init failed (${res.code}): ${res.stderr}`);
  }
  return res.stdout.trim();
}

async function cleanup(boxId) {
  await run(config.sandbox.isolateBin, [
    "--cg",
    `--box-id=${boxId}`,
    "--cleanup",
  ]);
}

function buildLimitArgs(limits) {
  const args = [];
  if (limits.cpu_time_limit != null)
    args.push(`--time=${limits.cpu_time_limit}`);
  if (limits.wall_time_limit != null)
    args.push(`--wall-time=${limits.wall_time_limit}`);
  if (limits.extra_time != null) args.push(`--extra-time=${limits.extra_time}`);
  if (limits.memory_limit != null) args.push(`--cg-mem=${limits.memory_limit}`);
  if (limits.stack_limit != null) args.push(`--stack=${limits.stack_limit}`);
  if (limits.max_file_size != null)
    args.push(`--fsize=${limits.max_file_size}`);
  if (limits.max_processes != null)
    args.push(`--processes=${limits.max_processes}`);
  if (limits.enable_network) args.push("--share-net");
  return args;
}

/**
 * One isolate run. `mounts` are bound read-only; stdin/stdout/stderr paths are
 * resolved inside the sandbox namespace, so stdin must live under a mount.
 */
async function execute({
  command,
  limits = {},
  mounts = [],
  stdinPath = null,
  env = {},
  cwd = null,
}) {
  return boxPool.withBox(async (boxId) => {
    // Clear anything a crashed worker left behind before claiming the box.
    await cleanup(boxId);
    const boxRoot = await init(boxId);
    const boxDir = path.join(boxRoot, "box");
    const metaPath = path.join(boxRoot, "meta.txt");

    try {
      const args = ["--cg", `--box-id=${boxId}`, `--meta=${metaPath}`];

      for (const m of mounts) {
        args.push(`--dir=${m.inside}=${m.outside}${m.rw ? ":rw" : ""}`);
      }

      args.push("--stdout=__stdout", "--stderr=__stderr");
      if (stdinPath) args.push(`--stdin=${stdinPath}`);
      if (cwd) args.push(`--chdir=${cwd}`);

      for (const [k, v] of Object.entries(env)) args.push(`--env=${k}=${v}`);
      args.push(...buildLimitArgs(limits));
      args.push("--run", "--", ...command);

      const res = await run(config.sandbox.isolateBin, args);

      const [metaRaw, stdout, stderr] = await Promise.all([
        fsp.readFile(metaPath, "utf8").catch(() => ""),
        fsp.readFile(path.join(boxDir, "__stdout"), "utf8").catch(() => ""),
        fsp.readFile(path.join(boxDir, "__stderr"), "utf8").catch(() => ""),
      ]);

      const meta = parseMeta(metaRaw);
      return {
        meta,
        stdout,
        stderr,
        isolateExitCode: res.code,
        isolateStderr: res.stderr,
        exitCode: meta["exitcode"] != null ? Number(meta["exitcode"]) : 0,
        exitSignal: meta["exitsig"] != null ? Number(meta["exitsig"]) : null,
        time: meta["time"] != null ? Number(meta["time"]) : null,
        wallTime: meta["time-wall"] != null ? Number(meta["time-wall"]) : null,
        memory: meta["cg-mem"] != null ? Number(meta["cg-mem"]) : null,
        // TO/RE/SG/XX
        isolateStatus: meta["status"] || null,
        killed: meta["killed"] === "1",
        message: meta["message"] || null,
      };
    } finally {
      await cleanup(boxId).catch((e) =>
        log.warn("cleanup failed", { boxId, err: e.message }),
      );
    }
  });
}

// Compile writes an artifact, so the box dir is mounted read-write and the
// output is copied out before cleanup destroys the box.
async function executeWithArtifact({
  command,
  limits = {},
  mounts = [],
  env = {},
  inputFiles = [],
  artifactName,
  artifactDest,
}) {
  return boxPool.withBox(async (boxId) => {
    await cleanup(boxId);
    const boxRoot = await init(boxId);
    const boxDir = path.join(boxRoot, "box");
    const metaPath = path.join(boxRoot, "meta.txt");

    try {
      // Write submitted source/input files into the writable isolate box.
      for (const f of inputFiles) {
        await fsp.writeFile(path.join(boxDir, f.name), f.content);
      }

      const args = [
        "--cg",
        `--box-id=${boxId}`,
        `--meta=${metaPath}`,
        "--stdout=__stdout",
        "--stderr=__stderr",

        // Optional host-directory mounts.
        // Default is [] so existing C++ behavior is unchanged.
        ...mounts.map(
          (m) => `--dir=${m.inside}=${m.outside}${m.rw ? ":rw" : ""}`,
        ),

        // Java/JVM needs multiple threads.
        "--processes=64",

        // Existing sandbox environment.
        `--env=HOME=/box`,

        // Optional additional environment variables.
        ...Object.entries(env).map(([key, value]) => `--env=${key}=${value}`),

        ...buildLimitArgs(limits),

        "--run",
        "--",
        ...command,
      ];

      const res = await run(config.sandbox.isolateBin, args);

      const [metaRaw, stdout, stderr] = await Promise.all([
        fsp.readFile(metaPath, "utf8").catch(() => ""),
        fsp.readFile(path.join(boxDir, "__stdout"), "utf8").catch(() => ""),
        fsp.readFile(path.join(boxDir, "__stderr"), "utf8").catch(() => ""),
      ]);

      const meta = parseMeta(metaRaw);

      let artifact = null;

      if (artifactName) {
        const src = path.join(boxDir, artifactName);

        try {
          artifact = await fsp.readFile(src);

          if (artifactDest) {
            const { writeFileAtomic } = require("../core/atomicFs");

            await writeFileAtomic(artifactDest, artifact, 0o755);
          }
        } catch {
          artifact = null;
        }
      }

      return {
        meta,
        stdout,
        stderr,
        artifact,
        isolateExitCode: res.code,
        exitCode: meta["exitcode"] != null ? Number(meta["exitcode"]) : 0,
        exitSignal: meta["exitsig"] != null ? Number(meta["exitsig"]) : null,
        time: meta["time"] != null ? Number(meta["time"]) : null,
        wallTime: meta["time-wall"] != null ? Number(meta["time-wall"]) : null,
        memory: meta["cg-mem"] != null ? Number(meta["cg-mem"]) : null,
        isolateStatus: meta["status"] || null,
        killed: meta["killed"] === "1",
        message: meta["message"] || null,
      };
    } finally {
      await cleanup(boxId).catch(() => {});
    }
  });
}

module.exports = { execute, executeWithArtifact, parseMeta, buildLimitArgs };
