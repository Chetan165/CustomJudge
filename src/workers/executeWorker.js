const path = require("path");
const { Worker } = require("bullmq");
const { connection } = require("../queue/connection");
const { executeQueueName, QUEUE_PREFIX } = require("../queue/queues");
const config = require("../core/config");
const { ID } = require("../core/statuses");
const sandbox = require("../sandbox");
const submissionRepo = require("../db/submissionRepo");
const testcaseStore = require("../testcases/testcaseStore");
const { mapExecutionStatus, compareOutput } = require("../core/resultMapper");
const { deliver } = require("../callbacks/deliver");
const { publishFinished } = require("../api/waitRegistry");
const { writeFileAtomic, ensureDir } = require("../core/atomicFs");
const { createLogger } = require("../core/logger");

const log = createLogger("execute-worker");

const TC_MOUNT = "/tc";
const BIN_MOUNT = "/bin_ro";

//54, 76, 105, 52, 53

const LanguageCommands = {
  62: function (binaryPath, limits) {
    const heapMb = Math.max(
      32,
      Math.floor((limits.memory_limit ?? 128000) / 1024) - 32,
    );
    const command = [
      `${config.compile.JavaExecutable}`,
      "-Xss1m",
      `-Xmx${heapMb}m`,
      "-jar",
      `${BIN_MOUNT}/${path.basename(binaryPath)}`,
    ];
    return command;
  },
  54: function (binaryPath, limits) {
    const command = [`${BIN_MOUNT}/${path.basename(binaryPath)}`];
    return command;
  },
  76: function (binaryPath, limits) {
    const command = [`${BIN_MOUNT}/${path.basename(binaryPath)}`];
    return command;
  },
  105: function (binaryPath, limits) {
    const command = [`${BIN_MOUNT}/${path.basename(binaryPath)}`];
    return command;
  },
  52: function (binaryPath, limits) {
    const command = [`${BIN_MOUNT}/${path.basename(binaryPath)}`];
    return command;
  },
  53: function (binaryPath, limits) {
    const command = [`${BIN_MOUNT}/${path.basename(binaryPath)}`];
    return command;
  },
};

// Compile is a separate job here, so an execution run never needs the wall
// budget that stock Judge0 reserves for compiling. Tighter = faster TLE.
function executionWallLimit(row) {
  const cpu = Number(row.cpu_time_limit ?? 2);
  return Math.min(Number(row.wall_time_limit ?? 10), cpu * 2 + 1);
}

async function resolveStdin(row) {
  if (row.problem_id != null && row.testcase_version != null) {
    const manifest = await testcaseStore.getManifest(
      row.problem_id,
      row.testcase_version,
    );
    const dir = testcaseStore.versionDir(row.problem_id, row.testcase_version);
    const name = testcaseStore.inputFileName(manifest, row.testcase_index);
    return {
      mountDir: dir,
      sandboxPath: `${TC_MOUNT}/${name}`,
      expected: await testcaseStore.readExpectedOutput(
        row.problem_id,
        row.testcase_version,
        row.testcase_index,
      ),
    };
  }

  // Inline-stdin path (Judge0 compatibility): stage to a temp dir and mount it.
  const dir = path.join(config.paths.tmp, `stdin-${row.token}`);
  await ensureDir(dir);
  await writeFileAtomic(path.join(dir, "stdin.txt"), row.stdin ?? "");
  return {
    mountDir: dir,
    sandboxPath: `${TC_MOUNT}/stdin.txt`,
    expected: row.expected_output,
    cleanup: dir,
  };
}

async function processExecute(job) {
  const { token, binaryPath } = job.data;

  const row = await submissionRepo.findByToken(token);
  if (!row) {
    log.warn("token not found", { token });
    return;
  }

  await submissionRepo.setStatus(token, ID.PROCESSING);
  const stdin = await resolveStdin(row);

  const limits = {
    cpu_time_limit: Number(row.cpu_time_limit ?? 2),
    wall_time_limit: executionWallLimit(row),
    memory_limit: Number(row.memory_limit ?? 128000),
    stack_limit: Number(row.stack_limit ?? 64000),
    max_processes: Number(row.max_processes ?? 30),
    max_file_size: Number(row.max_file_size ?? 65536),
    enable_network: false,
  };

  let res;
  try {
    // Fresh box every run; binary mounted read-only so no testcase can tamper
    // with it for subsequent runs.
    res = await sandbox.execute({
      command: LanguageCommands[row.language_id](binaryPath, limits),
      limits,
      mounts: [
        { inside: TC_MOUNT, outside: stdin.mountDir, rw: false },
        { inside: BIN_MOUNT, outside: path.dirname(binaryPath), rw: false },

        // Java JDK — read-only
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
      stdinPath: stdin.sandboxPath,
    });
  } finally {
    if (stdin.cleanup) {
      const fsp = require("fs").promises;
      await fsp
        .rm(stdin.cleanup, { recursive: true, force: true })
        .catch(() => {});
    }
  }

  let statusId = mapExecutionStatus(res, limits);

  // Option A: the platform owns comparison. Only compare when the caller
  // supplied expected_output, matching Judge0's own behavior.
  if (statusId === ID.ACCEPTED && row.expected_output != null) {
    if (!compareOutput(res.stdout, row.expected_output)) {
      statusId = ID.WRONG_ANSWER;
    }
  }

  const finalRow = await submissionRepo.finalize(token, {
    status_id: statusId,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    compile_output: null,
    message: res.message ?? null,
    exit_code: res.exitCode ?? null,
    exit_signal: res.exitSignal ?? null,
    time: res.time ?? null,
    wall_time: res.wallTime ?? null,
    memory: res.memory ?? null,
  });

  await publishFinished(token);
  await deliver(finalRow);

  return { token, statusId };
}

const worker = new Worker(executeQueueName(), processExecute, {
  connection,
  prefix: QUEUE_PREFIX,
  concurrency: config.worker.executeConcurrency,
});

worker.on("failed", async (job, err) => {
  log.error("execute job failed", { jobId: job?.id, err: err.message });
  if (!job?.data?.token) return;
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;

  const finalRow = await submissionRepo.finalize(job.data.token, {
    status_id: ID.INTERNAL_ERROR,
    message: err.message,
  });
  await publishFinished(job.data.token);
  await deliver(finalRow);
});

log.info("execute worker started", {
  queue: executeQueueName(),
  concurrency: config.worker.executeConcurrency,
  driver: config.sandbox.driver,
});

module.exports = { worker, processExecute };
