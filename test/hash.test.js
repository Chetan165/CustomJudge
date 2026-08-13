const test = require("node:test");
const assert = require("node:assert");
const { compileCacheKey, shardedPath } = require("../src/core/hash");

const FLAGS = ["-std=c++17", "-O2"];

test("identical source and flags share a compile key", () => {
  const a = compileCacheKey("int main(){}", 54, FLAGS);
  const b = compileCacheKey("int main(){}", 54, FLAGS);
  assert.strictEqual(a, b);
});

test("source, language, and flags all affect the key", () => {
  const base = compileCacheKey("int main(){}", 54, FLAGS);
  assert.notStrictEqual(base, compileCacheKey("int main(){ }", 54, FLAGS));
  assert.notStrictEqual(base, compileCacheKey("int main(){}", 52, FLAGS));
  assert.notStrictEqual(
    base,
    compileCacheKey("int main(){}", 54, ["-std=c++20", "-O2"]),
  );
});

test("keys shard into two-char directories", () => {
  const key = compileCacheKey("int main(){}", 54, FLAGS);
  const [shard, rest] = shardedPath(key);
  assert.strictEqual(shard.length, 2);
  assert.strictEqual(shard + rest, key);
});
