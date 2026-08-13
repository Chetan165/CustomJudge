#!/usr/bin/env bash
# Provisions a worker host: current upstream isolate on cgroup v2.
# Target: Ubuntu 22.04/24.04 LTS. Not for containers, not for WSL.
set -euo pipefail

ISOLATE_REPO="https://github.com/ioi/isolate.git"
ISOLATE_REF="${ISOLATE_REF:-master}"
DATA_ROOT="${DATA_ROOT:-/var/lib/customjudge}"

log() { echo -e "\033[1;34m[provision]\033[0m $*"; }
fail() { echo -e "\033[1;31m[provision] FAIL:\033[0m $*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || fail "Linux only. isolate needs namespaces + cgroups."
[[ $EUID -eq 0 ]] || fail "Run as root (sudo)."

log "Checking cgroup v2..."
CGROUP_TYPE="$(stat -fc %T /sys/fs/cgroup)"
if [[ "$CGROUP_TYPE" != "cgroup2fs" ]]; then
  fail "cgroup v2 required, found '$CGROUP_TYPE'. Use a distro defaulting to unified cgroups (Ubuntu 22.04+). Do NOT apply Judge0's unified_cgroup_hierarchy=0 workaround."
fi

log "Checking kernel version (5.19+ required for memory reporting)..."
KVER="$(uname -r | cut -d- -f1)"
KMAJ="${KVER%%.*}"; KREST="${KVER#*.}"; KMIN="${KREST%%.*}"
if (( KMAJ < 5 || (KMAJ == 5 && KMIN < 19) )); then
  fail "Kernel $KVER too old; isolate needs 5.19+ for memory-usage reporting."
fi

log "Installing build dependencies..."
apt-get update -qq
apt-get install -y --no-install-recommends \
  git build-essential pkg-config libcap-dev libsystemd-dev asciidoc-base \
  libseccomp-dev libxml2-utils docbook-xml docbook-xsl xsltproc \
  g++ curl ca-certificates

log "Building isolate from upstream ($ISOLATE_REF)..."
BUILD_DIR="$(mktemp -d)"
git clone --depth 1 --branch "$ISOLATE_REF" "$ISOLATE_REPO" "$BUILD_DIR/isolate"
pushd "$BUILD_DIR/isolate" >/dev/null
make
make install
popd >/dev/null
rm -rf "$BUILD_DIR"

log "Ensuring isolate user + subordinate ID mappings..."
if ! id -u isolate >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin isolate
fi

ensure_subid_map() {
  local file="$1"
  local user="$2"
  local span=65536
  local start

  if grep -qE "^${user}:" "$file"; then
    return 0
  fi

  start="$(awk -F: '
    BEGIN { max = 99999 }
    $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {
      end = $2 + $3 - 1
      if (end > max) max = end
    }
    END { print max + 1 }
  ' "$file")"

  echo "${user}:${start}:${span}" >> "$file"
}

ensure_subid_map /etc/subuid isolate
ensure_subid_map /etc/subgid isolate

log "Enabling isolate.service (delegated cgroup subtree)..."
systemctl daemon-reload
if ! systemctl enable --now isolate.service; then
  log "isolate.service status:"
  systemctl status isolate.service --no-pager -l || true
  log "isolate.service journal (last 120 lines):"
  journalctl -u isolate.service -b --no-pager -n 120 || true
  fail "isolate.service failed to start"
fi

log "Creating data directories at $DATA_ROOT..."
mkdir -p "$DATA_ROOT"/{problems,binaries,tmp}
chmod 755 "$DATA_ROOT"

log "Running isolate-check-environment..."
if ! isolate-check-environment --quiet; then
  fail "isolate-check-environment reported problems. Fix them before this node joins the pool."
fi

log "Smoke test..."
BOX="$(isolate --cg --box-id=0 --init)"
cat > "$BOX/box/hello.cpp" <<'EOF'
#include <cstdio>
int main(){ int x; if(scanf("%d",&x)==1) printf("%d\n", x*2); return 0; }
EOF
isolate --cg --box-id=0 --processes=64 --wall-time=30 \
  --env=PATH=/usr/bin:/bin --run -- /usr/bin/g++ -O2 -std=c++17 hello.cpp -o hello \
  || fail "sandboxed compile failed"
echo "21" > "$BOX/box/in.txt"
isolate --cg --box-id=0 --time=1 --wall-time=5 --cg-mem=65536 \
  --stdin=in.txt --stdout=out.txt --meta=/tmp/cj-meta.txt --run -- ./hello \
  || fail "sandboxed run failed"
RESULT="$(cat "$BOX/box/out.txt")"
isolate --cg --box-id=0 --cleanup
[[ "$RESULT" == "42" ]] || fail "smoke test expected 42, got '$RESULT'"

log "isolate meta from smoke test:"
cat /tmp/cj-meta.txt

log "Worker host provisioned successfully."
log "Next: set SANDBOX_DRIVER=isolate in .env, then install systemd units from infra/systemd/."
