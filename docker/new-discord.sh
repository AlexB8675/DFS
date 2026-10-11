#!/usr/bin/env bash
# Moves production to a new Discord server and bot, with an empty database
# (docs/DEPLOY.md, "A new Discord server or bot"). Run from the repository on
# the development PC, in Git Bash, once the new bot's token and the new
# server's ID are in the root .env and `pnpm dfs setup` has worked there:
#
#   docker/new-discord.sh --check [ssh-host]     look at everything, change nothing
#   docker/new-discord.sh [ssh-host]             do it (default host: dfs-vps)
#   docker/new-discord.sh wipe-old [ssh-host]    only wipe the old Discord server
#   docker/new-discord.sh drill [ssh-host]       only the recovery drill
#
# It shows what production holds, and goes on only when you type the phrase
# it asks for. Then, on the VPS:
#   1. `docker compose down`, first: the bot restarts by itself, and would
#      otherwise meet the new token or server ID with the old database
#   2. the token from .env goes to /etc/dfs/secrets/discord_bot_token, over
#      SSH's input and never shown; the old one stays as discord_bot_token.old
#   3. DISCORD_GUILD_ID in /etc/dfs/dfs.env is set (the old file is kept as
#      dfs.env.before-new-server)
#   4. the volumes dfs_postgres-data, dfs_staging and dfs_cache are removed;
#      Caddy's stay, with its certificate
#   5. docker/deploy.sh starts everything on the empty database
#   6. `dfs setup` makes the DFS category and its channels in the new server
#   7. it offers the owner account (its one-time password shows in your
#      terminal alone) and the recovery drill
#   8. last, and only if the new server answers: it lists what the OLD Discord
#      server still holds of DFS and, when you type a second phrase, deletes it
#      with the old bot (the `DFS`, `DFS Dev` and `DFS Review` categories and their
#      channels, so every file's data). That ends any way back to the old data. Nothing
#      else in the old server is touched, and the old server itself stays: a
#      bot can't delete a server, so that is yours to do in Discord.
# Safe to run again if it stops partway: each step copes with what is done.
set -euo pipefail

# The retired bot (a bot's user ID is its application's) and server. They are
# also what the wipe of the old server is tied to: it refuses any other bot,
# and only ever touches this server.
OLD_BOT_ID=1182273211262586910
OLD_GUILD_ID=1035095470428659723
APP=/opt/dfs/docker
DOMAIN=dfs.xlestudio.it

die() {
  echo "[ERROR] $*" >&2
  exit 1
}
info() { echo "[INFO] $*"; }

mode=run
case ${1:-} in
  --check)
    mode=check
    shift
    ;;
  drill)
    mode=drill
    shift
    ;;
  wipe-old)
    mode=wipe-old
    shift
    ;;
esac
host=${1:-dfs-vps}
# PowerShell's `bash` is WSL, which has no `dfs-vps` in its SSH config.
if grep -qi microsoft /proc/version 2>/dev/null; then
  die "This is WSL. Run it from Git Bash, in the repository."
fi
cd "$(git rev-parse --show-toplevel)"

remote() { ssh -o BatchMode=yes "$host" "$@"; }

live_guild() {
  remote "grep '^DISCORD_GUILD_ID=' /etc/dfs/dfs.env | cut -d= -f2" </dev/null || true
}

drill() {
  info "Running the recovery drill: it reads Discord and changes nothing…"
  remote "cd $APP && docker compose run --rm --no-deps -T \
    -v /etc/dfs/secrets/discord_bot_token:/run/secrets/dfs_discord_bot_token:ro \
    -e DISCORD_BOT_TOKEN_FILE=/run/secrets/dfs_discord_bot_token \
    api node apps/api/src/cli.ts drill --from discord"
}

