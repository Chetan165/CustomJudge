const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const config = require("../core/config");
const { sha256 } = require("../core/hash");
const {
  ensureDir,
  publishDirAtomic,
  makeStagingDir,
  exists,
  dirSize,
} = require("../core/atomicFs");
const { createRedis } = require("../queue/connection");
const platformSource = require("./platformSource");
const { query } = require("../db/pool");
const { createLogger } = require("../core/logger");

const log = createLogger("testcases");
const redis = createRedis();

const MANIFEST = "manifest.json";
const LOCK_TTL_SECONDS = 120;

function versionDir(problemId, version) {
  return path.join(config.paths.problems, String(problemId), `v${version}`);
}

function pad(n) {
  return String(n).padStart(3, "0");
}

// Problem setters are typically on Windows; a stray CRLF in expected output
// fails every submission from a Linux-compiled binary.
function normalizeToLf(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

async function readManifest(problemId, version) {
  const p = path.join(versionDir(problemId, version), MANIFEST);
  try {
    return JSON.parse(await fsp.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function isMaterialized(problemId, version) {
  const manifest = await readManifest(problemId, version);
  return manifest != null && Array.isArray(manifest.cases);
}

async function materialize(problemId, version) {
  const target = versionDir(problemId, version);
  if (await isMaterialized(problemId, version)) return target;

  const lockKey = `cj:tc:lock:${problemId}:${version}`;
  const gotLock = await redis.set(lockKey, process.pid, "EX", LOCK_TTL_SECONDS, "NX");

  if (!gotLock) {
    // Another worker is materializing the same version; wait for it.
    const deadline = Date.now() + LOCK_TTL_SECONDS * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (await isMaterialized(problemId, version)) return target;
    }
    throw new Error(
      `Timed out waiting for testcase materialization of ${problemId} v${version}`,
    );
  }

  try {
    if (await isMaterialized(problemId, version)) return target;

    const cases = await platformSource.fetchTestcases(problemId);
    if (!cases.length) {
      throw new Error(`No testcases found for problem ${problemId}`);
    }

    await ensureDir(config.paths.tmp);
    const staging = await makeStagingDir(
      config.paths.tmp,
      `tc-${problemId}-v${version}`,
    );

    const manifestCases = [];
    for (const tc of cases) {
      const inName = `${pad(tc.index + 1)}.in`;
      const outName = `${pad(tc.index + 1)}.out`;
      const inData = normalizeToLf(tc.input);
      const outData = normalizeToLf(tc.output);

      await fsp.writeFile(path.join(staging, inName), inData, "utf8");
      await fsp.writeFile(path.join(staging, outName), outData, "utf8");

      manifestCases.push({
        index: tc.index,
        input_file: inName,
        output_file: outName,
        input_sha256: sha256(inData),
        output_sha256: sha256(outData),
        is_public: tc.isPublic,
      });
    }

    const manifest = {
      problem_id: String(problemId),
      version: Number(version),
      case_count: manifestCases.length,
      created_at: new Date().toISOString(),
      cases: manifestCases,
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    // Manifest written last: its presence is what marks the dir complete.
    await fsp.writeFile(path.join(staging, MANIFEST), manifestJson, "utf8");

    await ensureDir(path.dirname(target));
    const published = await publishDirAtomic(staging, target);
    if (!published) log.info("version published concurrently", { problemId, version });

    const bytes = await dirSize(target);
    await query(
      `INSERT INTO testcase_sets
         (problem_id, version, node_id, case_count, total_bytes, manifest_sha256)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (problem_id, version, node_id) DO UPDATE
         SET case_count = EXCLUDED.case_count,
             total_bytes = EXCLUDED.total_bytes,
             manifest_sha256 = EXCLUDED.manifest_sha256,
             materialized_at = now()`,
      [
        String(problemId),
        Number(version),
        config.worker.nodeId,
        manifest.case_count,
        bytes,
        sha256(manifestJson),
      ],
    ).catch((e) => log.warn("testcase_sets upsert failed", { err: e.message }));

    log.info("materialized testcases", {
      problemId,
      version,
      count: manifest.case_count,
      bytes,
    });
    return target;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

async function getManifest(problemId, version) {
  await materialize(problemId, version);
  const manifest = await readManifest(problemId, version);
  if (!manifest) {
    throw new Error(`Manifest missing for ${problemId} v${version}`);
  }
  return manifest;
}

async function getCaseCount(problemId, version) {
  return (await getManifest(problemId, version)).case_count;
}

async function readExpectedOutput(problemId, version, index) {
  const manifest = await getManifest(problemId, version);
  const c = manifest.cases[index];
  if (!c) throw new Error(`Testcase ${index} not found for ${problemId}`);
  return fsp.readFile(
    path.join(versionDir(problemId, version), c.output_file),
    "utf8",
  );
}

function inputFileName(manifest, index) {
  const c = manifest.cases[index];
  if (!c) throw new Error(`Testcase ${index} out of range`);
  return c.input_file;
}

async function close() {
  await redis.quit().catch(() => {});
  await platformSource.close();
}

module.exports = {
  versionDir,
  materialize,
  getManifest,
  getCaseCount,
  readExpectedOutput,
  inputFileName,
  isMaterialized,
  normalizeToLf,
  close,
};
