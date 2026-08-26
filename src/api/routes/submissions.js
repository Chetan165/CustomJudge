const express = require("express");
const router = express.Router();

const config = require("../../core/config");
const { ID } = require("../../core/statuses");
const { isSupported } = require("../../core/languages");
const { decodeSubmissionInput } = require("../../core/encoding");
const submissionRepo = require("../../db/submissionRepo");
const submissionService = require("../submissionService");
const { serializeSubmission, parseFields } = require("../serialize");
const { waitFor } = require("../waitRegistry");
const proxy = require("../judge0Proxy");

const WAIT_TIMEOUT_MS = 20000;
const isBase64 = (req) => req.query.base64_encoded === "true";
const isFinished = (statusId) => Number(statusId) >= ID.ACCEPTED;

function handleError(res, err) {
  if (err.payload) return res.status(err.statusCode || 422).json(err.payload);
  console.error("[submissions]", err);
  return res.status(500).json({ error: err.message });
}

// POST /submissions
router.post("/submissions", async (req, res) => {
  if (!isSupported(req.body?.language_id)) return proxy.forward(req, res);

  try {
    const body = decodeSubmissionInput(req.body, isBase64(req));
    const { token } = await submissionService.createSingle(body);

    if (req.query.wait === "true") {
      await waitFor(token, WAIT_TIMEOUT_MS);
      const row = await submissionRepo.findByToken(token);
      return res.status(201).json(
        serializeSubmission(row, {
          base64: isBase64(req),
          fields: parseFields(req.query.fields),
        }),
      );
    }
    return res.status(201).json({ token });
  } catch (err) {
    return handleError(res, err);
  }
});

// POST /submissions/batch
router.post("/submissions/batch", async (req, res) => {
  const list = req.body?.submissions;
  if (!Array.isArray(list) || !list.length) {
    return res
      .status(400)
      .json({ error: "submissions must be a non-empty array" });
  }
  // A batch is proxied only if no entry is C++; mixed batches aren't split
  // because Judge0 requires token order to mirror input order.
  if (!list.some((s) => isSupported(s?.language_id)))
    return res.status(422).json({ error: "No supported languages found" });
  if (!list.every((s) => isSupported(s?.language_id))) {
    return res.status(422).json({
      error: "mixed-language batches are not supported; split by language",
    });
  }

  try {
    const b64 = isBase64(req);
    const decoded = list.map((s) => decodeSubmissionInput(s, b64));
    const results = await submissionService.createBatch(decoded);
    console.log("Batch submission results:", results);
    return res.status(201).json(results);
  } catch (err) {
    return handleError(res, err);
  }
});

// POST /submissions/problem  (compile-once, testcases resolved judge-side)
router.post("/submissions/problem", async (req, res) => {
  try {
    const body = decodeSubmissionInput(req.body, isBase64(req));
    const result = await submissionService.createProblemSubmission(body);
    return res.status(201).json(result);
  } catch (err) {
    return handleError(res, err);
  }
});

// GET /submissions/batch?tokens=
router.get("/submissions/batch", async (req, res) => {
  const tokens = String(req.query.tokens || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length)
    return res.status(400).json({ error: "tokens is required" });

  try {
    const rows = await submissionRepo.findByTokens(tokens);
    const fields = parseFields(req.query.fields);
    const b64 = isBase64(req);
    const missing = rows.map((r, i) => (r ? null : tokens[i])).filter(Boolean);

    if (missing.length && config.judge0Fallback.url) {
      return proxy.forward(req, res);
    }

    return res.json({
      submissions: rows.map((r) =>
        r ? serializeSubmission(r, { base64: b64, fields }) : null,
      ),
    });
  } catch (err) {
    return handleError(res, err);
  }
});

// GET /submissions/:token
router.get("/submissions/:token", async (req, res) => {
  try {
    const row = await submissionRepo.findByToken(req.params.token);
    if (!row) {
      if (config.judge0Fallback.url) return proxy.forward(req, res);
      return res.status(404).json({ error: "Submission not found" });
    }

    if (req.query.wait === "true" && !isFinished(row.status_id)) {
      await waitFor(row.token, WAIT_TIMEOUT_MS);
      const fresh = await submissionRepo.findByToken(req.params.token);
      return res.json(
        serializeSubmission(fresh, {
          base64: isBase64(req),
          fields: parseFields(req.query.fields),
        }),
      );
    }

    return res.json(
      serializeSubmission(row, {
        base64: isBase64(req),
        fields: parseFields(req.query.fields),
      }),
    );
  } catch (err) {
    return handleError(res, err);
  }
});

module.exports = router;
