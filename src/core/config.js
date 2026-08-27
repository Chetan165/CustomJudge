const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : v === "true");

const DATA_ROOT = process.env.DATA_ROOT || "/var/lib/customjudge";

const config = {
  port: num(process.env.PORT, 2358),
  env: process.env.NODE_ENV || "development",

  judge0Fallback: {
    url: process.env.JUDGE0_FALLBACK_URL || "",
    authToken: process.env.JUDGE0_FALLBACK_AUTH_TOKEN || "",
  },

  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: num(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  pg: {
    host: process.env.PGHOST || "127.0.0.1",
    port: num(process.env.PGPORT, 5433),
    database: process.env.PGDATABASE || "customjudge",
    user: process.env.PGUSER || "customjudge",
    password: process.env.PGPASSWORD || "customjudge",
  },

  platformDatabaseUrl: process.env.PLATFORM_DATABASE_URL || "",

  paths: {
    dataRoot: DATA_ROOT,
    problems: path.join(DATA_ROOT, "problems"),
    binaries: path.join(DATA_ROOT, "binaries"),
    tmp: path.join(DATA_ROOT, "tmp"),
  },

  sandbox: {
    driver: process.env.SANDBOX_DRIVER || "mock",
    isolateBin: process.env.ISOLATE_BIN || "/usr/local/bin/isolate",
    boxIdMin: num(process.env.BOX_ID_MIN, 0),
    boxIdMax: num(process.env.BOX_ID_MAX, 99),
  },

  worker: {
    nodeId: process.env.NODE_ID || "",
    compileConcurrency: num(process.env.COMPILE_CONCURRENCY, 2),
    executeConcurrency: num(process.env.EXECUTE_CONCURRENCY, 4),
  },

  callback: {
    base64: bool(process.env.CALLBACK_BASE64, true),
    method: (process.env.CALLBACK_METHOD || "POST").toUpperCase(),
    maxAttempts: num(process.env.CALLBACK_MAX_ATTEMPTS, 5),
    authHeader: process.env.CALLBACK_AUTH_HEADER || "",
    authToken: process.env.CALLBACK_AUTH_TOKEN || "",
  },

  compile: {
    binaryCacheMaxBytes: num(process.env.BINARY_CACHE_MAX_BYTES, 2 * 1024 ** 3),
    compiler: process.env.CXX_COMPILER || "/usr/bin/g++",
    JavaHome: process.env.JavaHome || "/usr/lib/jvm/java-11-openjdk-amd64",
    JavaCompiler:
      `${process.env.JavaHome}/bin/javac` ||
      "/usr/lib/jvm/java-11-openjdk-amd64/usr/bin/javac",
    JavaExecutable:
      `${process.env.JavaHome}/bin/java` ||
      "/usr/lib/jvm/java-11-openjdk-amd64/usr/bin/java",
    JavaFlags: process.env.JAVA_FLAGS || "-encoding=UTF-8",
    JavaEtc: process.env.JavaEtc || "/etc/java-11-openjdk",
    JavaJar:
      `${process.env.JavaHome}/bin/jar` ||
      "/usr/lib/jvm/java-11-openjdk-amd64/bin/jar",
    flags: (process.env.CXX_FLAGS || "-std=c++17 -O2 -w -lm -static -s")
      .split(/\s+/)
      .filter(Boolean),
  },
};

module.exports = config;
