const { LANGUAGES } = require("./judge0Languages");

// v1 optimizes C++ only; every other language_id proxies to real Judge0.
const Supported_languages = new Set([62, 54, 76, 105, 52, 53]);

// Per-language limits, mirroring the platform's Judge0Config/config.js.
const DEFAULT_LIMITS = {
  cpu_time_limit: 2,
  wall_time_limit: 10,
  memory_limit: 128000,
  stack_limit: 64000,
  max_processes: 30,
  max_file_size: 65536,
  enable_network: false,
};

const LANGUAGE_LIMIT_OVERRIDES = {
  54: { cpu_time_limit: 2, wall_time_limit: 8 },
  62: {
    cpu_time_limit: 3,
    wall_time_limit: 10,
    memory_limit: 512000,
    stack_limit: 128000,
    max_processes: 64,
    max_file_size: 131072,
  },
};

function isSupported(languageId) {
  return Supported_languages.has(Number(languageId));
}

function getLanguage(id) {
  return LANGUAGES.find((l) => l.id === Number(id)) || null;
}

function getLimits(languageId, overrides = {}) {
  const base = {
    ...DEFAULT_LIMITS,
  };

  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null && v !== "") {
      base[k] = v;
    }
  }

  Object.assign(base, LANGUAGE_LIMIT_OVERRIDES[Number(languageId)] || {});

  return base;
}

module.exports = {
  LANGUAGES,
  Supported_languages,
  DEFAULT_LIMITS,
  isSupported,
  getLanguage,
  getLimits,
};
