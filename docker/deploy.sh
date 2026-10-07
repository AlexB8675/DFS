#!/usr/bin/env bash
# Sends the committed code (HEAD) to the VPS and starts it there (docs/DEPLOY.md).
# Run from the repository on the development PC, in Git Bash:
#
#   docker/deploy.sh [ssh-host]      (default: dfs-vps, from ~/.ssh/config)
#
# The server's copy is replaced whole, so nothing deleted here lingers there:
# the new one goes to /opt/dfs.next, then takes /opt/dfs's place, and the one
# before is kept as /opt/dfs.prev. Settings (/etc/dfs/dfs.env), secrets and
# data (Docker volumes) live outside it, and stay.
set -euo pipefail

host=${1:-dfs-vps}
cd "$(git rev-parse --show-toplevel)"
if [[ -n $(git status --porcelain) ]]; then
  echo "[WARN] Uncommitted changes stay here: only HEAD is sent." >&2
fi
revision=$(git rev-parse --short HEAD)

echo "[INFO] Sending $revision to $host…"
ssh -o BatchMode=yes "$host" 'rm -rf /opt/dfs.next && mkdir -p /opt/dfs.next'
git archive --format=tar HEAD | ssh -o BatchMode=yes "$host" 'tar -x -C /opt/dfs.next'
ssh -o BatchMode=yes "$host" bash -s -- "$revision" <<'REMOTE'
set -euo pipefail
echo "$1" > /opt/dfs.next/REVISION
ln -s /etc/dfs/dfs.env /opt/dfs.next/docker/.env
rm -rf /opt/dfs.prev
if [[ -d /opt/dfs ]]; then mv /opt/dfs /opt/dfs.prev; fi
mv /opt/dfs.next /opt/dfs
cd /opt/dfs/docker
# Built into the images: every API answer and the web app carry them.
export DFS_VERSION=$1 DFS_DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose up -d --build --remove-orphans
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
REMOTE
echo "[INFO] $revision runs on $host."
