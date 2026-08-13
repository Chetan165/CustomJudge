const test = require("node:test");
const assert = require("node:assert");
const {
  decodeField,
  encodeField,
  decodeSubmissionInput,
} = require("../src/core/encoding");
const { serializeSubmission } = require("../src/api/serialize");

test("plaintext passes through untouched when base64 is off", () => {
  assert.strictEqual(decodeField("int main(){}", false), "int main(){}");
  assert.strictEqual(encodeField("42\n", false), "42\n");
});

test("base64 round-trips", () => {
  const src = "#include <iostream>\nint main(){}\n";
  assert.strictEqual(decodeField(encodeField(src, true), true), src);
});

test("null fields stay null rather than becoming empty strings", () => {
  assert.strictEqual(decodeField(null, true), null);
  assert.strictEqual(encodeField(undefined, true), null);
});

test("decodeSubmissionInput only touches the encoded fields", () => {
  const body = {
    language_id: 54,
    source_code: Buffer.from("src").toString("base64"),
    stdin: Buffer.from("1 2").toString("base64"),
    cpu_time_limit: 2,
  };
  const out = decodeSubmissionInput(body, true);
  assert.strictEqual(out.source_code, "src");
  assert.strictEqual(out.stdin, "1 2");
  assert.strictEqual(out.cpu_time_limit, 2);
});

test("serializer emits Judge0's default field set", () => {
  const row = {
    token: "t1",
    status_id: 3,
    stdout: "42\n",
    stderr: null,
    compile_output: null,
    message: null,
    exit_code: 0,
    time: 0.012,
    memory: 3200,
    language_id: 54,
  };
  const out = serializeSubmission(row, { base64: false });
  assert.deepStrictEqual(Object.keys(out).sort(), [
    "compile_output",
    "exit_code",
    "memory",
    "message",
    "status",
    "stderr",
    "stdout",
    "time",
    "token",
  ]);
  assert.deepStrictEqual(out.status, { id: 3, description: "Accepted" });
  assert.strictEqual(out.time, "0.012");
  assert.strictEqual(out.memory, 3200);
});

test("serializer honors an explicit fields list", () => {
  const row = { token: "t1", status_id: 5, time: 2, memory: 100 };
  const out = serializeSubmission(row, {
    base64: false,
    fields: ["token", "status", "time"],
  });
  assert.deepStrictEqual(Object.keys(out), ["token", "status", "time"]);
});
