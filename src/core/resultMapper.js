const { ID, statusForSignal } = require("./statuses");

// isolate meta status: TO=timeout, SG=killed by signal, RE=nonzero exit,
// XX=internal error.
function mapExecutionStatus(res, limits) {
  if (res.isolateStatus === "XX") return ID.INTERNAL_ERROR;

  if (res.isolateStatus === "TO" || res.killed) return ID.TIME_LIMIT_EXCEEDED;

  // isolate reports CPU time only for the process that ran; a solution can
  // exceed the limit and still exit cleanly if the kernel didn't preempt it.
  if (
    limits &&
    limits.cpu_time_limit != null &&
    res.time != null &&
    res.time > Number(limits.cpu_time_limit)
  ) {
    return ID.TIME_LIMIT_EXCEEDED;
  }

  if (res.exitSignal) return statusForSignal(Number(res.exitSignal));

  if (res.exitCode === 127) return ID.EXEC_FORMAT_ERROR;
  if (res.exitCode !== 0) return ID.RE_NZEC;

  return ID.ACCEPTED;
}

// Matches the platform's normalizeOutputOptimized so verdicts agree.
function normalizeOutput(value) {
  if (value == null) return "";
  const s = String(value).replace(/\r\n/g, "\n");
  const lines = s.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n").trim();
}

function compareOutput(actual, expected) {
  return normalizeOutput(actual) === normalizeOutput(expected);
}

module.exports = { mapExecutionStatus, normalizeOutput, compareOutput };
