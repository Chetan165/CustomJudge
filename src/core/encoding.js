// Judge0 takes base64_encoded as a QUERY param, not a body field.
// Submits from the platform are plaintext; callbacks are base64.

function decodeField(value, isBase64) {
  if (value === null || value === undefined) return null;
  if (!isBase64) return String(value);
  return Buffer.from(String(value), "base64").toString("utf8");
}

function encodeField(value, isBase64) {
  if (value === null || value === undefined) return null;
  const s = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return isBase64 ? s.toString("base64") : s.toString("utf8");
}

function decodeSubmissionInput(body, isBase64) {
  return {
    ...body,
    source_code: decodeField(body.source_code, isBase64),
    stdin: decodeField(body.stdin, isBase64),
    expected_output: decodeField(body.expected_output, isBase64),
  };
}

function encodeSubmissionOutput(row, isBase64) {
  return {
    ...row,
    stdout: encodeField(row.stdout, isBase64),
    stderr: encodeField(row.stderr, isBase64),
    compile_output: encodeField(row.compile_output, isBase64),
    message: encodeField(row.message, isBase64),
  };
}

module.exports = {
  decodeField,
  encodeField,
  decodeSubmissionInput,
  encodeSubmissionOutput,
};
