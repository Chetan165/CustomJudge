const { Pool } = require("pg");
const config = require("../core/config");

let pool = null;

function getPool() {
  if (!config.platformDatabaseUrl) {
    throw new Error("PLATFORM_DATABASE_URL is not configured");
  }
  if (!pool) {
    pool = new Pool({ connectionString: config.platformDatabaseUrl, max: 4 });
    pool.on("error", (e) => console.error("[platform-pg]", e.message));
  }
  return pool;
}

// Explicit ORDER BY: the platform maps callbacks positionally by index, so a
// stable testcase order is a correctness requirement, not a nicety.
async function fetchTestcases(problemId) {
  const res = await getPool().query(
    `SELECT id, input, output, "isPublic"
       FROM "TestCase"
      WHERE "problemId" = $1
      ORDER BY id ASC`,
    [problemId],
  );
  return res.rows.map((r, i) => ({
    index: i,
    id: r.id,
    input: r.input ?? "",
    output: r.output ?? "",
    isPublic: r.isPublic === true,
  }));
}

async function close() {
  if (pool) await pool.end().catch(() => {});
  pool = null;
}

module.exports = { fetchTestcases, close };
