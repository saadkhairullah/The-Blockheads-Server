#!/bin/bash
set -euo pipefail

# =============================================================================
# Blockheads Server Tools — Docker Entrypoint
# Starts: game server → Java proxy → Node.js bot (Python daemon auto-spawned)
# =============================================================================

# --- Required env vars -------------------------------------------------------
: "${BH_WORLD_ID:?BH_WORLD_ID is required (your world UUID)}"
: "${BH_SERVER_USER:?BH_SERVER_USER is required (your username)}"

# --- Defaults ----------------------------------------------------------------
BH_MAX_PLAYERS="${BH_MAX_PLAYERS:-32}"
# Game server always listens on 15151 internally.
# In multi-server setups Docker's port mapping differentiates external ports.
BH_SERVER_PORT=15151
BH_PROXY_PORT="${BH_PROXY_PORT:-15153}"
BH_WORLD_NAME="${BH_WORLD_NAME:-My Server}"

# --- Paths (all under /data volume) ------------------------------------------
export GNUSTEP_USER_ROOT=/data/gnustep
export LD_LIBRARY_PATH=/usr/local/lib:${LD_LIBRARY_PATH:-}
# BH_CONFIG_PATH is used by the C hooks (hook_config.c reads this env var)
export BH_CONFIG_PATH=/data/config.json

DATA_DIR=/data
LOG_DIR=/data/logs
INPUT_PIPE=/data/blockheads_input
SERVER_LOG=/data/logs/blockheads.log
WM_SOCK=/tmp/bh-wm.sock
EVENT_SOCK=/tmp/bh-events.sock
CMD_SOCK=/tmp/bh-commands.sock

# --- Derived path env vars (picked up by bot's config.ts) --------------------
# config.ts overrides these fields at runtime from env — no need to hardcode in JSON
export BH_WORLD_SAVE_PATH="${GNUSTEP_USER_ROOT}/Library/ApplicationSupport/TheBlockheads/saves/${BH_WORLD_ID}/"
export BH_ADMIN_LIST_PATH="${BH_WORLD_SAVE_PATH}adminlist.txt"
export BH_SERVER_LOG_PATH="${SERVER_LOG}"
export BH_INPUT_PIPE_PATH="${INPUT_PIPE}"
export BH_DATA_DIR="${DATA_DIR}"
export BH_WM_SOCK="${WM_SOCK}"
export BH_COMMAND_SOCKET="${CMD_SOCK}"
export BH_QUEST_DATA_PATH=/data/quest-data.json
export BH_WILD_LOCATIONS_PATH=/app/tools/wild_locations.py
export BH_PYTHON_PATH=python3

# --- Directory setup ---------------------------------------------------------
mkdir -p "${DATA_DIR}" "${LOG_DIR}" \
  "${GNUSTEP_USER_ROOT}/Library/ApplicationSupport/TheBlockheads/saves/${BH_WORLD_ID}"

# Create FIFO input pipe (must be a real named pipe, not a regular file)
if [ ! -p "${INPUT_PIPE}" ]; then
  mkfifo "${INPUT_PIPE}"
fi

# Copy quest data to /data if not already present (operator can replace this file)
if [ ! -f /data/quest-data.json ]; then
  cp /app/config/quest-data.json /data/quest-data.json
fi

# --- Config setup ------------------------------------------------------------
# /data/config.json is on the persistent volume so SaveArenaZone writes persist.
# The bot finds config via its default search path /app/config/config.json —
# we symlink that to /data/config.json so both the bot and C hooks read the same file.
#
# On first run: copy config.example.json as the base. The bot's config.ts applies
# BH_* env var overrides on top at runtime (server.user, worldId, all paths, etc.).
# For full customization (shop items, jobs): mount your own config to /data/config.json.

if [ ! -f /data/config.json ]; then
  echo "[entrypoint] First run — copying config.example.json to /data/config.json"
  cp /app/config/config.example.json /data/config.json
else
  echo "[entrypoint] Using existing /data/config.json"
fi

# Symlink so bot's auto-discovery path (/app/config/config.json) resolves to /data/config.json
mkdir -p /app/config
ln -sf /data/config.json /app/config/config.json
echo "[entrypoint] /app/config/config.json → /data/config.json"

# Game server binary uses $HOME/GNUstep regardless of GNUSTEP_USER_ROOT.
# Inside the container $HOME=/root, so symlink /root/GNUstep → /data/gnustep.
ln -sf /data/gnustep /root/GNUstep
echo "[entrypoint] /root/GNUstep → /data/gnustep"

# --- Process tracking --------------------------------------------------------
PIDS=()

cleanup() {
  echo "[entrypoint] Shutting down all processes..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait
  echo "[entrypoint] Done."
}
trap cleanup SIGTERM SIGINT

# --- Start game server -------------------------------------------------------
echo "[entrypoint] Starting game server (world: ${BH_WORLD_ID}, port: ${BH_SERVER_PORT})..."
tail -f "${INPUT_PIPE}" \
  | env GNUSTEP_USER_ROOT="${GNUSTEP_USER_ROOT}" \
    LD_PRELOAD=/app/libblockheads_hooks.so \
    /app/blockheads_server171 \
      -o "${BH_WORLD_ID}" \
      -s 67 \
      -m "${BH_MAX_PLAYERS}" \
      --owner "${BH_SERVER_USER}" \
      --no-exit \
    2>&1 | tee "${SERVER_LOG}" &
SERVER_PID=$!
PIDS+=($SERVER_PID)
echo "[entrypoint] Game server PID: ${SERVER_PID}"

# Wait for game server to initialize
sleep 3

# --- Start Java proxy --------------------------------------------------------
echo "[entrypoint] Starting proxy (players→${BH_PROXY_PORT}, game→${BH_SERVER_PORT})..."
/app/proxy/bin/interceptor \
  -P "${BH_PROXY_PORT}" \
  -S "${BH_SERVER_PORT}" \
  --event-socket "${EVENT_SOCK}" \
  --command-socket "${CMD_SOCK}" \
  >> "${LOG_DIR}/proxy.log" 2>&1 &
PROXY_PID=$!
PIDS+=($PROXY_PID)
echo "[entrypoint] Proxy PID: ${PROXY_PID}"

sleep 2

# --- Start Node.js bot -------------------------------------------------------
echo "[entrypoint] Starting bot..."
cd /app/bot
node build/mac.js >> "${LOG_DIR}/bot.log" 2>&1 &
BOT_PID=$!
PIDS+=($BOT_PID)
echo "[entrypoint] Bot PID: ${BOT_PID}"

echo "[entrypoint] All processes started. Tailing logs..."
echo "[entrypoint]   Server log: ${SERVER_LOG}"
echo "[entrypoint]   Bot log:    ${LOG_DIR}/bot.log"
echo "[entrypoint]   Proxy log:  ${LOG_DIR}/proxy.log"

# If any process exits, shut everything down
wait -n "${PIDS[@]}"
echo "[entrypoint] A process exited unexpectedly. Shutting down."
cleanup
exit 1
