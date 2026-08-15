# CustomJudge Deployment

Host-native compile/execute workers (isolate needs a real cgroup v2 subtree —
never run these in containers). Postgres/Redis/API run via docker compose.

## Steps

1. **Install prerequisites** (Debian minimal images may lack `useradd`)

   ```bash
   sudo apt-get update
   sudo apt-get install -y passwd
   ```

2. **Provision the host** (builds isolate, sets up cgroup/user, smoke test)

   ```bash
   sudo bash infra/provision/provision-worker.sh
   ```

3. **Configure `.env`**

   ```
   SANDBOX_DRIVER=isolate
   ISOLATE_BIN=/usr/local/bin/isolate
   DATA_ROOT=/var/lib/customjudge      # lowercase — must match compose mount exactly
   CXX_COMPILER=/usr/bin/g++           # absolute path
   CALLBACK_METHOD=PUT                 # must match platform's callback route method
   COMPILE_CONCURRENCY=2               # per-process concurrent compile jobs
   EXECUTE_CONCURRENCY=4               # per-process concurrent execute jobs
   ```

4. **Start Postgres/Redis**

   ```bash
   cd infra && sudo docker compose up -d
   redis-cli -h 127.0.0.1 -p 6379 ping   # expect PONG
   cd ..
   ```

