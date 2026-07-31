#!/usr/bin/env bash
# start-stack.sh — one-command start of the PathAssist copilot agent stack (services/agent).
#
# Brings up all five services: db (Postgres) · copilot (gateway :8010) · cellvit (:8020) ·
# pathvlm/MedGemma (:8021) · preprocess/Trident (:8030). The preprocess service runs the REAL
# Trident+CONCH GPU path by default (docker-compose.trident.yml); pass --stub for the GPU-free stub.
#
# Usage:
#   ./start-stack.sh                # real Trident preprocess (default)
#   ./start-stack.sh --stub         # GPU-free stub preprocess (no GPU needed for preprocess)
#   ./start-stack.sh --build        # (re)build images before starting
#   ./start-stack.sh --down         # stop & remove the stack, then exit
#   ./start-stack.sh --no-wait      # don't poll /health after starting
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

MODE="trident"          # trident | stub
BUILD=0
WAIT=1
DOWN=0

for arg in "$@"; do
  case "$arg" in
    --stub)    MODE="stub" ;;
    --trident) MODE="trident" ;;
    --build)   BUILD=1 ;;
    --no-wait) WAIT=0 ;;
    --down)    DOWN=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)"; exit 2 ;;
  esac
done

# Compose file set: base always; the trident override adds the GPU image + weights + ipc:host.
FILES=(-f docker-compose.yml)
if [[ "$MODE" == "trident" ]]; then
  FILES+=(-f docker-compose.trident.yml)
  # Widen the resolver's local slide root to all of data2 so real extraction finds any .svs
  # (overridable in the environment / services/agent/.env).
  export PREPROCESS_SLIDES_DIR="${PREPROCESS_SLIDES_DIR:-/home/chen/data2}"
fi

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }

if [[ "$DOWN" == "1" ]]; then
  say "Stopping the agent stack…"
  docker compose "${FILES[@]}" down
  ok "Stack stopped."
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────────────────────────
say "Preflight checks"
docker info >/dev/null 2>&1 || { warn "Docker daemon is not reachable. Start Docker and retry."; exit 1; }

if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
  ok "NVIDIA container runtime present (GPU services: cellvit, pathvlm$( [[ $MODE == trident ]] && echo ', preprocess' ))"
else
  warn "NVIDIA runtime not detected — the GPU services (cellvit/pathvlm/real-preprocess) will fail to start."
fi

# The services authenticate every request against Girder/DSA at :9080 (a SEPARATE compose we do
# not manage here). Without it they return 401. Just warn — start DSA in its own project dir.
if curl -sf --max-time 4 http://localhost:9080/api/v1/system/version >/dev/null 2>&1; then
  ok "Girder/DSA reachable on :9080"
else
  warn "Girder/DSA (:9080) is NOT reachable — copilot tools will 401. Start the DSA stack separately."
fi

# ── Up ───────────────────────────────────────────────────────────────────────────
say "Starting the agent stack  (preprocess mode: $MODE)"
UP=(up -d)
[[ "$BUILD" == "1" ]] && UP+=(--build)
docker compose "${FILES[@]}" "${UP[@]}"

if [[ "$WAIT" == "0" ]]; then
  ok "Started (health polling skipped)."
  docker compose "${FILES[@]}" ps
  exit 0
fi

# ── Wait for health ────────────────────────────────────────────────────────────────
# name|url — copilot uses its prefixed route; the Flask services use /health.
ENDPOINTS=(
  "copilot|http://localhost:8010/api/copilot/health"
  "cellvit|http://localhost:8020/health"
  "pathvlm|http://localhost:8021/health"
  "preprocess|http://localhost:8030/health"
)
say "Waiting for services to report healthy (up to 120s each)…"
for entry in "${ENDPOINTS[@]}"; do
  name="${entry%%|*}"; url="${entry##*|}"
  printf '    %-11s ' "$name"
  for _ in $(seq 1 60); do
    if body="$(curl -sf --max-time 3 "$url" 2>/dev/null)"; then
      printf '\033[1;32mready\033[0m  %s\n' "$body"
      break
    fi
    sleep 2
    printf '.'
  done || true
  # If the loop exhausted without a break, flag it (the last body would be empty).
  if ! curl -sf --max-time 3 "$url" >/dev/null 2>&1; then
    printf '\033[1;33m timeout (still starting?)\033[0m\n'
  fi
done

echo
say "Stack status"
docker compose "${FILES[@]}" ps
echo
ok "Endpoints:  copilot :8010  ·  cellvit :8020  ·  pathvlm :8021  ·  preprocess :8030"
echo "    Frontend dev server is separate:  (cd $(dirname "$HERE" | xargs dirname) && npm run dev)  → :3000"
