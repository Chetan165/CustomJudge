# CustomJudge

A **Judge0-compatible code judge service** optimized for **high concurrency and system saturation**.

## About CustomJudge

CustomJudge is a robust code execution service designed to handle extreme concurrency loads under CPU saturation. Unlike traditional synchronous judge systems, it uses an **asymmetric compile-once-execute-many (COEM) architecture** that decouples compilation from execution, enabling independent scaling and efficient resource utilization.

**Key Features:**

- **High-concurrency design**: Compile and execute worker pools scale independently, optimizing for realistic workload shapes (one compile feeds many testcase executions)
- **Compiled language support**: Currently supports **C++ (GCC)** and **Java** with extensible compiler support
- **Intelligent binary caching**: Caches compiled binaries using **content-addressable hashing** (code hash + problem ID + language ID), enabling cache hits across resubmissions and drastically reducing per-testcase compilation overhead under saturation
- **Zero-overhead execution**: Same compiled binary reused for all testcases of a problem, minimizing I/O and memory pressure
- **Judge0 API compatibility**: Drop-in replacement for Judge0 with identical submission/callback interfaces

**Architecture Overview:**

- Asymmetric worker pool: Compilation and execution run in independent processes with configurable concurrency
- Content-addressed binary cache: Hash-based lookup ensures identical source code automatically reuses cached binaries
- Redis queue: Distributed job queue enables horizontal scaling via multiple worker nodes
- Postgres persistence: Submission tracking, result storage, and compile cache metadata

---

## Deployment Steps

1. **Install prerequisites** (Debian minimal images may lack `useradd`)

   ```bash
   sudo apt-get update
   sudo apt-get install -y passwd build-essential curl ca-certificates git
   ```

2. **Provision the host** (builds isolate, sets up cgroup/user, smoke test)

   ```bash
   sudo bash infra/provision/provision-worker.sh
   ```

   This script:
   - Builds and installs isolate from upstream
   - Creates isolate user and cgroup configuration
   - Validates cgroup v2 and kernel version (5.19+)

3. **Install runtimes**

   **C++ (GCC):**

   ```bash
   sudo apt-get install -y g++
   ```

   **Java:**

   ```bash
   sudo apt-get install -y openjdk-11-jdk
   # Verify installation:
   java -version
   ```

   The provisioning script includes additional runtime setup in [infra/Runtimes/Installruntime.bash](infra/Runtimes/Installruntime.bash).

4. **Configure `.env`** (copy from `.env.example` and customize)

   Key variables for compile cache and runtime paths:

   ```
   SANDBOX_DRIVER=isolate
   ISOLATE_BIN=/usr/local/bin/isolate
   DATA_ROOT=/var/lib/customjudge           # lowercase — must match docker compose mount

   # Compile cache configuration
   BINARY_CACHE_MAX_BYTES=2147483648        # ~2 GB binary cache limit
   CXX_COMPILER=/usr/bin/g++                # absolute path to C++ compiler
   CXX_FLAGS=-std=c++17 -O2 -w -lm -static -s
   JavaHome=/usr/lib/jvm/java-11-openjdk-amd64  # Java installation path
   JavaEtc=/etc/java-11-openjdk             # Java config directory

   # Worker concurrency (see below for scaling guidelines)
   COMPILE_CONCURRENCY=2                    # per-process concurrent compile jobs
   EXECUTE_CONCURRENCY=4                    # per-process concurrent execute jobs

   CALLBACK_METHOD=PUT                      # must match your platform's callback route method
   ```

   For a full list of configuration options, see [.env.example](.env.example).

5. **Start Postgres/Redis**

   ```bash
   cd infra && sudo docker compose up -d
   redis-cli -h 127.0.0.1 -p 6379 ping   # expect PONG
   cd ..
   ```

