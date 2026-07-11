#!/usr/bin/env bash
# PathAgent — tear down the live stack started by run-live.sh.
# Stops the gateway, worker, and dev server (by process group), and removes the
# Redis container. Leaves the cache dir (/tmp/pathagent-cache) intact by default;
# pass --purge-cache to delete it too.
set -uo pipefail

LOGDIR="/tmp/pathagent-live"
CACHE_DIR="${PATHAGENT_CACHE_DIR:-/tmp/pathagent-cache}"
PURGE=0; [ "${1:-}" = "--purge-cache" ] && PURGE=1

c_cyan=$'\033[36m'; c_off=$'\033[0m'
log() { printf '%s[stop]%s %s\n' "$c_cyan" "$c_off" "$*"; }

for name in gateway worker dev; do
  pf="$LOGDIR/$name.pid"
  if [ -f "$pf" ]; then
    pid="$(cat "$pf")"
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    rm -f "$pf"
    log "$name: stopped (pid $pid)"
  fi
done

# belt-and-suspenders in case pidfiles were lost
pkill -f "uvicorn pathagent.gateway.app" 2>/dev/null && log "killed stray uvicorn" || true
pkill -f "rq worker pathagent"           2>/dev/null && log "killed stray rq worker" || true

if docker ps -a --format '{{.Names}}' | grep -qx pathagent-redis; then
  docker rm -f pathagent-redis >/dev/null 2>&1 && log "redis: container removed"
fi

if [ "$PURGE" = 1 ]; then
  rm -rf "$CACHE_DIR" && log "cache purged ($CACHE_DIR)"
else
  log "cache kept ($CACHE_DIR) — pass --purge-cache to delete"
fi
log "done. (Your own dev server on :3000 is untouched.)"
