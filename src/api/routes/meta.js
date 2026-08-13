const os = require("os");
const express = require("express");
const router = express.Router();

const { LANGUAGES, getLanguage } = require("../../core/languages");
const { STATUSES } = require("../../core/statuses");
const config = require("../../core/config");
const submissionRepo = require("../../db/submissionRepo");

router.get("/languages", (_req, res) => res.json(LANGUAGES));

router.get("/languages/:id", (req, res) => {
  const lang = getLanguage(req.params.id);
  if (!lang) return res.status(404).json({ error: "Language not found" });
  return res.json({ ...lang, is_archived: false });
});

router.get("/statuses", (_req, res) => res.json(STATUSES));

router.get("/about", (_req, res) =>
  res.json({
    version: require("../../../package.json").version,
    homepage: "https://github.com/ioi/isolate",
    source_code: "",
    maintainer: "customJudge",
  }),
);

router.get("/system_info", async (_req, res) => {
  let queue = { in_queue: null, processing: null };
  try {
    queue = await submissionRepo.countUnfinished();
  } catch {}

  res.json({
    Architecture: process.arch,
    "CPU(s)": String(os.cpus().length),
    "Model name": os.cpus()[0]?.model ?? "unknown",
    "Operating system": `${os.type()} ${os.release()}`,
    Mem: `${Math.round(os.totalmem() / 1024 / 1024)} MB`,
    sandbox_driver: config.sandbox.driver,
    node_id: config.worker.nodeId || "default",
    queue,
  });
});

router.get("/workers", async (_req, res) => {
  const { executeQueueName } = require("../../queue/queues");
  res.json([
    {
      queue: executeQueueName(),
      size: null,
      available: null,
      idle: null,
      working: null,
    },
  ]);
});

module.exports = router;