6. **Install Node.js 20 LTS** (if not already present)

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node --version && npm --version
   ```

7. **Install deps and run DB migrations**

   ```bash
   npm install
   node src/db/migrate.js
   ```

8. **Start the compile/execute workers — choose ONE supervisor, never both**

   **Option A — pm2** (recommended for development)

   ```bash
   pm2 start src/workers/compileWorker.js --name compile-worker
   pm2 start src/workers/executeWorker.js --name execute-worker
   pm2 save
   pm2 startup   # run the printed command once, so pm2 survives reboot
   ```

   **Option B — systemd** (recommended for production)

   ```bash
   sudo cp infra/systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now customjudge-compile.service customjudge-execute.service
   ```

   **Concurrency Management:**
   - Worker concurrency is controlled exclusively via `.env` variables (`COMPILE_CONCURRENCY` and `EXECUTE_CONCURRENCY`)
   - Each worker process respects these limits independently
   - Do **NOT** use pm2's `-i` flag to spawn multiple instances — instead, use higher `.env` concurrency values for a single process, or run multiple isolated nodes with distinct `NODE_ID` values
   - Never run both pm2 and systemd for the same worker — they will both consume the same Redis queue and silently double your effective concurrency

9. **Sanity test**
   ```bash
   curl -sS -X POST "http://localhost:2358/submissions?base64_encoded=false&wait=true" \
     -H 'Content-Type: application/json' \
     -d '{"source_code":"#include <iostream>\nint main(){ std::cout << 12 << std::endl; return 0; }","language_id":54,"stdin":""}'
   ```
   Expect `stdout: "12\n"`, non-null `time`/`memory`.

---

## Performance Comparison vs Judge0

**Test Setup:**

- Infrastructure: AWS c5a.2xlarge (8 vCPU, 16 GB RAM)
- Workload: Unique C++ submissions (no cache hits), polled every 1500ms for results
- CustomJudge config: Compile Concurrency=4, Execute Concurrency=20
- Judge0 config: Worker concurrency=16

**Latency Results (submission-to-completion roundtrip time):**

| Submission Count | Metric | CustomJudge | Judge0     |
| ---------------- | ------ | ----------- | ---------- |
| **10**           | Min    | 1697 ms     | 6249 ms    |
|                  | Avg    | 2898 ms     | 11660 ms   |
|                  | P95    | 4699 ms     | 16755 ms   |
|                  | Max    | 4699 ms     | 16755 ms   |
| **30**           | Min    | 1739 ms     | 6257 ms    |
|                  | Avg    | 5966 ms     | 28086 ms   |
|                  | P95    | 10827 ms    | 48427 ms   |
|                  | Max    | 10828 ms    | 48428 ms   |
| **50**           | Min    | 1760 ms     | 6264 ms    |
|                  | Avg    | 8983 ms     | 33956 ms\* |
|                  | P95    | 15318 ms    | 60515 ms\* |
|                  | Max    | 16826 ms    | 62063 ms\* |

\*Judge0 timed out at 50 submissions; data shown is from 38 completed submissions.

**Key Observations:**

- **Consistent baseline**: CustomJudge's minimum latency (1.7–1.8s) is stable across all load levels, indicating predictable queue behavior
- **Asymmetric scaling advantage**: Judge0's average latency grows ~3.7× from 10→30 submissions and ~4.2× from 10→50, while CustomJudge grows only ~2× and ~3×. The independent compile/execute pools allow execution to proceed while the compile queue drains, reducing head-of-line blocking
- **High-concurrency robustness**: At 50 submissions, Judge0 begins timing out (38/50 completed) while CustomJudge completes all submissions with bounded latency
- **P95 performance**: CustomJudge's P95 scales more gracefully due to reduced tail latency from the deferred compile-many-execute-many pattern

**Memory Utilization (10 concurrent C++ submissions):**

| Metric               | CustomJudge | Judge0   |
| -------------------- | ----------- | -------- |
| Baseline Used Memory | 817 MB      | 1673 MB  |
| Peak Used Memory     | 1600 MB     | 3208 MB  |
| Memory Increase      | 783 MB      | 1535 MB  |
| Available After Peak | 13825 MB    | 12235 MB |

**Memory Profile Analysis:**

<iframe src="mem_results/memory-comparison.html" style="width: 100%; height: 1200px; border: 1px solid #ddd; border-radius: 8px;"></iframe>

**Key Insight:** CustomJudge's asymmetric architecture enables garbage collection between independent compile and execute stages, whereas Judge0's tightly coupled per-job model serializes memory release until the entire job completes, doubling peak memory footprint.

---

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for solutions to common deployment errors.

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
pm2 delete compileWorker executeWorker        # if standardizing on pm2
# or
sudo systemctl disable --now customjudge-compile.service customjudge-execute.service  # if standardizing on systemd
```
