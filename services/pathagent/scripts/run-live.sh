#!/usr/bin/env bash
# PathAgent — stand up the full LIVE stack for manual browser testing.
#
# Brings up: Redis (docker) → M3 gateway (uvicorn :8000) → RQ worker →
# a Vite dev server (:3001) wired to the gateway via VITE_AGENT_API_URL.
# Optionally warms the slide cache so the first in-browser "Prepare" is instant.
# Daemons keep running AFTER this script exits — run stop-live.sh to tear down.
#
# Usage:
#   services/pathagent/scripts/run-live.sh [GIRDER_TOKEN]
#   GIRDER_TOKEN=<token> services/pathagent/scripts/run-live.sh
#   ITEM_ID=<girderItemId> services/pathagent/scripts/run-live.sh <token>   # override slide
#
# The token is OPTIONAL:
#   • with it  → the cache is warmed and a one-click auto-auth URL is printed;
#   • without  → just log in through the app UI, then click "Prepare" in the panel.
set -uo pipefail

REPO="/home/chen/pathassist23"
PA="$REPO/services/pathagent"
LOGDIR="/tmp/pathagent-live"
GATEWAY_PORT=8000
DEV_PORT=3001
ITEM_ID="${ITEM_ID:-6a3efdab9cb269b0b0bb615c}"        # public BRACS_1648 in BRCA-DEMO/slides
GIRDER_BASE="http://192.168.191.109:9080/api/v1"

export PATHAGENT_GIRDER_BASE="$GIRDER_BASE"
export PATHAGENT_REDIS_URL="redis://localhost:6379/0"
export PATHAGENT_CACHE_DIR="${PATHAGENT_CACHE_DIR:-/tmp/pathagent-cache}"
# Read slides from the local disk instead of streaming them out of Girder (the DSA
# runs on this same host). resolve_slide() matches the item's Girder file name here,
# so preprocessing never hits /file/{id}/download. Unset to force Girder downloads.
export PATHAGENT_SLIDES_ROOT="${PATHAGENT_SLIDES_ROOT:-/home/chen/data2/BRCA-TEST}"

TOKEN="${1:-${GIRDER_TOKEN:-}}"