5. **Install Node.js 20 LTS** (if not already present)

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node --version && npm --version
   ```

6. **Install deps and run DB migrations**

   ```bash
   npm install
   node src/db/migrate.js
   ```

7. **Start the compile/execute workers — choose ONE supervisor, never both**

   **Option A — pm2** (recommended; supports easy concurrency scaling via `-i`)

   ```bash
   pm2 start src/workers/compileWorker.js --name compile-worker -i 1
   pm2 start src/workers/executeWorker.js --name execute-worker -i 1
   pm2 save
   pm2 startup   # run the printed command once, so pm2 survives reboot
   ```

   **Option B — systemd**

   ```bash
   sudo cp infra/systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now customjudge-compile.service customjudge-execute.service
   ```

   Total effective concurrency = `(pm2 -i N) × (COMPILE/EXECUTE_CONCURRENCY in .env)`.
   systemd runs one process (no `-i` multiplier), so its effective concurrency
   equals the `.env` value alone. Never run both supervisors for the same
   worker — they'll both consume the same Redis queue and silently double
   your effective concurrency.

8. **Sanity test**
   ```bash
   curl -sS -X POST "http://localhost:2358/submissions?base64_encoded=false&wait=true" \
     -H 'Content-Type: application/json' \
     -d '{"source_code":"#include <iostream>\nint main(){ std::cout << 12 << std::endl; return 0; }","language_id":54,"stdin":""}'
   ```
   Expect `stdout: "12\n"`, non-null `time`/`memory`.

---

## Benchmarking against Judge0 (fair-comparison config)

CustomJudge separates compile/execute into independent worker pools (asymmetric
by design); Judge0 uses one symmetric worker pool that does both per job. For a
controlled comparison, match **total concurrent slots**, not per-role counts:

- On N CPU cores, pick a total slot budget (e.g. `N`, `1.5N`, `2N`).
- Judge0: set `COUNT` in `judge0.conf` × `--scale worker=K` = total budget.
- CustomJudge: split the same total across compile/execute symmetrically
  (e.g. total 6 → compile 2, execute 4 via `.env` defaults with `-i 1`;
  or compile 3, execute 3 via `-i 3`/`-i 1` split) for the "fair" baseline.
- Report a second, separately labeled run with an execute-skewed ratio
  (compile gets fewer slots than execute, matching real workload shape —
  one compile feeds many testcase executes) as a "tuned" result, not mixed
  into the fair baseline.
- Force fresh compilation on every submission in both systems
  (`forceUniqueCompile: true` equivalent) — Judge0 has no compile cache by
  default, so a reused source in a batch is not equivalent across systems
  if customJudge's cache is left enabled.
- State N (submission count), total slots, and CPU core count explicitly
  in the report for every number cited.

---

## Fixes for specific errors

**`useradd: command not found`**
`/usr/sbin` missing from `PATH`, or `passwd` package not installed.

```bash
sudo apt-get install -y passwd
export PATH=$PATH:/usr/sbin:/sbin
```

**`isolate-check-environment reported problems`**
Script hides the reason with `--quiet`. Run bare to see it:

```bash
isolate-check-environment
```

Common fixes:

```bash
echo off   | sudo tee /sys/devices/system/cpu/smt/control
echo 0     | sudo tee /proc/sys/kernel/randomize_va_space
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/defrag
echo 0     | sudo tee /sys/kernel/mm/transparent_hugepage/khugepaged/defrag
echo core  | sudo tee /proc/sys/kernel/core_pattern
sudo swapoff -a   # if "swap enabled" CAUTION appears
```

Use `| sudo tee`, not `sudo echo ... > file` (redirect runs in your
unprivileged shell even under `sudo`, fails silently).

**`execve("g++"): No such file or directory`**
isolate execs directly, no shell/`$PATH` lookup. `CXX_COMPILER` in `.env`
must be an absolute path (`/usr/bin/g++`), not `g++`.

**`ENOENT` on binary path / stale compile cache after config change**
`DATA_ROOT` case mismatch, or cache pointing at an old path/driver. Clear it:

```bash
sudo docker compose exec postgres psql -U customjudge -d customjudge -c "TRUNCATE compile_cache;"
rm -rf "$DATA_ROOT"/binaries/*
```

**`Invalid directory rule '...':Unknown option 'ro'` (isolate execute silently fails)**
Read-only is isolate's default — never append `:ro` to `--dir`, only `:rw`
when needed.

**systemd: `Failed to load environment files: No such file or directory` / result `resources`**
Unit files hardcode `WorkingDirectory=/opt/customjudge`. Point at your real
repo path:

```bash
sudo sed -i 's#/opt/customjudge#<YOUR_REPO_PATH>#g' /etc/systemd/system/customjudge-*.service
sudo systemctl daemon-reload
sudo systemctl restart customjudge-compile.service customjudge-execute.service
```

Or symlink once so re-copying unit files never breaks it:
`sudo ln -sf <YOUR_REPO_PATH> /opt/customjudge`

**systemd: `status=203/EXEC`**
`ExecStart=/usr/bin/node ...` but Node isn't at that path (or isn't installed).

```bash
which node
sudo sed -i "s#/usr/bin/node#$(which node)#g" /etc/systemd/system/customjudge-*.service
sudo systemctl daemon-reload && sudo systemctl restart customjudge-compile.service customjudge-execute.service
```

**`npm: command not found` after installing Node**

```bash
sudo apt-get install -y npm
# or, for a clean Node 20 LTS + matching npm:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**`relation "submissions" does not exist`**
Migrations never ran on this DB:

```bash
node src/db/migrate.js
```

**Callback 404s from platform**
`CALLBACK_METHOD` in `.env` must match the platform route's HTTP method
exactly (`PUT` vs `POST`), and `callback_url`'s path must match the mounted
route path exactly (including any `/api` prefix).

**`ECONNREFUSED 127.0.0.1:6379` in worker logs**
Compose stack not up: `cd infra && sudo docker compose up -d`

**Node `fetch failed` even though `curl localhost:PORT` works (client side)**
Node's `fetch` can resolve `localhost` to IPv6 first while the API is
IPv4-only. Use `127.0.0.1` explicitly instead of `localhost` in any config
pointing at the judge.

**Duplicate/competing worker processes (pm2 + systemd both running)**
Both consuming the same Redis queue causes silently doubled concurrency and
confusing intermittent failures (stale env in one process, jobs racing
between consumers). Check which is running:

```bash
ps aux | grep -E "compileWorker|executeWorker"
pm2 list
systemctl status customjudge-compile.service customjudge-execute.service --no-pager
```

Stop whichever supervisor you're not using:

```bash
pm2 delete compileWorker executeWorker         # if standardizing on systemd
# or
sudo systemctl disable --now customjudge-compile.service customjudge-execute.service   # if standardizing on pm2
```
