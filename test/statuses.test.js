const test = require("node:test");
const assert = require("node:assert");
const { STATUSES, ID, statusById } = require("../src/core/statuses");
const { mapExecutionStatus, normalizeOutput, compareOutput } =
  require("../src/core/resultMapper");

test("status table matches Judge0 CE ids and descriptions", () => {
  assert.strictEqual(STATUSES.length, 14);
  assert.deepStrictEqual(statusById(3), { id: 3, description: "Accepted" });
  assert.deepStrictEqual(statusById(6), { id: 6, description: "Compilation Error" });
  assert.deepStrictEqual(statusById(7), {
    id: 7,
    description: "Runtime Error (SIGSEGV)",
  });
  assert.deepStrictEqual(statusById(11), {
    id: 11,
    description: "Runtime Error (NZEC)",
  });
  assert.deepStrictEqual(statusById(14), {
    id: 14,
    description: "Exec Format Error",
  });
});

test("unknown status falls back to Internal Error", () => {
  assert.strictEqual(statusById(999).id, 13);
});

test("maps isolate results to Judge0 statuses", () => {
  const limits = { cpu_time_limit: 2 };
  assert.strictEqual(
    mapExecutionStatus({ exitCode: 0, time: 0.1 }, limits),
    ID.ACCEPTED,
  );
  assert.strictEqual(
    mapExecutionStatus({ isolateStatus: "TO", exitCode: 0 }, limits),
    ID.TIME_LIMIT_EXCEEDED,
  );
  assert.strictEqual(
    mapExecutionStatus({ exitCode: 0, exitSignal: 11 }, limits),
    ID.RE_SIGSEGV,
  );
  assert.strictEqual(
    mapExecutionStatus({ exitCode: 0, exitSignal: 8 }, limits),
    ID.RE_SIGFPE,
  );
  assert.strictEqual(
    mapExecutionStatus({ exitCode: 0, exitSignal: 25 }, limits),
    ID.RE_SIGXFSZ,
  );
  assert.strictEqual(
    mapExecutionStatus({ exitCode: 1 }, limits),
    ID.RE_NZEC,
  );
  assert.strictEqual(
    mapExecutionStatus({ isolateStatus: "XX" }, limits),
    ID.INTERNAL_ERROR,
  );
});

test("cpu time over the limit is TLE even on a clean exit", () => {
  assert.strictEqual(
    mapExecutionStatus({ exitCode: 0, time: 2.4 }, { cpu_time_limit: 2 }),
    ID.TIME_LIMIT_EXCEEDED,
  );
});

test("output normalization matches the platform comparator", () => {
  assert.strictEqual(normalizeOutput("42\r\n"), "42");
  assert.strictEqual(normalizeOutput("a  \nb\t\n\n\n"), "a\nb");
  assert.ok(compareOutput("1 2 3\n", "1 2 3"));
  assert.ok(compareOutput("out\r\n\r\n", "out\n"));
  assert.ok(!compareOutput("1 2 3", "1 2 4"));
});
