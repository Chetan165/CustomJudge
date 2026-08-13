// End-to-end pipeline check against real Postgres + Redis using the mock
// sandbox. Verifies the compile-once/execute-many contract.
// Requires: docker compose up postgres redis, npm run migrate, a g++ on PATH.
const assert = require("node:assert");
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const config = require("../../src/core/config");
const { createApp } = require("../../src/api/app");
const submissionRepo = require("../../src/db/submissionRepo");
const { pool } = require("../../src/db/pool");
const { getCompileQueue, getExecuteQueue } = require("../../src/queue/queues");
const { connection } = require("../../src/queue/connection");

const SOURCE = `#include <iostream>
int main(){ long long a,b; std::cin >> a >> b; std::cout << a+b << std::endl; }`;

const received = [];

function startCallbackServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(200);
        res.end("ok");
      });
    });
    server.listen(0, () => resolve(server));
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  console.log(`sandbox driver: ${config.sandbox.driver}`);

  const cbServer = await startCallbackServer();
  const cbUrl = `http://127.0.0.1:${cbServer.address().port}/cb`;

  const app = createApp();
  const apiServer = app.listen(0);
  const base = `http://127.0.0.1:${apiServer.address().port}`;

  require("../../src/workers/compileWorker");
  require("../../src/workers/executeWorker");

  // Batch of 5 identical sources with different stdin — the exact shape the
  // platform sends. Must compile once, not five times.
  const stdins = ["1 2", "10 20", "100 200", "-5 5", "999 1"];
  const expected = ["3", "30", "300", "0", "1000"];

  const res = await fetch(`${base}/submissions/batch?base64_encoded=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      submissions: stdins.map((stdin) => ({
        source_code: SOURCE,
        language_id: 54,
        stdin,
        callback_url: cbUrl,
      })),
    }),
  });

  assert.strictEqual(res.status, 201, `batch submit failed: ${res.status}`);
  const tokens = (await res.json()).map((r) => r.token);
  assert.strictEqual(tokens.length, 5);
  console.log(`submitted ${tokens.length} tokens`);

  await waitFor(
    async () => received.length === 5,
    60000,
    `5 callbacks (got ${received.length})`,
  );

  const rows = await submissionRepo.findByTokens(tokens);

  // All five share one compile key: one compile served five executions.
  const compileKeys = new Set(rows.map((r) => r.compile_key));
  assert.strictEqual(compileKeys.size, 1, "expected a single shared compile key");
  console.log(`compile key shared across all 5: ${[...compileKeys][0].slice(0, 12)}...`);

  const groups = new Set(rows.map((r) => r.submission_group));
  assert.strictEqual(groups.size, 1, "identical sources should share one group");

  rows.forEach((row, i) => {
    assert.strictEqual(row.status_id, 3, `tc${i} status was ${row.status_id}`);
    assert.strictEqual(
      (row.stdout || "").trim(),
      expected[i],
      `tc${i} expected ${expected[i]} got ${(row.stdout || "").trim()}`,
    );
  });
  console.log("all 5 testcases produced correct output");

  // Callback ordering and shape must match what the platform destructures.
  for (const cb of received) {
    assert.ok(cb.token, "callback missing token");
    assert.ok(cb.status && typeof cb.status.id === "number", "bad status");
    for (const k of ["stdout", "stderr", "compile_output", "time", "memory"]) {
      assert.ok(k in cb, `callback missing ${k}`);
    }
  }
  const decoded = received.map((cb) =>
    Buffer.from(cb.stdout || "", "base64").toString("utf8").trim(),
  );
  assert.deepStrictEqual(decoded.sort(), [...expected].sort());
  console.log("callbacks base64-encoded and correctly shaped");

  // Resubmitting identical source must hit the compile cache.
  const before = await pool.query(
    `SELECT hit_count FROM compile_cache WHERE compile_key = $1`,
    [[...compileKeys][0]],
  );

  const res2 = await fetch(`${base}/submissions?base64_encoded=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_code: SOURCE,
      language_id: 54,
      stdin: "7 8",
      expected_output: "15",
      callback_url: cbUrl,
    }),
  });
  const token2 = (await res2.json()).token;
  await waitFor(
    async () => {
      const r = await submissionRepo.findByToken(token2);
      return r && r.status_id >= 3;
    },
    60000,
    "second submission to finish",
  );

  const after = await pool.query(
    `SELECT hit_count FROM compile_cache WHERE compile_key = $1`,
    [[...compileKeys][0]],
  );
  assert.ok(
    Number(after.rows[0].hit_count) > Number(before.rows[0].hit_count),
    "resubmission should have hit the compile cache",
  );
  console.log(
    `compile cache hit_count ${before.rows[0].hit_count} -> ${after.rows[0].hit_count}`,
  );

  const r2 = await submissionRepo.findByToken(token2);
  assert.strictEqual(r2.status_id, 3, "expected Accepted with matching output");
  console.log("expected_output comparison produced Accepted");

  // A compile error must produce a callback for every token in the group.
  received.length = 0;
  const badRes = await fetch(`${base}/submissions/batch?base64_encoded=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      submissions: [0, 1, 2].map((i) => ({
        source_code: "int main(){ this is not c++ }",
        language_id: 54,
        stdin: String(i),
        callback_url: cbUrl,
      })),
    }),
  });
  const badTokens = (await badRes.json()).map((r) => r.token);
  await waitFor(
    async () => received.length === 3,
    60000,
    `3 compile-error callbacks (got ${received.length})`,
  );
  const badRows = await submissionRepo.findByTokens(badTokens);
  for (const row of badRows) {
    assert.strictEqual(row.status_id, 6, "expected Compilation Error");
    assert.ok(row.compile_output, "expected compile_output to be populated");
  }
  console.log("compile error fanned out to all 3 tokens with status 6");

  console.log("\nE2E PASSED");

  apiServer.close();
  cbServer.close();
  await connection.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error("\nE2E FAILED:", err.message);
  process.exit(1);
});
