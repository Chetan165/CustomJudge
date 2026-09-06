# Troubleshooting Guide

Solutions to common CustomJudge deployment errors.

## Fixes for specific errors

**`useradd: command not found`**

`/usr/sbin` missing from `PATH`, or `passwd` package not installed.

```bash
sudo apt-get install -y passwd
export PATH=$PATH:/usr/sbin:/sbin
```

---

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

Use `| sudo tee`, not `sudo echo ... > file` (redirect runs in your unprivileged shell even under `sudo`, fails silently).

---

**`execve("g++"): No such file or directory`**

isolate execs directly, no shell/`$PATH` lookup. `CXX_COMPILER` in `.env` must be an absolute path (`/usr/bin/g++`), not `g++`.

---

**`ENOENT` on binary path / stale compile cache after config change**

`DATA_ROOT` case mismatch, or cache pointing at an old path/driver. Clear it:

```bash
sudo docker compose exec postgres psql -U customjudge -d customjudge -c "TRUNCATE compile_cache;"
rm -rf "$DATA_ROOT"/binaries/*
```

---

**`Invalid directory rule '...':Unknown option 'ro'` (isolate execute silently fails)**

Read-only is isolate's default — never append `:ro` to `--dir`, only `:rw` when needed.

---

**systemd: `Failed to load environment files: No such file or directory` / result `resources`**

Unit files hardcode `WorkingDirectory=/opt/customjudge`. Point at your real repo path:

```bash
sudo sed -i 's#/opt/customjudge#<YOUR_REPO_PATH>#g' /etc/systemd/system/customjudge-*.service
sudo systemctl daemon-reload
sudo systemctl restart customjudge-compile.service customjudge-execute.service
```

Or symlink once so re-copying unit files never breaks it:

```bash
sudo ln -sf <YOUR_REPO_PATH> /opt/customjudge
```

---

**systemd: `status=203/EXEC`**

`ExecStart=/usr/bin/node ...` but Node isn't at that path (or isn't installed).

```bash
which node
sudo sed -i "s#/usr/bin/node#$(which node)#g" /etc/systemd/system/customjudge-*.service
sudo systemctl daemon-reload && sudo systemctl restart customjudge-compile.service customjudge-execute.service
```

---

**`npm: command not found` after installing Node**

```bash
sudo apt-get install -y npm
# or, for a clean Node 20 LTS + matching npm:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

**`relation "submissions" does not exist`**

Migrations never ran on this DB:

```bash
node src/db/migrate.js
```
