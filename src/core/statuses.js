// Judge0 CE status table. IDs must match exactly for drop-in compatibility.
const STATUSES = [
  { id: 1, description: "In Queue" },
  { id: 2, description: "Processing" },
  { id: 3, description: "Accepted" },
  { id: 4, description: "Wrong Answer" },
  { id: 5, description: "Time Limit Exceeded" },
  { id: 6, description: "Compilation Error" },
  { id: 7, description: "Runtime Error (SIGSEGV)" },
  { id: 8, description: "Runtime Error (SIGXFSZ)" },
  { id: 9, description: "Runtime Error (SIGFPE)" },
  { id: 10, description: "Runtime Error (SIGABRT)" },
  { id: 11, description: "Runtime Error (NZEC)" },
  { id: 12, description: "Runtime Error (Other)" },
  { id: 13, description: "Internal Error" },
  { id: 14, description: "Exec Format Error" },
];

const ID = {
  IN_QUEUE: 1,
  PROCESSING: 2,
  ACCEPTED: 3,
  WRONG_ANSWER: 4,
  TIME_LIMIT_EXCEEDED: 5,
  COMPILATION_ERROR: 6,
  RE_SIGSEGV: 7,
  RE_SIGXFSZ: 8,
  RE_SIGFPE: 9,
  RE_SIGABRT: 10,
  RE_NZEC: 11,
  RE_OTHER: 12,
  INTERNAL_ERROR: 13,
  EXEC_FORMAT_ERROR: 14,
};

const byId = new Map(STATUSES.map((s) => [s.id, s]));

function statusById(id) {
  return byId.get(id) || { id: 13, description: "Internal Error" };
}

const SIGNAL_TO_STATUS = {
  4: ID.RE_OTHER, // SIGILL
  6: ID.RE_SIGABRT,
  8: ID.RE_SIGFPE,
  11: ID.RE_SIGSEGV,
  25: ID.RE_SIGXFSZ,
};

function statusForSignal(signal) {
  return SIGNAL_TO_STATUS[signal] || ID.RE_OTHER;
}

module.exports = { STATUSES, ID, statusById, statusForSignal };