# The old Discord server's DFS: `0` lists what is there, `1` deletes it. It
# runs on the VPS in a one-off container, so the old token never leaves it.
# The token is the saved old one, or the live one before the move; either way
# the code below refuses it unless it is the old bot's.
wipe_old_server() {
  local file
  file=$(remote '[ -s /etc/dfs/secrets/discord_bot_token.old ] && echo discord_bot_token.old || echo discord_bot_token' </dev/null)
  remote "cd $APP && docker compose run --rm --no-deps -T \
    -v /etc/dfs/secrets/$file:/run/secrets/old_bot_token:ro \
    -e TOKEN_FILE=/run/secrets/old_bot_token -e GUILD_ID=$OLD_GUILD_ID \
    -e EXPECT_BOT_ID=$OLD_BOT_ID -e APPLY=$1 \
    api node --input-type=module -" <<'JS'
import { readFile } from 'node:fs/promises'

const { TOKEN_FILE, GUILD_ID, EXPECT_BOT_ID, APPLY } = process.env
const token = (await readFile(TOKEN_FILE, 'utf8')).trim()
const CATEGORIES = new Set(['DFS', 'DFS Dev', 'DFS Review'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function call(method, route) {
  for (;;) {
    const response = await fetch(`https://discord.com/api/v10${route}`, {
      method,
      headers: { authorization: `Bot ${token}`, 'x-audit-log-reason': 'dfs moved to a new server' },
    })
    if (response.status === 429) {
      const { retry_after: wait = 1 } = await response.json().catch(() => ({}))
      await sleep(Math.ceil(wait * 1000) + 250)
      continue
    }
    if (response.status === 404 && method === 'DELETE') return null
    if (!response.ok) {
      throw new Error(`${method} ${route.replace(/\d{15,}/g, '…')}: Discord answered ${response.status}`)
    }
    return response.status === 204 ? null : response.json()
  }
}

const me = await call('GET', '/users/@me')
if (me.id !== EXPECT_BOT_ID) {
  console.error(`That token is ${me.username}'s, not the old bot's: nothing was touched.`)
  process.exit(2)
}
const channels = await call('GET', `/guilds/${GUILD_ID}/channels`)
const categories = channels.filter((c) => c.type === 4 && CATEGORIES.has(c.name))
const ids = new Set(categories.map((c) => c.id))
const inside = channels.filter((c) => c.parent_id && ids.has(c.parent_id))
const rest = channels.filter((c) => c.type !== 4 && !ids.has(c.parent_id ?? ''))

if (categories.length === 0) {
  console.log('  nothing of DFS is left in the old server')
} else {
  for (const category of categories) {
    const names = inside.filter((c) => c.parent_id === category.id).map((c) => `#${c.name}`)
    console.log(`  ${category.name}: ${names.join(', ') || 'no channels'}`)
  }
}
console.log(`  left alone: ${rest.length} other channel${rest.length === 1 ? '' : 's'}${rest.length ? ` (${rest.map((c) => '#' + c.name).join(', ')})` : ''}`)

if (APPLY === '1') {
  // The channels first, then their categories.
  for (const channel of [...inside, ...categories]) {
    await call('DELETE', `/channels/${channel.id}`)
    console.log(`  deleted ${channel.type === 4 ? channel.name : '#' + channel.name}`)
  }
}
JS
}

# Wipes the old server after listing it. Never while production still uses it.
wipe_old_with_phrase() {
  local now
  now=$(live_guild)
  [[ -n $now && $now != "$OLD_GUILD_ID" ]] \
    || die "Production still uses the old server, or its settings can't be read: this would delete its storage."
  remote '[ -s /etc/dfs/secrets/discord_bot_token.old ] && ! cmp -s /etc/dfs/secrets/discord_bot_token /etc/dfs/secrets/discord_bot_token.old' </dev/null \
    || die "The saved old token is missing, or is the same as the live one: not touching Discord."
  info "What the old server ($OLD_GUILD_ID) holds of DFS:"
  wipe_old_server 0 || die "Couldn't look at the old server (see above)."
  echo
  echo "Deleting these is final: the old files can never be recovered, which is the point,"
  echo "and also the end of any way back to them. The move itself only proves the API, the"
  echo "database and the channels in the new server, not an upload or a download through the"
  echo "new bot. If you haven't done both on production, the careful order is: Enter here,"
  echo "one upload and download, docker/new-discord.sh drill, then docker/new-discord.sh wipe-old."
  read -r -p 'Type "wipe old server" to delete them, Enter to keep them: ' phrase
  if [[ $phrase != "wipe old server" ]]; then
    info "Left as it is. Later: docker/new-discord.sh wipe-old"
    return 0
  fi
  wipe_old_server 1
  remote 'rm -f /etc/dfs/secrets/discord_bot_token.old /etc/dfs/dfs.env.before-new-server' </dev/null
  info "The old server's DFS is gone, and so are the saved old token and settings."
  OLD_WIPED=1
}

OLD_WIPED=0

if [[ $mode == drill ]]; then
  drill
  exit 0
fi

if [[ $mode == wipe-old ]]; then
  remote true </dev/null || die "Can't reach $host over SSH."
  wipe_old_with_phrase
  exit 0
fi

# --- What is in .env ---------------------------------------------------------

[[ -f .env ]] || die "There is no .env in $(pwd)."

# One value from .env, without quotes or a line ending. Nothing is shown.
env_value() {
  local line
  line=$(grep -E "^[[:space:]]*$1=" .env | tail -n 1 || true)
  line=${line#*=}
  line=${line%$'\r'}
  line=${line#[\"\']}
  line=${line%[\"\']}
  printf '%s' "$line"
}

token=$(env_value DISCORD_BOT_TOKEN)
guild=$(env_value DISCORD_GUILD_ID)
[[ -n $token ]] || die "DISCORD_BOT_TOKEN isn't set in .env."
[[ $guild =~ ^[0-9]{17,20}$ ]] || die "DISCORD_GUILD_ID in .env isn't a Discord ID."
[[ $guild != "$OLD_GUILD_ID" ]] || die "DISCORD_GUILD_ID in .env is still the old server's."

# --- Does Discord accept them? -----------------------------------------------

info "Asking Discord about the bot and the server…"
if ! answer=$(DISCORD_BOT_TOKEN=$token DISCORD_GUILD_ID=$guild node --input-type=module -e '
const headers = { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
const ask = async (route, what) => {
  const response = await fetch(`https://discord.com/api/v10${route}`, { headers })
  if (!response.ok) {
    console.error(`${what}: Discord answered ${response.status}`)
    process.exit(1)
  }
  return response.json()
}
const bot = await ask("/users/@me", "The token")
const guild = await ask(`/guilds/${process.env.DISCORD_GUILD_ID}`, "The server")
console.log(bot.id)
console.log(bot.username)
console.log(guild.name)
'); then
  die "Discord refused the token, or the bot isn't in that server (see above)."
fi
mapfile -t found <<<"${answer//$'\r'/}"
bot_id=${found[0]}
bot_name=${found[1]}
guild_name=${found[2]}
[[ $bot_id != "$OLD_BOT_ID" ]] || die "The token in .env is still the old bot's."

# --- What production holds now ----------------------------------------------

info "Looking at production ($host)…"
remote true </dev/null || die "Can't reach $host over SSH."
current_guild=$(live_guild)
revision=$(remote 'cat /opt/dfs/REVISION' </dev/null || true)
sql="select 'users', count(*) from users union all select 'files', count(*) from nodes where kind = 'file' union all select 'blobs', count(*) from blobs"
counts=$(remote "cd $APP && docker compose exec -T postgres psql -U dfs dfs -At -F ' ' -c \"$sql\"" \
  </dev/null 2>/dev/null || echo "(the database isn't running)")
counts=$(tr '\n' ';' <<<"${counts//$'\r'/}")

echo
echo "  new bot:       $bot_name ($bot_id)"
echo "  new server:    $guild_name ($guild)"
echo "  production:    $host, now on server ${current_guild:-unknown}, revision ${revision:-unknown}"
echo "  this checkout: $(git rev-parse --short HEAD), which deploy.sh sends"
echo "  its database:  $counts"
echo

if [[ $mode == check ]]; then
  info "What the old server ($OLD_GUILD_ID) holds of DFS, which the last step can delete:"
  wipe_old_server 0 || echo "[WARN] Couldn't look at the old server (see above)." >&2
  echo
  info "Nothing was changed."
  exit 0
fi

if [[ $current_guild == "$guild" ]]; then
  echo "[WARN] Production already uses this server. Going on empties what it holds since." >&2
fi
echo "This deletes production's database, staging and cache, and moves it to the server"
echo "above. The old Discord server and bot are not touched yet: that is asked about last."
read -r -p 'Type "wipe production" to go on: ' phrase
[[ $phrase == "wipe production" ]] || die "Nothing was changed."

# --- On the VPS --------------------------------------------------------------

info "Stopping DFS (its volumes stay until step 4)…"
remote "cd $APP && docker compose down" </dev/null

info "Replacing the bot token, which stays as discord_bot_token.old…"
remote 'cd /etc/dfs/secrets && { [ -e discord_bot_token.old ] || cp -p discord_bot_token discord_bot_token.old; }' </dev/null
printf '%s\n' "$token" | remote 'umask 077; cat > /etc/dfs/secrets/discord_bot_token'
remote bash -s <<'REMOTE'
set -euo pipefail
cd /etc/dfs/secrets
chown 1000:1000 discord_bot_token discord_bot_token.old
chmod 400 discord_bot_token discord_bot_token.old
restorecon -Rv /etc/dfs/secrets >/dev/null 2>&1 || true
ls -lZ discord_bot_token discord_bot_token.old
REMOTE

info "Setting the server ID and removing the old database, staging and cache…"
remote bash -s -- "$guild" <<'REMOTE'
set -euo pipefail
guild=$1
env=/etc/dfs/dfs.env
[ -e "$env.before-new-server" ] || cp -p "$env" "$env.before-new-server"
if grep -q '^DISCORD_GUILD_ID=' "$env"; then
  sed -i "s/^DISCORD_GUILD_ID=.*/DISCORD_GUILD_ID=$guild/" "$env"
else
  printf 'DISCORD_GUILD_ID=%s\n' "$guild" >>"$env"
fi
grep '^DISCORD_GUILD_ID=' "$env"
for volume in dfs_postgres-data dfs_staging dfs_cache; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume rm "$volume"
  else
    echo "$volume was already gone"
  fi
done
REMOTE

info "Deploying onto the empty database…"
docker/deploy.sh "$host"

# What the volumes' removal was for: an old database coming back up beside the
# new server's channels would be a mixed state, found out only later.
info "Checking that the database is empty…"
fresh=""
for _ in $(seq 1 24); do
  fresh=$(remote "cd $APP && docker compose exec -T postgres psql -U dfs dfs -At -c \"select (select count(*) from users) + (select count(*) from blobs) + (select count(*) from storage_channels)\"" \
    </dev/null 2>/dev/null || true)
  [[ -n $fresh ]] && break
  sleep 5
done
fresh=${fresh//$'\r'/}
[[ $fresh == 0 ]] \
  || die "Production's database isn't empty (${fresh:-no answer}). Not making channels beside the old ones: look at it first."

info "Making the DFS category and its channels in the new server…"
remote "cd $APP && docker compose run --rm -T bot node apps/api/src/cli.ts setup" </dev/null

# --- Does it work? -----------------------------------------------------------

info "Waiting for https://$DOMAIN/api/health…"
healthy=0
for _ in $(seq 1 24); do
  if curl -fsS --max-time 10 "https://$DOMAIN/api/health"; then
    healthy=1
    echo
    break
  fi
  sleep 5
done
if [[ $healthy == 0 ]]; then
  echo "[WARN] The API didn't answer yet. Look: ssh $host 'cd $APP && docker compose logs --tail 50 api bot'" >&2
fi

info "Channels production has registered:"
remote "cd $APP && docker compose exec -T postgres psql -U dfs dfs -At -c \"select name, kind from storage_channels order by name\"" </dev/null
info "The bot's last lines:"
remote "cd $APP && docker compose logs --no-log-prefix --tail 12 bot" </dev/null

# --- The owner and the drill -------------------------------------------------

echo
read -r -p 'Username for the owner account (empty to skip): ' owner
if [[ -n $owner ]]; then
  if [[ $owner =~ ^[A-Za-z0-9._-]+$ ]]; then
    ssh -t -o BatchMode=yes "$host" "cd $APP && docker compose run --rm api node apps/api/src/cli.ts owner --username $owner" \
      || echo "[WARN] The owner account wasn't made: ssh $host, then docker compose run --rm api node apps/api/src/cli.ts owner --username <name>" >&2
  else
    echo "[WARN] Not made: this script takes letters, digits, . _ - only. By hand: ssh $host, then docker compose run --rm api node apps/api/src/cli.ts owner --username <name>" >&2
  fi
fi

read -r -p 'Run the recovery drill now? It may show the newest records as missing until the bot has flushed its journal. [y/N] ' answer
if [[ $answer == [yY]* ]]; then
  # It exits 1 when the rebuilt database differs; that mustn't end the run here.
  drill || echo "[WARN] The drill found differences, as it can this soon. Run docker/new-discord.sh drill again in a minute." >&2
else
  info "Later: docker/new-discord.sh drill"
fi

# --- The old server ----------------------------------------------------------

echo
if [[ $healthy == 1 ]]; then
  wipe_old_with_phrase
else
  echo "[WARN] The new setup didn't answer, so the old server is left alone: it is the way back."
  echo "       Once it works: docker/new-discord.sh wipe-old"
fi

echo
info "Production runs on $guild_name with $bot_name."
echo "Left to do:"
if [[ $OLD_WIPED == 1 ]]; then
  echo "  - delete the old Discord server (Server Settings → Delete Server: a bot can't) and"
  echo "    reset the old application's token in the Developer Portal."
else
  echo "  - when it has run cleanly for a few days: docker/new-discord.sh wipe-old, then delete the"
  echo "    old Discord server (Server Settings → Delete Server) and reset the old application's"
  echo "    token in the Developer Portal. Until then the old server's journal and the master key"
  echo "    can still rebuild the old database (dfs recover --into, docs/DEPLOY.md)."
fi
