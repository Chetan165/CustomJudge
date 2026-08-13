const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function tmpName(target) {
  return `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

// Windows rejects rename-over-existing with EPERM/EACCES where POSIX replaces
// atomically. Retry briefly so the dev loop works off-Linux.
const RENAME_RACE_CODES = new Set(["EPERM", "EACCES"]);

async function renameWithRetry(from, to, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (!RENAME_RACE_CODES.has(err.code) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 5 + i * 5));
    }
  }
}

// rename(2) is atomic within a filesystem, so readers never see a partial file.
async function writeFileAtomic(target, data, mode) {
  await ensureDir(path.dirname(target));
  const tmp = tmpName(target);
  try {
    await fsp.writeFile(tmp, data, mode ? { mode } : undefined);
    if (mode) await fsp.chmod(tmp, mode);
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Publishes a fully-populated staging dir under its final name in one step.
// A rename failure onto an existing target means a peer already published it.
async function publishDirAtomic(stagingDir, target) {
  await ensureDir(path.dirname(target));
  try {
    await fsp.rename(stagingDir, target);
    return true;
  } catch (err) {
    const lostRace =
      err.code === "EEXIST" ||
      err.code === "ENOTEMPTY" ||
      (RENAME_RACE_CODES.has(err.code) && (await exists(target)));
    if (lostRace) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return false;
    }
    throw err;
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeStagingDir(tmpRoot, label) {
  const dir = path.join(
    tmpRoot,
    `${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      try {
        total += (await fsp.stat(p)).size;
      } catch {}
    }
  }
  return total;
}

module.exports = {
  ensureDir,
  writeFileAtomic,
  publishDirAtomic,
  makeStagingDir,
  exists,
  dirSize,
};
