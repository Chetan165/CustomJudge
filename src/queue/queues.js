const { Queue } = require("bullmq");
const { connection } = require("./connection");
const config = require("../core/config");

// BullMQ forbids ':' in queue names; namespacing goes through the prefix.
const QUEUE_PREFIX = "cj";
const COMPILE_QUEUE = "compile";

// Node-scoped execute queue keeps a submission's binary and testcases on the
// node that compiled them. Blank NODE_ID = single shared queue.
function executeQueueName(nodeId = config.worker.nodeId) {
  return nodeId ? `execute-${nodeId}` : "execute";
}

const defaultJobOptions = {
  removeOnComplete: 1000,
  removeOnFail: 5000,
  attempts: 2,
  backoff: { type: "exponential", delay: 1000 },
};

// Queues connect lazily so the API can serve read-only routes without Redis.
let _compileQueue = null;
function getCompileQueue() {
  if (!_compileQueue) {
    _compileQueue = new Queue(COMPILE_QUEUE, {
      connection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions,
    });
  }
  return _compileQueue;
}

const executeQueues = new Map();

function getExecuteQueue(nodeId) {
  const name = executeQueueName(nodeId);
  if (!executeQueues.has(name)) {
    executeQueues.set(
      name,
      new Queue(name, { connection, prefix: QUEUE_PREFIX, defaultJobOptions }),
    );
  }
  return executeQueues.get(name);
}

module.exports = {
  QUEUE_PREFIX,
  COMPILE_QUEUE,
  executeQueueName,
  getCompileQueue,
  getExecuteQueue,
  defaultJobOptions,
};
