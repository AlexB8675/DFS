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

Only committed code goes; the script warns about anything uncommitted. The
commit's short hash is the deploy's version, built into the images with the
time (`DFS_VERSION`, `DFS_DEPLOYED_AT`): pages opened before reload or offer to,
Settings shows it, and Admin → System shows the API's and the bot's. Images
built by hand with `docker compose up --build` say `dev`, which turns the
pages' version check off. Migrations run on their own before the API and the
bot start again. To go back, deploy the earlier commit (`git checkout
<commit>`, then `docker/deploy.sh`): older code runs on a newer database only
when the migrations since added things. 0019 (`0c14ae7`) and 0020 (`361410b`)
dropped columns and states, so code from before them can't.

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

## Recovery drill and recovery

`dfs drill` rebuilds the database from `#dfs-journal` and the master key
alone, into a scratch database it drops afterwards, and says how it differs
from the one in use (DESIGN §8). It only reads Discord. It needs both the
master key, which only the API has, and the bot token, which only the bot
has, so it runs in a one-off API container given the token too:

```bash
docker compose run --rm --no-deps -T \
  -v /etc/dfs/secrets/discord_bot_token:/run/secrets/dfs_discord_bot_token:ro \
  -e DISCORD_BOT_TOKEN_FILE=/run/secrets/dfs_discord_bot_token \
  api node apps/api/src/cli.ts drill --from discord
```

## Starting storage over

`dfs reset-storage` deletes every file, with its blobs, the storage
channels on Discord (every message in them) and the journal, and keeps the
accounts, folders, links to folders and the audit log. It then starts the
journal again from what it kept, so `dfs drill` still rebuilds everything,
and makes the channels again with `dfs setup`'s names. It can't be undone.
It takes the database's instance ID (`SELECT id FROM instance`), refuses
while the API or the bot is running, and can be run again if it fails
partway. Like the drill, it runs in a one-off API container given the bot
token, which reaches staging and the frame cache too:

```bash
docker compose stop api bot
docker compose run --rm --no-deps -T \
  -v /etc/dfs/secrets/discord_bot_token:/run/secrets/dfs_discord_bot_token:ro \
  -e DISCORD_BOT_TOKEN_FILE=/run/secrets/dfs_discord_bot_token \
  api node apps/api/src/cli.ts reset-storage --instance <id>
docker compose start api bot
```

Once the bot has posted the new journal, `dfs drill` should find nothing
different. In development: `pnpm dfs reset-storage --instance <id>`, with
the API and the bot stopped.

After losing the VPS: set it up again as above (the same `DISCORD_GUILD_ID`,
category and master key file), stop the API and the bot, recover into the
new, empty database with `recover --into <database-url>` in the same kind of
container, check the report, then start them. `--key-file` takes a file with
every master key, current and retired.
