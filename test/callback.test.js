const test = require("node:test");
const assert = require("node:assert");
const { buildPayload } = require("../src/callbacks/deliver");

// The platform's handler destructures these exact keys and decodes
// stdout/stderr/compile_output unconditionally.
test("callback payload matches the platform handler's contract", () => {
  const payload = buildPayload({
    token: "abc",
    status_id: 3,
    stdout: "42\n",
    stderr: "",
    compile_output: null,
    message: null,
    exit_code: 0,
    time: 0.015,
    memory: 2048,
  });

  for (const key of ["token", "status", "stdout", "stderr", "compile_output", "time", "memory"]) {
    assert.ok(key in payload, `missing ${key}`);
  }
  assert.deepStrictEqual(payload.status, { id: 3, description: "Accepted" });
});

test("time is a fixed-precision string and memory an integer", () => {
  const payload = buildPayload({
    token: "t",
    status_id: 3,
    time: 0.1,
    memory: 1536,
  });
  assert.strictEqual(payload.time, "0.100");
  assert.strictEqual(payload.memory, 1536);
  assert.strictEqual(typeof payload.memory, "number");
});

test("compilation error payload carries compile_output", () => {
  const payload = buildPayload({
    token: "t",
    status_id: 6,
    compile_output: "main.cpp:1:1: error: expected ';'",
  });
  assert.strictEqual(payload.status.id, 6);
  assert.ok(payload.compile_output);
});