c_cyan=$'\033[36m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_green=$'\033[32m'; c_off=$'\033[0m'
log()  { printf '%s[live]%s %s\n' "$c_cyan"   "$c_off" "$*"; }
ok()   { printf '%s[live]%s %s\n' "$c_green"  "$c_off" "$*"; }
warn() { printf '%s[live]%s %s\n' "$c_yellow" "$c_off" "$*"; }
err()  { printf '%s[live]%s %s\n' "$c_red"    "$c_off" "$*"; }

mkdir -p "$LOGDIR" "$PATHAGENT_CACHE_DIR"

# HF token from .env.local (line "HF_token=...") — Trident/CONCH need it to pull weights.
HF_LINE="$(grep -E '^HF_token=' "$REPO/.env.local" 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -n "${HF_LINE:-}" ]; then export HF_TOKEN="$HF_LINE"; else warn "no HF_token in .env.local — model download may fail"; fi

# ── stop any daemons we started before (idempotent restart) ───────────────────
for name in gateway worker dev; do
  pf="$LOGDIR/$name.pid"
  [ -f "$pf" ] && { kill -TERM "-$(cat "$pf")" 2>/dev/null || kill -TERM "$(cat "$pf")" 2>/dev/null || true; rm -f "$pf"; }
done
pkill -f "uvicorn pathagent.gateway.app" 2>/dev/null || true
pkill -f "rq worker pathagent"           2>/dev/null || true

# ── 1) Redis ──────────────────────────────────────────────────────────────────
if docker ps --format '{{.Names}}' | grep -qx pathagent-redis; then
  log "redis: already running"
elif docker ps -a --format '{{.Names}}' | grep -qx pathagent-redis; then
  docker start pathagent-redis >/dev/null && log "redis: restarted existing container"
else
  docker run -d --name pathagent-redis -p 6379:6379 redis:7 >/dev/null && log "redis: started"
fi

# ── 2) Gateway (uvicorn) ──────────────────────────────────────────────────────
cd "$PA"
setsid uv run uvicorn pathagent.gateway.app:create_app --factory \
  --host 0.0.0.0 --port "$GATEWAY_PORT" >"$LOGDIR/gateway.log" 2>&1 </dev/null &
echo $! >"$LOGDIR/gateway.pid"
log "gateway: starting (pid $(cat "$LOGDIR/gateway.pid"), log $LOGDIR/gateway.log)"

# ── 3) RQ worker ──────────────────────────────────────────────────────────────
setsid uv run rq worker pathagent --url "$PATHAGENT_REDIS_URL" \
  >"$LOGDIR/worker.log" 2>&1 </dev/null &
echo $! >"$LOGDIR/worker.pid"
log "worker: starting (pid $(cat "$LOGDIR/worker.pid"), log $LOGDIR/worker.log)"

# ── 4) Dev server (vite) wired to the gateway ─────────────────────────────────
cd "$REPO"
VITE_AGENT_API_URL="http://localhost:$GATEWAY_PORT/api/agent" \
  setsid ./node_modules/.bin/vite --port "$DEV_PORT" --strictPort \
  >"$LOGDIR/dev.log" 2>&1 </dev/null &
echo $! >"$LOGDIR/dev.pid"
log "dev:  starting on :$DEV_PORT (pid $(cat "$LOGDIR/dev.pid"), log $LOGDIR/dev.log)"

# ── wait for gateway health ───────────────────────────────────────────────────
log "waiting for gateway…"
gw_ok=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 "http://localhost:$GATEWAY_PORT/openapi.json" >/dev/null 2>&1; then gw_ok=1; break; fi
  sleep 1
done
[ "$gw_ok" = 1 ] && ok "gateway: healthy on :$GATEWAY_PORT" || { err "gateway did not come up — see $LOGDIR/gateway.log"; tail -20 "$LOGDIR/gateway.log"; }

# ── wait for dev server ───────────────────────────────────────────────────────
log "waiting for dev server…"
dev_ok=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 "http://localhost:$DEV_PORT" >/dev/null 2>&1; then dev_ok=1; break; fi
  sleep 1
done
[ "$dev_ok" = 1 ] && ok "dev:  serving on :$DEV_PORT" || { err "dev server did not come up — see $LOGDIR/dev.log"; tail -20 "$LOGDIR/dev.log"; }

# ── optional cache warm-up (needs a token; matches the panel's exact request) ─
warmed=0
if [ -n "${TOKEN:-}" ] && [ "$gw_ok" = 1 ]; then
  log "warming cache for item $ITEM_ID (Trident features + consensus; a few minutes on cold cache)…"
  body='{"backbone":{"patchEncoder":"conch_v1","mag":20,"patchSize":256},"consensus":{"patchEncoder":"uni_v1","mag":20,"patchSize":512}}'
  resp="$(curl -sf -m 30 -X POST "http://localhost:$GATEWAY_PORT/api/agent/cases/$ITEM_ID/preprocess" \
            -H "Girder-Token: $TOKEN" -H 'Content-Type: application/json' -d "$body" 2>/dev/null || true)"
  cache_key="$(printf '%s' "$resp" | sed -nE 's/.*"cacheKey"[: ]*"([^"]+)".*/\1/p')"
  if [ -z "$cache_key" ]; then
    warn "warm-up: preprocess did not return a cacheKey (resp: ${resp:0:160}) — skipping; click Prepare in the browser instead"
  else
    log "warm-up: cacheKey=$cache_key — polling status…"
    for i in $(seq 1 180); do   # up to ~15 min
      st="$(curl -sf -m 10 "http://localhost:$GATEWAY_PORT/api/agent/cases/$ITEM_ID/status?cacheKey=$cache_key" \
              -H "Girder-Token: $TOKEN" 2>/dev/null || true)"
      state="$(printf '%s' "$st" | sed -nE 's/.*"status"[: ]*"([^"]+)".*/\1/p')"
      stage="$(printf '%s' "$st" | sed -nE 's/.*"stage"[: ]*"([^"]*)".*/\1/p')"
      case "$state" in
        ready) warmed=1; ok "warm-up: READY (cacheKey=$cache_key)"; break ;;
        error) err "warm-up: preprocessing errored (${st:0:200}) — check $LOGDIR/worker.log"; break ;;
        *)     [ $((i % 5)) -eq 0 ] && log "warm-up: ${state:-?} ${stage:+/ $stage} (${i}/180)"; sleep 5 ;;
      esac
    done
    [ "$warmed" = 0 ] && [ "$state" != "error" ] && warn "warm-up: still not ready after timeout — the worker may still be running; the browser Prepare will pick it up"
  fi
else
  [ -z "${TOKEN:-}" ] && log "no token given → skipping warm-up (log in via the UI and click Prepare)."
fi

# ── final instructions ────────────────────────────────────────────────────────
echo
ok "════════════════════════════════════════════════════════════════════"
ok " PathAgent LIVE stack is up."
echo
if [ -n "${TOKEN:-}" ]; then
  printf '   Open (auto-auth):  %shttp://localhost:%s/?girderToken=%s%s\n' "$c_green" "$DEV_PORT" "$TOKEN" "$c_off"
else
  printf '   Open:              %shttp://localhost:%s/%s   (then log in as usual)\n' "$c_green" "$DEV_PORT" "$c_off"
fi
echo
echo "   Then, in the app:"
echo "     1. Open a slide — for the warmed cache open BRACS_1648 (BRCA-DEMO ▸ slides)."
echo "     2. Right panel ▸ PathAgent tab (compass icon; needs the 'ai-users' role)."
[ "$warmed" = 1 ] && echo "     3. Click Prepare → returns 'ready' instantly (cache warmed)." \
                   || echo "     3. Click Prepare → runs Trident (a few min the first time)."
echo "     4. Ask a Diagnosis question and watch it stream + co-navigate the viewer."
echo
echo "   Logs:  tail -f $LOGDIR/{gateway,worker,dev}.log"
echo "   Stop:  services/pathagent/scripts/stop-live.sh"
ok "════════════════════════════════════════════════════════════════════"
