const { randomUUID } = require("crypto");
const config = require("../core/config");
const { ID } = require("../core/statuses");
const { isCpp, getLimits, getLanguage } = require("../core/languages");
const submissionRepo = require("../db/submissionRepo");
const testcaseStore = require("../testcases/testcaseStore");
const { getCompileQueue } = require("../queue/queues");
const { createLogger } = require("../core/logger");

const log = createLogger("submission");

class ValidationError extends Error {
  constructor(payload, statusCode = 422) {
    super("validation failed");
    this.payload = payload;
    this.statusCode = statusCode;
  }
}

function validate(body) {
  const errors = {};
  if (!body.language_id) errors.language_id = ["can't be blank"];
  else if (!getLanguage(body.language_id)) errors.language_id = ["language not found"];
  if (!body.source_code || !String(body.source_code).trim()) {
    errors.source_code = ["can't be blank"];
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

function buildRow({ body, limits, token, group, index, problemId, version }) {
  return {
    token,
    language_id: Number(body.language_id),
    source_code: body.source_code,
    stdin: body.stdin ?? null,
    expected_output: body.expected_output ?? null,
    problem_id: problemId ?? null,
    testcase_version: version ?? null,
    testcase_index: index ?? null,
    submission_group: group,
    cpu_time_limit: limits.cpu_time_limit,
    wall_time_limit: limits.wall_time_limit,
    memory_limit: limits.memory_limit,
    stack_limit: limits.stack_limit,
    max_processes: limits.max_processes,
    max_file_size: limits.max_file_size,
    callback_url: body.callback_url ?? null,
    compile_key: null,
    status_id: ID.IN_QUEUE,
    is_proxied: false,
    upstream_token: null,
  };
}

/** Judge0-compatible single submission with inline stdin. */
async function createSingle(body) {
  validate(body);
  const limits = getLimits(body.language_id, body);
  const token = randomUUID();
  const group = randomUUID();

  const row = buildRow({ body, limits, token, group, index: 0 });
  await submissionRepo.createMany([row]);

  await getCompileQueue().add(
    "compile",
    { submissionGroup: group, languageId: Number(body.language_id) },
    { jobId: `compile-${group}` },
  );

  return { token };
}

/** Judge0-compatible batch. Token order mirrors input order. */
async function createBatch(submissions) {
  const results = [];
  const groups = [];

  for (const body of submissions) {
    try {
      validate(body);
    } catch (err) {
      results.push({ error: err.payload, token: null });
      groups.push(null);
      continue;
    }
    results.push(null);
    groups.push(body);
  }

  // Identical source in one batch shares a compile job; that is the whole
  // point of the compile-once model.
  const rows = [];
  const jobs = new Map();

  for (let i = 0; i < groups.length; i++) {
    const body = groups[i];
    if (!body) continue;
    const limits = getLimits(body.language_id, body);
    const dedupeKey = `${body.language_id}::${body.source_code}::${body.callback_url ?? ""}`;

    if (!jobs.has(dedupeKey)) {
      jobs.set(dedupeKey, { group: randomUUID(), languageId: Number(body.language_id), next: 0 });
    }
    const job = jobs.get(dedupeKey);
    const token = randomUUID();
    rows.push(buildRow({ body, limits, token, group: job.group, index: job.next++ }));
    results[i] = { token };
  }

  if (rows.length) await submissionRepo.createMany(rows);

  for (const job of jobs.values()) {
    await getCompileQueue().add(
      "compile",
      { submissionGroup: job.group, languageId: job.languageId },
      { jobId: `compile-${job.group}` },
    );
  }

  return results;
}

/**
 * Optimized C++ path: no stdin on the wire. Testcases are resolved judge-side
 * by (problem_id, testcase_version) and one token is returned per testcase,
 * in testcase order.
 */
async function createProblemSubmission(body) {
  validate(body);
  if (!isCpp(body.language_id)) {
    throw new ValidationError(
      { language_id: ["problem submissions are C++ only in this version"] },
      422,
    );
  }
  if (!body.problem_id) {
    throw new ValidationError({ problem_id: ["can't be blank"] });
  }

  const version = Number(body.testcase_version ?? 1);
  const caseCount = await testcaseStore.getCaseCount(body.problem_id, version);
  if (!caseCount) {
    throw new ValidationError({ problem_id: ["no testcases found"] }, 404);
  }

  const limits = getLimits(body.language_id, body);
  const group = randomUUID();

  const rows = [];
  const tokens = [];
  for (let i = 0; i < caseCount; i++) {
    const token = randomUUID();
    tokens.push(token);
    rows.push(
      buildRow({
        body,
        limits,
        token,
        group,
        index: i,
        problemId: String(body.problem_id),
        version,
      }),
    );
  }

  await submissionRepo.createMany(rows);
  await getCompileQueue().add(
    "compile",
    {
      submissionGroup: group,
      languageId: Number(body.language_id),
      problemId: String(body.problem_id),
      testcaseVersion: version,
    },
    { jobId: `compile-${group}` },
  );

  log.info("problem submission queued", {
    problemId: body.problem_id,
    version,
    testcases: caseCount,
  });

  return { tokens: tokens.map((t) => ({ token: t })), submission_group: group };
}

module.exports = {
  createSingle,
  createBatch,
  createProblemSubmission,
  ValidationError,
};
