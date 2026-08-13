const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const config = require("../core/config");
const { writeFileAtomic, ensureDir } = require("../core/atomicFs");

// Dev-only driver so the pipeline is exercisable off-Linux. No isolation, no
// cgroup accounting: time/memory are wall-clock approximations. Never use for
// real judging or benchmarks.

function runProcess(cmd, args, { cwd, stdinPath, wallTimeMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let peakMemoryKb = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, wallTimeMs);

    const append = (bufRef, chunk) => {
      const next = Buffer.concat([bufRef, chunk]);
      if (next.length > maxOutputBytes) {
        truncated = true;
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };

    child.stdout.on("data", (d) => (stdout = append(stdout, d)));
    child.stderr.on("data", (d) => (stderr = append(stderr, d)));

    if (stdinPath && fs.existsSync(stdinPath)) {
      fs.createReadStream(stdinPath).pipe(child.stdin);
    } else {
      child.stdin.end();
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        exitSignal: null,
        stdout: "",
        stderr: err.message,
        timedOut: false,
        truncated: false,
        seconds: 0,
        peakMemoryKb,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      resolve({
        exitCode: code === null ? -1 : code,
        exitSignal: signal ? 9 : null,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
        seconds,
        peakMemoryKb,
      });
    });
  });
}

async function execute({ command, limits = {}, mounts = [], stdinPath = null }) {
  const wallSeconds = limits.wall_time_limit ?? limits.cpu_time_limit ?? 10;
  const maxOutputBytes = (limits.max_file_size ?? 65536) * 1024;

  const toHostPath = (insidePath, mount) => {
    const rel = insidePath.slice(mount.inside.length).replace(/^[\\/]+/, "");
    return path.join(mount.outside, rel);
  };

  // Sandbox-relative stdin paths must be mapped back to host paths.
  let hostStdin = stdinPath;
  if (stdinPath) {
    for (const m of mounts) {
      if (stdinPath.startsWith(m.inside)) {
        hostStdin = toHostPath(stdinPath, m);
        break;
      }
    }
  }

  let cmd = command[0];
  let args = command.slice(1);
  for (const m of mounts) {
    if (cmd.startsWith(m.inside)) {
      cmd = toHostPath(cmd, m);
      break;
    }
  }
  // Cached binaries are stored under a bare hash name; only fall back to the
  // .exe variant when the extensionless file isn't there.
  if (process.platform === "win32" && !fs.existsSync(cmd) && fs.existsSync(`${cmd}.exe`)) {
    cmd = `${cmd}.exe`;
  }

  const res = await runProcess(cmd, args, {
    cwd: os.tmpdir(),
    stdinPath: hostStdin,
    wallTimeMs: Math.ceil(wallSeconds * 1000),
    maxOutputBytes,
  });

  let isolateStatus = null;
  if (res.timedOut) isolateStatus = "TO";
  else if (res.truncated) isolateStatus = "SG";
  else if (res.exitSignal) isolateStatus = "SG";
  else if (res.exitCode !== 0) isolateStatus = "RE";

  return {
    meta: {},
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.exitCode,
    exitSignal: res.truncated ? 25 : res.exitSignal,
    time: Number(res.seconds.toFixed(3)),
    wallTime: Number(res.seconds.toFixed(3)),
    memory: res.peakMemoryKb,
    isolateStatus,
    killed: res.timedOut,
    message: res.timedOut ? "Time limit exceeded" : null,
  };
}

async function executeWithArtifact({
  command,
  limits = {},
  inputFiles = [],
  artifactName,
  artifactDest,
}) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cj-compile-"));
  try {
    for (const f of inputFiles) {
      await fsp.writeFile(path.join(workDir, f.name), f.content);
    }

    const wallSeconds = limits.wall_time_limit ?? 10;
    const res = await runProcess(command[0], command.slice(1), {
      cwd: workDir,
      stdinPath: null,
      wallTimeMs: Math.ceil(wallSeconds * 1000),
      maxOutputBytes: 1024 * 1024,
    });

    let artifact = null;
    if (artifactName) {
      const candidates = [
        path.join(workDir, artifactName),
        path.join(workDir, `${artifactName}.exe`),
      ];
      for (const c of candidates) {
        try {
          artifact = await fsp.readFile(c);
          break;
        } catch {}
      }
      if (artifact && artifactDest) {
        await ensureDir(path.dirname(artifactDest));
        await writeFileAtomic(artifactDest, artifact, 0o755);
      }
    }

    return {
      meta: {},
      stdout: res.stdout,
      stderr: res.stderr,
      artifact,
      exitCode: res.exitCode,
      exitSignal: res.exitSignal,
      time: Number(res.seconds.toFixed(3)),
      wallTime: Number(res.seconds.toFixed(3)),
      memory: 0,
      isolateStatus: res.exitCode !== 0 ? "RE" : null,
      killed: res.timedOut,
      message: null,
    };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { execute, executeWithArtifact };
