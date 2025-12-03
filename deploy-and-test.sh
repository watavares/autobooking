#!/usr/bin/env bash
set -euo pipefail

# deploy-and-test.sh
# Usage on VM:
#   chmod +x deploy-and-test.sh
#   ./deploy-and-test.sh [GIT_REPO_URL]
# If GIT_REPO_URL is not provided, script expects current directory to contain the repository.

REPO_URL=${1:-}
APP_DIR=${2:-$HOME/autobooking}
NODE_VERSION=18

echo "Starting deploy-and-test on $(uname -a)"

# Update and install dependencies
if [ -x "$(command -v apt)" ]; then
  sudo apt update
  sudo apt install -y curl git build-essential ca-certificates jq
else
  echo "Only Debian/Ubuntu apt-based systems are supported by this script. Exiting." >&2
  exit 1
fi

# Install Node.js (NodeSource) if node not present or version < required
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//;s/^v//')" != "$(node -v | sed 's/v//;s/^v//')" ]; then
  echo "Installing Node.js $NODE_VERSION from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
  sudo apt install -y nodejs
fi

echo "node $(node -v), npm $(npm -v)"

# Install pm2 for process management
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi

# Clone repository if requested
if [ -n "$REPO_URL" ] && [ ! -d "$APP_DIR" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi

if [ ! -d "$APP_DIR" ]; then
  echo "App directory $APP_DIR not found. Please clone repo or pass the repo URL as first argument." >&2
  exit 1
fi

cd "$APP_DIR"

# Install app dependencies
if [ -f package-lock.json ] || [ -f package.json ]; then
  npm ci --silent || npm install --no-audit --no-fund
fi

# Ensure config.json and payload.json exist
if [ ! -f config.json ]; then
  echo "WARNING: config.json not found. Create and upload your config.json with your token and IDs before running bookings."
  cat > config.json <<'EOF'
{
  "token": "REPLACE_WITH_YOUR_TOKEN",
  "organisationId": "REPLACE_WITH_ORG",
  "federationId": "REPLACE_WITH_FED",
  "locationId": "REPLACE_WITH_LOCATION",
  "reservationTypeId": 85,
  "apiBase": "https://api.foys.io/court-booking/members/api/v1"
}
EOF
  echo "A sample config.json was written; edit it with your token or upload the real one via scp."
fi

if [ ! -f payload.json ]; then
  cat > payload.json <<'EOF'
{
  "reservationTypeId":85,
  "startDateTime":"2025-12-03T22:30",
  "endDateTime":"2025-12-04T00:00",
  "reservations":[{"inventoryItemId":737}]
}
EOF
  echo "A sample payload.json was written; replace it with your desired booking payload or upload via scp."
fi

# Start the server with pm2
pm2 stop autobooking 2>/dev/null || true
pm2 delete autobooking 2>/dev/null || true
pm2 start server.js --name autobooking --output ./logs/out.log --error ./logs/err.log || {
  echo "pm2 start failed; attempting to run with nohup instead"
  mkdir -p logs
  nohup node server.js > logs/out.log 2> logs/err.log & echo $! > server.pid
}

sleep 2

# Show diag
echo "---- /api/diag ----"
curl -sS http://localhost:3000/api/diag | jq . || echo "diag failed"

# Run the booking proxy try-variants test
echo "---- proxy-booking-try-variants ----"
curl -v -X POST http://localhost:3000/api/proxy-booking-try-variants -H "Content-Type: application/json" --data-binary @payload.json || true

# Run the raw-replay test if raw-replay.json exists
if [ -f raw-replay.json ]; then
  echo "---- proxy-booking-raw (raw-replay.json) ----"
  curl -v -X POST http://localhost:3000/api/proxy-booking-raw -H "Content-Type: application/json" --data-binary @raw-replay.json || true
fi

# Tail logs
echo "---- tail logs (last 200 lines) ----"
tail -n 200 logs/out.log logs/err.log || tail -n 200 logs/out.log || true

echo "Deploy-and-test finished. If you want this process to survive reboots, consider using pm2 startup (pm2 startup && pm2 save)."
