const express = require("express");
const submissionsRouter = require("./routes/submissions");
const metaRouter = require("./routes/meta");

function createApp() {
  const app = express();
  app.use(express.json({ limit: "20mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(metaRouter);
  app.use(submissionsRouter);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  app.use((err, _req, res, _next) => {
    console.error("[api]", err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

module.exports = { createApp };
