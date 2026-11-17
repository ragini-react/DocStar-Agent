#!/usr/bin/env bash
# Deploy this repo to Embarko (https://docstar-agent.embarko.app) and wait until the new build is live.
#
#   npm run deploy            # from your Mac: deploys the working tree as it is
#   (CI)                      # .github/workflows/deploy.yml runs this on every push to main
#
# Token: $DEPLOY_TOKEN, else the first line of ~/.embarko/credentials.
# Embarko has no git integration: a deploy is an upload of a .tar.gz of the source. embarko.json's appId makes
# every upload replace the same app. Hosted data (DATA_DIR) survives; the database migrates itself on start.
set -euo pipefail

APP_NAME="${EMBARKO_APP_NAME:-docstar-agent}"
API="https://ship.embarko.ai"
LIVE_URL="https://${APP_NAME}.embarko.app"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TOKEN="${DEPLOY_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HOME/.embarko/credentials" ]]; then TOKEN="$(head -1 "$HOME/.embarko/credentials")"; fi
if [[ -z "$TOKEN" ]]; then echo "deploy: no Embarko token (set DEPLOY_TOKEN or ~/.embarko/credentials)" >&2; exit 1; fi

# Version = commit, marked -dirty when uncommitted changes are included, so the live copy says exactly what it runs.
VERSION="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then VERSION="${VERSION}-dirty-$(date +%Y%m%d%H%M%S)"; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/app.tar.gz"
tar -czf "$TARBALL" \
  --exclude=node_modules --exclude=.git --exclude=.github --exclude=.claude --exclude='.env*' \
  --exclude=data --exclude='*.db' --exclude='*.db-*' --exclude='*.log' --exclude=tests --exclude=docs \
  -C "$ROOT" .
echo "deploy: $APP_NAME version $VERSION ($(du -h "$TARBALL" | cut -f1))"

RESP="$(curl -sS --fail-with-body -X POST "$API/apps" \
  -H "X-App-Name: $APP_NAME" -H "X-Agent-Name: docstar-deploy" -H "X-App-Version: $VERSION" \
  --oauth2-bearer "$TOKEN" -F "source=@$TARBALL")" || { echo "deploy: upload failed: $RESP" >&2; exit 1; }
echo "deploy: uploaded: $(echo "$RESP" | head -c 300)"

# Wait for the build (server apps reply 202 "building").
for _ in $(seq 1 60); do
  STATUS="$(curl -sS "$API/apps/$APP_NAME/status" --oauth2-bearer "$TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status)}catch{console.log("unknown")}})')"
  case "$STATUS" in
    live) break ;;
    failed|crashed|not_deployed)
      echo "deploy: build $STATUS" >&2
      curl -sS "$API/apps/$APP_NAME/status" --oauth2-bearer "$TOKEN" >&2; echo >&2
      exit 1 ;;
  esac
  sleep 10
done
[[ "$STATUS" == live ]] || { echo "deploy: timed out waiting for live (last: $STATUS)" >&2; exit 1; }

# Confirm the new build answers, not the previous one still draining.
for _ in $(seq 1 30); do
  LIVE="$(curl -sS -m 10 "$LIVE_URL/api/version" 2>/dev/null || true)"
  if [[ "$LIVE" == *"\"$VERSION\""* ]]; then echo "deploy: live at $LIVE_URL ($VERSION)"; exit 0; fi
  sleep 5
done
echo "deploy: Embarko says live, but $LIVE_URL/api/version reports: ${LIVE:-no answer} (expected $VERSION)" >&2
exit 1
