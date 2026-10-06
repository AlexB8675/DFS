# Deploying DFS

How DFS runs on its VPS (DESIGN.md §3.2, §13.2), from an empty server to the
first sign-in, and how it is updated. Commands run on the VPS as root (`ssh
dfs-vps`), from `/opt/dfs/docker`, unless they say they run on the
development PC.

| What | Where |
|---|---|
| Server | Contabo VPS, Fedora 43, 6 cores, 11 GB, 100 GB disk, `62.171.147.12` |
| Name | `dfs.xlestudio.it`: an **A** record to the VPS. No AAAA record yet: through Docker, IPv6 visitors would all seem to come from one address, which weakens the sign-in limits |
| SSH | `dfs-vps` in the development PC's `~/.ssh/config`: root, with the key in `D:\Docs\SSH\Contabo` |
| Code | `/opt/dfs`: the committed code, sent from the development PC by `docker/deploy.sh` (`REVISION` says which commit). The one before is kept as `/opt/dfs.prev` |
| Settings | `/etc/dfs/dfs.env` (from `docker/.env.example`), linked as `/opt/dfs/docker/.env` |
| Secrets | `/etc/dfs/secrets`, one value per file; the master key's copy is on the development PC in `D:\Docs\DFS\master_key` |
| Data | Docker volumes: `dfs_postgres-data`, `dfs_staging`, `dfs_cache`, `dfs_caddy-data`, `dfs_caddy-config` |

The server serves other uses too, so DFS adds only Docker and two ports, 80
and 443, for Caddy. The hardening of DESIGN §13.2 (firewalld, SSH keys only,
automatic updates) is left out by the owner's choice.

## 1. Docker

Docker Engine and its Compose plugin, from Docker's own repository:

```bash
dnf -y install dnf-plugins-core policycoreutils-python-utils
dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

## 2. Settings

`/etc/dfs/dfs.env`, from `docker/.env.example`: `DFS_DOMAIN=dfs.xlestudio.it`,
`DFS_SECRETS=/etc/dfs/secrets`, and `DISCORD_GUILD_ID` (the Discord server,
the same as in development's `.env`). The sizes fit the 100 GB disk. It is
outside the code, so each deployment replaces the code whole and keeps it.

## 3. Secrets

Five files, each readable only by the container that uses it: uid 1000 for the
API and the bot, 70 for PostgreSQL. Generated on the server, except the bot's
token and the master key.

```bash
install -d -m 700 /etc/dfs/secrets
cd /etc/dfs/secrets
umask 077
password=$(openssl rand -hex 24)
printf '%s\n' "$password" > postgres_password
printf 'postgres://dfs:%s@postgres:5432/dfs\n' "$password" > database_url
openssl rand -hex 32 > internal_rpc_secret
unset password
```

- **`discord_bot_token`**: the bot's token, the same bot as development's
  (D25), piped from the development PC's `.env` without being shown:
  `grep '^DISCORD_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '\r' | ssh dfs-vps
  'umask 077; cat > /etc/dfs/secrets/discord_bot_token'`.
- **`master_key`**: made once on the development PC with `pnpm dfs master-key
  D:/Docs/DFS/master_key`, and copied here with `scp`. Keep that copy safe and
  off the server: **without it, no file can ever be read again**, and a new key
  can't read the old files.

Then their owners, and the SELinux label containers may read:

```bash
chown 1000:1000 database_url internal_rpc_secret discord_bot_token master_key
chown 70:70 postgres_password
chmod 400 *
semanage fcontext -a -t container_file_t '/etc/dfs/secrets(/.*)?'
restorecon -Rv /etc/dfs/secrets
```

## 4. First start

From the development PC, in Git Bash, with what is committed:

```bash
docker/deploy.sh
```

It sends the code to the server, links the settings, builds the images there
and starts DFS, then lists the services.

`migrate` runs once and exits 0; the others are `healthy`. Caddy gets its
certificate once the name resolves everywhere, and keeps trying until then.
That can lag the DNS record by up to an hour: a name looked up before its
record existed is remembered as missing for as long as the zone says (an hour
for `xlestudio.it`), and Let's Encrypt checks from several places. Check from
anywhere:

- `https://dfs.xlestudio.it/api/health` answers `{"status":"ok","database":"ok"}`.
- `https://dfs.xlestudio.it/internal/health` answers 404.

## 5. Discord and the first account

The `DFS` category and its channels, private to the bot, registered for
storage (§4). Production's are new; the old channel outside any category
stays unused.

```bash
docker compose run --rm bot node apps/api/src/cli.ts setup
```

The owner account, with a temporary password it prints once. Run it yourself:

```bash
docker compose run --rm api node apps/api/src/cli.ts owner --username <name>
```

Sign in at `https://dfs.xlestudio.it` and choose a password. In Admin →
System, every secret shows as set, and the Discord card shows the `DFS`
category with its channels.

## Updating

On the development PC, after `pnpm check` and a commit (D26):

```bash
docker/deploy.sh
```

Only committed code goes; the script warns about anything uncommitted.
Migrations run on their own before the API and the bot start again. To go back,
deploy the earlier commit (`git checkout <commit>`, then `docker/deploy.sh`):
migrations only add, so older code runs on a newer database unless a release
says otherwise.

## Looking after it

- **Logs:** `docker compose logs -f api` (or `bot`, `caddy`, `postgres`).
  They rotate at 10 MB, five files per service.
- **Disk:** `df -h /` and `docker system df`. Staging is capped at
  `STAGING_MAX_BYTES` and the cache at `CACHE_MAX_BYTES`; old images go with
  `docker image prune`.
- **Database by hand:** `docker compose exec postgres psql -U dfs dfs`.
- **Backups** of the database and the journal come with M4. Until then, the
  master key's copy off the server is what matters most, with a dump now and
  then: `docker compose exec postgres pg_dump -U dfs -Fc dfs > dfs.dump`.
- **Stopping:** `docker compose down` keeps every volume; `down -v` would
  delete the database and staging.
