const { Worker } = require("bullmq");
const { connection } = require("../queue/connection");
const {
  COMPILE_QUEUE,
  QUEUE_PREFIX,
  getExecuteQueue,
} = require("../queue/queues");
const config = require("../core/config");
const { ID } = require("../core/statuses");
const { compileCacheKey } = require("../core/hash");
const submissionRepo = require("../db/submissionRepo");
const testcaseStore = require("../testcases/testcaseStore");
const compilerCpp = require("../compile/compiler");
const compilerJava = require("../compile/compiler-java");
const { deliver } = require("../callbacks/deliver");
const { publishFinished } = require("../api/waitRegistry");
const { createLogger } = require("../core/logger");

const log = createLogger("compile-worker");

const DecideCompiler = (languageId) => {
  if (languageId == 62) {
    return compilerJava;
  }
  return compilerCpp;
};

async function emitCompilationError(groupId, compileOutput) {
  const rows = await submissionRepo.finalizeGroup(groupId, {
    status_id: ID.COMPILATION_ERROR,
    compile_output: compileOutput,
    message: null,
  });
  // Every token gets a callback: the platform waits for N before evaluating.
  for (const row of rows) {
    await publishFinished(row.token);
    await deliver(row);
  }
}

async function processCompile(job) {
  const { submissionGroup, languageId, problemId, testcaseVersion } = job.data;
  const compiler = DecideCompiler(languageId);

  const rows = await submissionRepo.findGroup(submissionGroup);
  if (!rows.length) {
    log.warn("no rows for group", { submissionGroup });
    return;
  }

  const first = rows[0];
  await submissionRepo.setGroupStatus(submissionGroup, ID.PROCESSING);

  const key = compileCacheKey(
    first.source_code,
    languageId,
    config.compile.flags,
  );
  await submissionRepo.setCompileKey(submissionGroup, key);

  const limits = {
    wall_time_limit: first.wall_time_limit,
    memory_limit: first.memory_limit,
  };

  const result = await compiler.compile({
    compileKey: key,
    sourceCode: first.source_code,
    languageId,
    limits,
  });

  if (!result.success) {
    await emitCompilationError(submissionGroup, result.compileOutput);
    return { compiled: false, cacheHit: result.cacheHit };
  }

  if (problemId != null && testcaseVersion != null) {
    await testcaseStore.materialize(problemId, testcaseVersion);
  }

  const executeQueue = getExecuteQueue(config.worker.nodeId);
  await executeQueue.addBulk(
    rows.map((row) => ({
      name: "execute",
      data: {
        token: row.token,
        binaryPath: result.binaryPath,
        problemId: row.problem_id,
        testcaseVersion: row.testcase_version,
        testcaseIndex: row.testcase_index,
      },
      opts: { jobId: `exec-${row.token}` },
    })),
  );

  log.info("enqueued execution", {
    submissionGroup,
    count: rows.length,
    cacheHit: result.cacheHit,
  });

  return { compiled: true, cacheHit: result.cacheHit, testcases: rows.length };
}

const worker = new Worker(COMPILE_QUEUE, processCompile, {
  connection,
  prefix: QUEUE_PREFIX,
  concurrency: config.worker.compileConcurrency,
});

worker.on("failed", async (job, err) => {
  log.error("compile job failed", { jobId: job?.id, err: err.message });
  if (!job?.data?.submissionGroup) return;
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;

  const rows = await submissionRepo.finalizeGroup(job.data.submissionGroup, {
    status_id: ID.INTERNAL_ERROR,
    compile_output: null,
    message: err.message,
  });
  for (const row of rows) {
    await publishFinished(row.token);
    await deliver(row);
  }
});

worker.on("completed", (job) =>
  log.debug("compile job done", { jobId: job.id }),
);

log.info("compile worker started", {
  concurrency: config.worker.compileConcurrency,
  driver: config.sandbox.driver,
});

module.exports = { worker, processCompile };
