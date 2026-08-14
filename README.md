# CustomJudge Deployment Guide

Host-native compile/execute workers (isolate needs a real cgroup v2 subtree —
never run these in containers). Postgres/Redis/API run via docker compose.

## 1. Prerequisites

- Ubuntu 22.04/24.04, kernel 5.19+, cgroup v2 (`stat -fc %T /sys/fs/cgroup` → `cgroup2fs`)
- Root/sudo access

## 2. Provision the host

```bash
sudo bash infra/provision/provision-worker.sh
```

Builds isolate from upstream, creates the `isolate` user + subuid/subgid maps,
enables `isolate.service`, creates `$DATA_ROOT`, and runs a compile+run smoke
test. **This must fully pass** (ending in "Worker host provisioned
successfully") before continuing.

### If `isolate-check-environment` fails

The script runs it with `--quiet`, hiding the actual reason. Run it bare to see specifics:

```bash
isolate-check-environment
```

Common FAILs and fixes (none persist across reboot — add to a boot script if you'll reboot):

```bash
echo off   | sudo tee /sys/devices/system/cpu/smt/control
echo 0     | sudo tee /proc/sys/kernel/randomize_va_space
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/defrag
echo 0     | sudo tee /sys/kernel/mm/transparent_hugepage/khugepaged/defrag
echo core  | sudo tee /proc/sys/kernel/core_pattern
```

**Use `| sudo tee`, not `sudo echo ... > file`** — the redirect happens in your
(unprivileged) shell even with `sudo` on the command, so it silently fails
with `Permission denied`.

Re-run `isolate-check-environment` until all PASS, then re-run
`provision-worker.sh`.

## 3. `.env` — critical settings

```dotenv
SANDBOX_DRIVER=isolate          # not "mock" — mock has zero real isolation,
                                 # inaccurate timing, never use for real judging
ISOLATE_BIN=/usr/local/bin/isolate
BOX_ID_MIN=0
BOX_ID_MAX=99                   # ceiling on concurrent isolate sandboxes

DATA_ROOT=/var/lib/customjudge  # all lowercase — MUST exactly match
CXX_COMPILER=/usr/bin/g++       # ABSOLUTE path. isolate execs directly
                                 # (no shell/$PATH lookup) — a bare "g++"
                                 # fails with execve(): No such file or directory

CALLBACK_METHOD=PUT             # must match the platform's route method exactly
```

### `DATA_ROOT` — case sensitivity + compose mount

Linux paths are case-sensitive. `DATA_ROOT` must be **identical, lowercase,
on both sides** of `infra/docker-compose.yml`'s bind mount:

```yaml
volumes:
  - /var/lib/customjudge:/var/lib/customjudge
```

If `DATA_ROOT` in `.env` doesn't match this exactly (e.g. `/var/lib/CustomJudge`),
binaries get written outside the container's visibility, `compile_cache`
rows point at paths that silently diverge from where files actually are, and
you get stale-cache/`ENOENT` failures that look unrelated to the real cause.

### `CALLBACK_METHOD` must match the platform's route

The judge calls back via `config.callback.method` (`.env` → default `PUT` in
`core/config.js`). Your platform's callback route must use the **same verb**
(`router.put(...)` vs `router.post(...)`) or every callback 404s. Also verify
the **path** matches exactly what's stored in `callback_url` on submission
(including any `/api` prefix from how the router is mounted, and any
`judge0` vs `judge` naming differences).

## 4. Systemd services

```bash
sudo cp infra/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now customjudge-compile.service customjudge-execute.service
```

If a unit fails with **"Failed to load environment files: No such file or
directory"** / result `resources` — the unit's `WorkingDirectory`/
`EnvironmentFile` point at `/opt/customjudge`, which likely doesn't exist.
Either symlink it or edit the units:

```bash
sudo ln -s /home/ubuntu/CustomJudge /opt/customjudge
# or:
sudo sed -i 's#/opt/customjudge#/home/ubuntu/CustomJudge#g' /etc/systemd/system/customjudge-*.service
sudo systemctl daemon-reload
```

## 5. Redis/Postgres via compose

```bash
cd infra && sudo docker compose up -d
redis-cli -h 127.0.0.1 -p 6379 ping   # expect PONG
```

`ECONNREFUSED 127.0.0.1:6379` in worker logs = compose stack isn't up.

## 6. isolate `--dir` syntax gotcha

Isolate's read-only mount is the **default** — do not append `:ro`. Only
append `:rw` when write access is needed. Appending `:ro` throws
`Invalid directory rule ...: Unknown option 'ro'` and every execute silently
fails with empty `meta`/`stdout` (looks like a hang/no-op, not an error,
unless you inspect `isolateStderr`).

```js
// wrong:
args.push(`--dir=${m.inside}=${m.outside}:${m.rw ? "rw" : "ro"}`);
// right:
args.push(`--dir=${m.inside}=${m.outside}${m.rw ? ":rw" : ""}`);
```

## 7. Clearing the compile cache

Needed after any `DATA_ROOT` change, driver change (mock → isolate), or
compiler flag change — stale rows otherwise serve a cache "hit" pointing at
a binary that no longer exists (or exists somewhere else), silently
producing empty/fake-success results.

```bash
sudo docker compose exec postgres psql -U customjudge -d customjudge \
  -c "TRUNCATE compile_cache;"
rm -rf "$DATA_ROOT"/binaries/*
```

## 8. Sanity test after any change

```bash
curl -sS -X POST "http://localhost:2358/submissions?base64_encoded=false&wait=true" \
  -H 'Content-Type: application/json' \
  -d '{"source_code":"#include <iostream>\nint main(){ std::cout << 12 << std::endl; return 0; }","language_id":54,"stdin":""}'
```

Expect `stdout: "12\n"`, non-null `time`/`memory`. `time: null` with
`exit_code: 0` and empty `stdout` usually means the isolate run itself
failed — check `journalctl -u customjudge-execute.service` for
`isolateStderr`.

## 9. Scaling workers on one host

No `--scale` equivalent — these aren't containers. Two real levers, both
capped by `min(BOX_ID_MAX - BOX_ID_MIN, CPU cores)`:

1. **Raise concurrency first** (simplest): `COMPILE_CONCURRENCY`,
   `EXECUTE_CONCURRENCY` in `.env` — BullMQ `Worker` concurrency, mostly
   I/O-bound waiting on isolate/g++ child processes.
2. **Multiple worker processes**, only if #1 hits the box-pool ceiling.
   Recommended via pm2 (simpler than templated systemd units):
   ```bash
   pm2 start src/workers/executeWorker.js --name execute-worker -i 4
   pm2 start src/workers/compileWorker.js --name compile-worker -i 2
   pm2 save && pm2 startup   # run the printed command to survive reboot
   ```
   Box-id leasing is via Redis, so multiple processes coordinate safely —
   but don't run **both** systemd units and pm2 instances at once for the
   same worker; they'll race on the same queue and you'll debug phantom
   failures that are really just the stale process still holding an old env.
   ```bash
   sudo systemctl disable --now customjudge-compile.service customjudge-execute.service
   ```

## 10. Node `fetch` + `localhost` gotcha (client side, e.g. platform backend)

If a Node 18+ process calling into the judge API throws generic
`TypeError: fetch failed` even though `curl http://localhost:PORT/...`
works fine — Node's `fetch` (undici) can resolve `localhost` to IPv6
(`::1`) first/racily, while the API is IPv4-only. Use `127.0.0.1`
explicitly in any `.env`/config pointing at the judge, not `localhost`.
