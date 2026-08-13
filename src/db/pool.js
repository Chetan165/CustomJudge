const { Pool } = require("pg");
const config = require("../core/config");

const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  database: config.pg.database,
  user: config.pg.user,
  password: config.pg.password,
  max: 10,
});

pool.on("error", (err) => {
  console.error("[pg] idle client error", err.message);
});

module.exports = { pool, query: (t, p) => pool.query(t, p) };
