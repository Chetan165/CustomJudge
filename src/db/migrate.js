const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

async function main() {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    process.stdout.write(`applying ${f} ... `);
    await pool.query(sql);
    console.log("ok");
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
