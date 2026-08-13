const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const {
  writeFileAtomic,
  publishDirAtomic,
  makeStagingDir,
  exists,
  dirSize,
} = require("../src/core/atomicFs");

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "cj-test-"));
}

test("writeFileAtomic creates parents and leaves no temp files", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "a", "b", "file.bin");
  await writeFileAtomic(target, "hello");

  assert.strictEqual(await fsp.readFile(target, "utf8"), "hello");
  const leftovers = (await fsp.readdir(path.dirname(target))).filter((f) =>
    f.includes(".tmp-"),
  );
  assert.strictEqual(leftovers.length, 0);
  await fsp.rm(root, { recursive: true, force: true });
});

test("concurrent atomic writes never yield a partial read", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "concurrent.txt");
  const payloads = Array.from({ length: 20 }, (_, i) => "x".repeat(1000 + i));

  await Promise.all(payloads.map((p) => writeFileAtomic(target, p)));

  const final = await fsp.readFile(target, "utf8");
  assert.ok(payloads.includes(final), "final content must be one whole write");
  await fsp.rm(root, { recursive: true, force: true });
});

test("publishDirAtomic makes a staged dir visible in one step", async () => {
  const root = await tmpRoot();
  const staging = await makeStagingDir(root, "stage");
  await fsp.writeFile(path.join(staging, "001.in"), "1\n");
  await fsp.writeFile(path.join(staging, "manifest.json"), "{}");

  const target = path.join(root, "problems", "p1", "v1");
  assert.strictEqual(await publishDirAtomic(staging, target), true);
  assert.ok(await exists(path.join(target, "manifest.json")));
  await fsp.rm(root, { recursive: true, force: true });
});

test("losing a publish race discards the staged dir instead of corrupting", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "v1");
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(path.join(target, "winner.txt"), "first");

  const staging = await makeStagingDir(root, "stage");
  await fsp.writeFile(path.join(staging, "loser.txt"), "second");

  const published = await publishDirAtomic(staging, target);
  assert.strictEqual(published, false);
  assert.ok(await exists(path.join(target, "winner.txt")));
  assert.strictEqual(await exists(staging), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test("dirSize sums nested files", async () => {
  const root = await tmpRoot();
  await fsp.mkdir(path.join(root, "sub"), { recursive: true });
  await fsp.writeFile(path.join(root, "a.txt"), "12345");
  await fsp.writeFile(path.join(root, "sub", "b.txt"), "123");
  assert.strictEqual(await dirSize(root), 8);
  await fsp.rm(root, { recursive: true, force: true });
});
