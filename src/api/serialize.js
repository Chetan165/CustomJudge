const { statusById } = require("../core/statuses");
const { encodeField } = require("../core/encoding");
const { getLanguage } = require("../core/languages");

const DEFAULT_FIELDS = [
  "token",
  "stdout",
  "stderr",
  "compile_output",
  "message",
  "exit_code",
  "status",
  "time",
  "memory",
];

function serializeSubmission(row, { base64 = false, fields = null } = {}) {
  if (!row) return null;

  const full = {
    token: row.token,
    stdout: encodeField(row.stdout, base64),
    stderr: encodeField(row.stderr, base64),
    compile_output: encodeField(row.compile_output, base64),
    message: encodeField(row.message, base64),
    exit_code: row.exit_code ?? null,
    exit_signal: row.exit_signal ?? null,
    status: statusById(row.status_id),
    status_id: row.status_id,
    time: row.time != null ? String(Number(row.time).toFixed(3)) : null,
    wall_time: row.wall_time != null ? String(Number(row.wall_time).toFixed(3)) : null,
    memory: row.memory != null ? Number(row.memory) : null,
    language_id: row.language_id,
    language: getLanguage(row.language_id),
    source_code: encodeField(row.source_code, base64),
    stdin: encodeField(row.stdin, base64),
    expected_output: encodeField(row.expected_output, base64),
    cpu_time_limit: row.cpu_time_limit != null ? String(row.cpu_time_limit) : null,
    wall_time_limit: row.wall_time_limit != null ? String(row.wall_time_limit) : null,
    memory_limit: row.memory_limit ?? null,
    stack_limit: row.stack_limit ?? null,
    max_processes_and_or_threads: row.max_processes ?? null,
    max_file_size: row.max_file_size ?? null,
    callback_url: row.callback_url ?? null,
    created_at: row.created_at ?? null,
    finished_at: row.finished_at ?? null,
  };

  const selected = fields && fields.length ? fields : DEFAULT_FIELDS;
  const out = {};
  for (const f of selected) {
    if (f in full) out[f] = full[f];
  }
  return out;
}

function parseFields(fieldsParam) {
  if (!fieldsParam) return null;
  return String(fieldsParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { serializeSubmission, parseFields, DEFAULT_FIELDS };
