#!/usr/bin/env bash
# Sends the committed code (HEAD) to the VPS as the lab, a second DFS beside
# production for trials (docs/DEPLOY.md, "The lab"), and starts it there. Run
# from the repository on the development PC, in Git Bash:
#
#   docker/deploy-lab.sh [ssh-host]   (default: dfs-vps)
#
# Production isn't stopped, rebuilt or changed: the lab is the Compose project
# `dfs-lab` in /opt/dfs-lab, with settings in /etc/dfs-lab (made once, by hand,
# as docs/DEPLOY.md says), and it only reads production's certificate.
set -euo pipefail

host=${1:-dfs-vps}
cd "$(git rev-parse --show-toplevel)"
if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo "[WARN] Uncommitted changes stay here: only HEAD is sent." >&2
fi
revision=$(git rev-parse --short HEAD)

echo "[INFO] Sending $revision to the lab on $host…"
ssh -o BatchMode=yes "$host" 'rm -rf /opt/dfs-lab.next && mkdir -p /opt/dfs-lab.next'
git archive --format=tar HEAD | ssh -o BatchMode=yes "$host" 'tar -x -C /opt/dfs-lab.next'
ssh -o BatchMode=yes "$host" bash -s -- "$revision" <<'REMOTE'
set -euo pipefail
next=/opt/dfs-lab.next
echo "$1" > $next/REVISION
ln -s /etc/dfs-lab/dfs.env $next/docker/.env

# Production's certificate for its domain (the lab's address without the port),
# copied out of its Caddy's volume, read-only, each time: production renews it.
domain=$(sed -n 's/^DFS_DOMAIN=\(.*\):[0-9]*$/\1/p' /etc/dfs-lab/dfs.env)
[[ -n $domain ]] || { echo "[ERROR] DFS_DOMAIN in /etc/dfs-lab/dfs.env needs a port." >&2; exit 1; }
install -d -m 700 /etc/dfs-lab/tls
docker run --rm --network none --entrypoint sh \
  -v dfs_caddy-data:/data:ro -v /etc/dfs-lab/tls:/out:Z postgres:18-alpine -c '
    set -e
    crt=$(ls /data/caddy/certificates/*/"$1"/"$1".crt | head -n 1)
    cp "$crt" /out/cert.pem
    cp "${crt%.crt}.key" /out/key.pem
    chmod 600 /out/cert.pem /out/key.pem' sh "$domain"

# Production's Caddyfile, with that certificate named in its site.
sed '/^{\$DFS_DOMAIN} {$/a\	tls /tls/cert.pem /tls/key.pem' $next/docker/Caddyfile > $next/docker/Caddyfile.lab
[[ $(grep -c '^[[:space:]]*tls /tls/cert.pem /tls/key.pem$' $next/docker/Caddyfile.lab) == 1 ]] ||
  { echo "[ERROR] Couldn't name the certificate in the lab's Caddyfile." >&2; exit 1; }

rm -rf /opt/dfs-lab.prev
if [[ -d /opt/dfs-lab ]]; then mv /opt/dfs-lab /opt/dfs-lab.prev; fi
mv $next /opt/dfs-lab
cd /opt/dfs-lab/docker
export DFS_VERSION=$1 DFS_DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
lab=(docker compose -p dfs-lab -f docker-compose.yml -f docker-compose.lab.yml)
# docker-compose.yml names itself `dfs`: make sure `-p` wins before touching anything.
[[ $("${lab[@]}" config | sed -n 's/^name: //p') == dfs-lab ]] ||
  { echo "[ERROR] The project isn't dfs-lab; nothing was started." >&2; exit 1; }
"${lab[@]}" up -d --build --remove-orphans
"${lab[@]}" ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
REMOTE
echo "[INFO] $revision runs in the lab on $host."
