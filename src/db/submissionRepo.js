const { query } = require("./pool");
const { ID } = require("../core/statuses");

const INSERT_COLUMNS = [
  "token",
  "language_id",
  "source_code",
  "stdin",
  "expected_output",
  "problem_id",
  "testcase_version",
  "testcase_index",
  "submission_group",
  "cpu_time_limit",
  "wall_time_limit",
  "memory_limit",
  "stack_limit",
  "max_processes",
  "max_file_size",
  "callback_url",
  "compile_key",
  "status_id",
  "is_proxied",
  "upstream_token",
];

async function createMany(rows) {
  if (!rows.length) return [];
  const values = [];
  const tuples = rows.map((row, i) => {
    const base = i * INSERT_COLUMNS.length;
    const placeholders = INSERT_COLUMNS.map((_, j) => `$${base + j + 1}`);
    for (const col of INSERT_COLUMNS) {
      values.push(row[col] === undefined ? null : row[col]);
    }
    return `(${placeholders.join(",")})`;
  });

  const sql = `INSERT INTO submissions (${INSERT_COLUMNS.join(",")})
               VALUES ${tuples.join(",")}
               RETURNING token`;
  const res = await query(sql, values);
  return res.rows.map((r) => r.token);
}

async function findByToken(token) {
  const res = await query(`SELECT * FROM submissions WHERE token = $1`, [token]);
  return res.rows[0] || null;
}

async function findByTokens(tokens) {
  if (!tokens.length) return [];
  const res = await query(`SELECT * FROM submissions WHERE token = ANY($1)`, [
    tokens,
  ]);
  const byToken = new Map(res.rows.map((r) => [r.token, r]));
  // Preserve caller's token order; the platform maps results positionally.
  return tokens.map((t) => byToken.get(t) || null);
}

async function findGroup(groupId) {
  const res = await query(
    `SELECT * FROM submissions
      WHERE submission_group = $1
      ORDER BY testcase_index ASC`,
    [groupId],
  );
  return res.rows;
}

async function setStatus(token, statusId) {
  await query(`UPDATE submissions SET status_id = $2 WHERE token = $1`, [
    token,
    statusId,
  ]);
}

async function setGroupStatus(groupId, statusId) {
  await query(
    `UPDATE submissions SET status_id = $2 WHERE submission_group = $1`,
    [groupId, statusId],
  );
}

async function finalize(token, result) {
  const res = await query(
    `UPDATE submissions SET
       status_id = $2,
       stdout = $3,
       stderr = $4,
       compile_output = $5,
       message = $6,
       exit_code = $7,
       exit_signal = $8,
       time = $9,
       wall_time = $10,
       memory = $11,
       finished_at = now()
     WHERE token = $1
     RETURNING *`,
    [
      token,
      result.status_id,
      result.stdout ?? null,
      result.stderr ?? null,
      result.compile_output ?? null,
      result.message ?? null,
      result.exit_code ?? null,
      result.exit_signal ?? null,
      result.time ?? null,
      result.wall_time ?? null,
      result.memory ?? null,
    ],
  );
  return res.rows[0] || null;
}

// Compile errors must be written to every token in the group: the platform
// counts N callbacks before it will run evaluation.
async function finalizeGroup(groupId, result) {
  const res = await query(
    `UPDATE submissions SET
       status_id = $2,
       compile_output = $3,
       message = $4,
       stdout = NULL,
       stderr = NULL,
       time = NULL,
       memory = NULL,
       finished_at = now()
     WHERE submission_group = $1
     RETURNING *`,
    [groupId, result.status_id, result.compile_output ?? null, result.message ?? null],
  );
  return res.rows;
}

async function setCompileKey(groupId, compileKey) {
  await query(
    `UPDATE submissions SET compile_key = $2 WHERE submission_group = $1`,
    [groupId, compileKey],
  );
}

async function countUnfinished() {
  const res = await query(
    `SELECT
       count(*) FILTER (WHERE status_id = $1) AS in_queue,
       count(*) FILTER (WHERE status_id = $2) AS processing
     FROM submissions`,
    [ID.IN_QUEUE, ID.PROCESSING],
  );
  return res.rows[0];
}

module.exports = {
  createMany,
  findByToken,
  findByTokens,
  findGroup,
  setStatus,
  setGroupStatus,
  finalize,
  finalizeGroup,
  setCompileKey,
  countUnfinished,
};
