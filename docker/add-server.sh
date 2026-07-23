#!/bin/bash
# =============================================================================
# add-server.sh — Helper for hosting providers running multiple servers
#
# Usage:
#   ./add-server.sh --name "PvP Arena" --port 15156 --world-id "abc-123" --owner "SomeUser"
#
# Creates:
#   servers/<slug>.env    — env file for the new server
#
# Prints:
#   The docker-compose.multi.yml service block to copy into your compose file
# =============================================================================

set -euo pipefail

NAME=""
PORT=""
WORLD_ID=""
OWNER=""
PASS=""
MAX_PLAYERS=32

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)       NAME="$2";        shift 2 ;;
    --port)       PORT="$2";        shift 2 ;;
    --world-id)   WORLD_ID="$2";    shift 2 ;;
    --owner)      OWNER="$2";       shift 2 ;;
    --pass)       PASS="$2";        shift 2 ;;
    --max-players) MAX_PLAYERS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate
if [ -z "$NAME" ] || [ -z "$PORT" ] || [ -z "$WORLD_ID" ] || [ -z "$OWNER" ]; then
  echo "Usage: $0 --name <name> --port <port> --world-id <uuid> --owner <username> [--pass <pass>] [--max-players <n>]"
  exit 1
fi

# Generate a slug from the name (lowercase, spaces to dashes, strip special chars)
SLUG=$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')
SERVICE_NAME="server-${SLUG}"
CONTAINER_NAME="bh-${SLUG}"
ENV_FILE="servers/${SLUG}.env"

mkdir -p servers

# Write env file — use printf so special chars in values can't inject extra lines
{
  printf 'BH_WORLD_ID=%s\n'    "${WORLD_ID}"
  printf 'BH_SERVER_USER=%s\n' "${OWNER}"
  printf 'BH_SERVER_PASS=%s\n' "${PASS}"
  printf 'BH_WORLD_NAME=%s\n'  "${NAME}"
  printf 'BH_MAX_PLAYERS=%s\n' "${MAX_PLAYERS}"
} > "${ENV_FILE}"

echo "Created ${ENV_FILE}"
echo ""
echo "Add this block to docker-compose.multi.yml under 'services:':"
echo "------------------------------------------------------------"
cat <<EOF

  ${SERVICE_NAME}:
    image: blockheads-server:latest
    container_name: ${CONTAINER_NAME}
    restart: unless-stopped
    env_file: ./${ENV_FILE}
    ports:
      - "${PORT}:15153/udp"
    volumes:
      - ${SLUG}-data:/data
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"
EOF
echo ""
echo "Also add this under 'volumes:':"
echo "------------------------------------------------------------"
echo "  ${SLUG}-data:"
echo ""
echo "Then run: docker-compose -f docker-compose.multi.yml up -d ${SERVICE_NAME}"
