# DFS — Discord File System
### Design Document · living spec

| | |
|---|---|
| **Status** | Built, and running in production at `https://dfs.xlestudio.it` (§18.1 says what is done and what isn't). This is the spec the code follows, and it changes with the code; anything described here that isn't built yet says so where it appears. Decisions are in §19 (D1–D41; D38–D41, planned on 2026-10-11, aren't built yet). The build plan that recorded how each part was built and checked, `docs/BACKEND.md`, was retired on 2026-10-11 once the backend was done; its last version is `git show 156804a:docs/BACKEND.md` |
| **Date** | Written 2026-10-04; last revised 2026-10-11 |
| **Stack** | TypeScript everywhere: React + Fastify + discord.js + PostgreSQL 18 |
| **Deployment** | Docker Compose on **one Fedora Linux VPS**. Only the web UI (Caddy edge) is public; API, bot, and DB sit on an internal Docker network (§3.2, §13) |
| **Development** | Locally on Windows: Node 24 + pnpm, with Postgres in Docker Desktop (§13.1) |
| **Chunk size** | `CHUNK_SIZE` = 20 MiB − 128 KiB, under the 20 MiB Discord attachment limit (unboosted server, §2, D1, D10) |
| **Scale target** | Few users, **many files** (millions of nodes, multiple TB). Designed to scale horizontally where it matters (§12) |

---

## 1. Overview

DFS turns a private Discord server into the **blob storage layer** of a personal cloud drive. Files are split into chunks, encrypted, and posted as message attachments in dedicated storage channels. Small files are **packed together** so that one Discord message can hold hundreds of them. A PostgreSQL database holds the real file system: the folder tree, file names, versions, and a map of which byte range of which Discord attachment holds which piece of which file. A React web app gives a small group of trusted users a familiar "Google Drive"-style interface.

The core idea is that **Discord stores opaque encrypted bytes, and Postgres stores meaning.** Renaming, moving, and organizing files only touch metadata. Discord is involved only when bytes are written, read, or garbage-collected.

### 1.1 Goals

- **G1:** Store files of any size by chunking them below Discord's attachment limit.
- **G2:** Give a hierarchical file system (folders, rename, move, trash, versions) through a web UI.
- **G3:** Support multiple users (friends/family) with separate private drives, quotas, and an admin role.
- **G4:** Encrypt everything at rest in Discord (AES-256-GCM). Discord only ever sees random-looking `.bin` blobs.
- **G5:** Make uploads resumable and parallel, and support streaming downloads with HTTP `Range` (so video can be scrubbed and big downloads can resume).
- **G6:** Keep data durable: check every frame read back for damage or tampering, and be able to **rebuild the database from Discord** if it is lost.
- **G7:** **Scale to millions of files** without making the number of Discord messages, the database, or the UI the bottleneck (§12).
- **G8:** Make it easy to self-host with one `docker compose up` on Fedora, and easy to develop locally on Windows.

### 1.2 Non-Goals (v1)

- End-to-end / zero-knowledge encryption. The server holds the keys in v1 (see §7.4 for the future path). Locked folders (§7.7, planned) are sealed with a code at rest, not end to end.
- Mounting as a native drive over SMB, or with a client of DFS's own (FUSE). The drive is planned to mount over WebDAV (§6.8, D39), which every system's own client and rclone speak.
- **Two-way sync** with a computer (D40). The planned desktop app backs up one way, from the computer to the drive (§6.9).
- Real-time collaborative editing, office-document previews.
- **Version history** (D33, D42). A file has only its current version: replacing it deletes what it replaced at once, and the file's share links with it (§7.5); there is nothing to browse or restore. Backups included (D40): a file the backup app replaces is replaced.
- Content deduplication across users.
- Public sign-up / multi-tenant SaaS.
- Server-side **copy** of files or folders (D3). Users download and re-upload instead.
- **Mirroring** to a second blob store (D5). Discord is the only blob store, and the risk is accepted (§2).
- **Thumbnails** (D13). The grid shows file-type icons in v1. The planned design: the API generates a small WebP for each image version and stores it as one extra encrypted frame of that version, packed like a small file and not journaled (it can be regenerated). AAD type `0x02` is reserved for it (§7.3), so adding thumbnails later needs no frame-format change.

---

## 2. Constraints & Risks

> [!WARNING]
> **Discord Terms of Service.** Using Discord as a general-purpose file store is outside its intended use and may break the Developer Policy or ToS. Discord could delete messages, disable the bot, or ban the account or server **without warning**. DFS must be treated as a *secondary* storage tier, never as the only copy of irreplaceable data. The design includes mitigations (journal, DB backups, integrity scrubbing), but none of them can protect against Discord deleting the server.

| Constraint | Impact on design |
|---|---|
| **Attachment size limit: 20 MiB** (unboosted server, D1) | Every blob (one attachment) is at most **`BLOB_MAX_BYTES` = 20 MiB − 64 KiB**, leaving headroom for multipart overhead. This is a hard cap, checked before every upload. Large files are split into chunks of **`CHUNK_SIZE` = 20 MiB − 128 KiB**, so a chunk in its frame (about 2.2 KB more, §7.3) always fits (D10). Each file version records its own chunk size, so files stored under the earlier 10 MiB limit keep working, as would any if the limit changes again. A 1 GiB file is 52 messages. |
| **Lots of small files** (D7) | One message per small file would make Discord rate limits the bottleneck. Small files are **packed** into shared blobs of about 20 MiB (§6.6). For example, 100k files of 100 KB become about 500 messages instead of 100,000. |
| **Up to 10 attachments per message** | v1 uses **1 blob per message** for simple addressing, retries, and deletion. Packing (above) already gives the message-count savings. |
| **Rate limits** (per-route buckets plus a global per-bot limit, learned from response headers) | Uploads are spread across a **pool of storage channels**, run through a job queue, and use backoff on `429`. |
| **CDN URLs expire** (signed `ex`/`is`/`hm` query params, roughly 24 h) | We store **`channel_id` + `message_id` + `attachment_id`**, never just the URL. URLs are refreshed on demand (`POST /attachments/refresh-urls`, 50 per request) and cached until they expire. |
| **Bulk delete only works on messages < 14 days old** | Garbage collection deletes messages one at a time, slowly and rate-limited, in the background. |
| **Anyone with Manage Messages can delete blobs** | Only the bot reaches DFS's channels (D31): the category is private to it, and no one else is given access. So no message is deleted but by DFS itself, and DFS doesn't watch for deletions. |
| **Throughput** | Bounded by rate limits and bandwidth, not CPU. Expect "backup drive" speeds, not "SSD" speeds. Files are **readable from staging as soon as the upload finishes**, before they reach Discord (§6.1), so the user doesn't have to wait for the background sync. |

---

## 3. High-Level Architecture

```mermaid
flowchart LR
    subgraph Client["Internet"]
        WEB["Browser<br/>React SPA"]
    end

    subgraph VPS["Fedora VPS · Docker Compose"]
        subgraph Edge["Public edge (ports 80/443 only)"]
            PROXY["Caddy<br/>TLS + static SPA<br/>route allowlist"]
        end
        subgraph Core["Internal network (no published ports)"]
            API["API Service ×N<br/>Fastify + TS<br/>auth, metadata, crypto"]
            BOT["Bot Service ×1 (leader)<br/>discord.js<br/>packer, uploader, GC"]
            PG[("PostgreSQL 18<br/>metadata + pg-boss queue")]
            STAGE[["Staging volume<br/>encrypted frames/blobs only"]]
            CACHE[["Frame cache<br/>LRU, encrypted"]]
            MEDIA["Media ×1<br/>ffmpeg, no secrets<br/>probe, subtitles"]
        end
    end

    subgraph Discord
        GUILD["Private Discord Server<br/>#storage-00..N<br/>#dfs-journal<br/>#dfs-backups<br/>#dfs-log"]
        CDN["Discord CDN"]
    end

    WEB -- "HTTPS" --> PROXY
    PROXY -- "/api/*" --> API
    API <--> PG
    BOT <--> PG
    API -- writes ciphertext --> STAGE
    BOT -- "packs + reads ciphertext" --> STAGE
    API -- "internal RPC<br/>(refresh URLs)" --> BOT
    BOT -- "outbound REST + Gateway" --> GUILD
    API -- "outbound GET (Range)" --> CDN
    API <--> CACHE
    API <-->|"plaintext of one file, segments"| MEDIA
```

### 3.1 Services

| Service | Tier | Replicas | Responsibility | Holds secrets |
|---|---|---|---|---|
| **edge (Caddy)** | Public | 1 | TLS termination, serves the static React build (including client-side routes such as the share page `/s/:token`), and reverse-proxies **only `/api/*`** to the API. It is the **only** container that publishes ports. | TLS certs |
| **api** | Internal | 1…N (stateless) | HTTP API, authentication, sessions, the file-system metadata (tree operations), upload sessions, **encryption/decryption**, download streaming, share links, live events (SSE fed by Postgres `LISTEN/NOTIFY`). Enqueues jobs, and runs the background job that needs keys: `journal.flush` (`backup.snapshot` and DEK re-wrapping would too, and aren't built, §8, §7.3). | `MASTER_KEY` |
| **bot** | Internal | 1 active (+ optional standby) | The only process with the Discord token. **Packs** small-file frames into blobs, uploads and deletes blobs, compacts packs, refreshes CDN URLs, and answers `/dfs setup` (§11). **Outbound-only** network access to Discord. It never sees keys or plaintext. | `DISCORD_BOT_TOKEN` |
| **postgres** | Internal | 1 | Metadata, sessions, audit log, journal outbox, and the job queue (**pg-boss**, so no Redis is needed). | — |
| **media** | Internal | 1 | Examines audio and video files, and extracts subtitles and cover art (ffmpeg, §6.7). Reaches nothing but the API, its only client. | — (a token per file, from the API) |

**Why the bot and API are split:** the two most sensitive secrets live in different processes. The bot never sees plaintext or keys; it only moves and concatenates ciphertext. The API never talks to Discord's API directly, so all rate-limit state lives in one place. Both import shared packages that define the frame format and the job contracts. The media service is split off for the same reason: ffmpeg parses files anyone with an account uploads, so it runs where a flaw in it reaches no secret (§6.7).

### 3.2 Network topology & exposure

The deployment is a **single Fedora VPS** (D6). The browser still has to reach the API, so "internal" means the API is **never directly addressable from the internet**: every request goes through Caddy, which forwards it over the internal Docker network.

```mermaid
flowchart LR
    I(("Internet")) -->|"80/443 (TCP)"| E["caddy"]
    subgraph dfs_internal["Docker network: dfs_internal (internal: true)"]
        A["api :3000"]
        B["bot :3001 (internal RPC)"]
        P["postgres :5432"]
    end
    subgraph dfs_media["Docker network: dfs_media (internal: true)"]
        M["media :3002"]
    end
    E -->|dfs_internal| A
    A --- B
    A --- P
    B --- P
    A ---|dfs_media| M
    B -.->|"egress network, outbound 443"| D["discord.com / gateway / CDN"]
    A -.->|"egress network, outbound 443"| D
```

- Four Docker networks: `internal` (`internal: true`, no internet, the fixed subnet `10.73.0.0/24`) for service-to-service traffic, `egress` for outbound Discord access (and the API's check of the internet, §16), `edge` for Caddy, which publishes ports there and reaches Let's Encrypt (a container on an internal network alone can publish no port), and `media` (`internal: true`) for the API and the media service alone. Only `api` and `bot` join `egress`, and only `caddy` publishes ports. `media` joins its own network alone, so ffmpeg, which parses uploads, reaches the API and nothing else: not Postgres, the bot or Caddy (§6.7). Postgres has no route to the internet at all.
- **Route allowlist at the edge:** only `/api/*` is proxied to the API. Every other path is answered from the static SPA build, and unknown paths fall back to `index.html` so client-side routes such as `/s/:token` (public share pages) work. `/internal/*` and metrics paths get an explicit `404`. Nothing else reaches a backend service.
- **Streaming:** request and response buffering is disabled for uploads (`/api/uploads/*/content`, a whole file in one request, and `/api/uploads/*/parts/*`), the content and archive routes (`/api/files/*/content`, `/api/s/*/files/*/content`, `*/archive`), and `/api/events` (SSE). The body size limit is **22 MiB** (one part plus headroom; a test checks it against the chunk size), except for a file streamed whole, whose length the API checks against its upload. Download and SSE routes have long timeouts; an upload may stall for a minute (Caddy's `read_body_idle`) before Caddy cuts it.
- **Client IP:** the API trusts `X-Forwarded-For` **only** from the Caddy container's address, fixed at `10.73.0.10` on the internal network (`TRUSTED_PROXY_CIDRS=10.73.0.10/32`), for rate limiting and audit logs.
- **Share links** use the public URL (`PUBLIC_BASE_URL`), and the sign-in route checks `Origin` against it (§7.1).
- *Planned:* WebDAV at `/dav/*` (§6.8) is a second route to the API, with no body limit, unbuffered, and `OPTIONS /` with it, for Windows' probe of the site's root; `/downloads/`, the desktop app's installer and updates, is served by Caddy itself from a volume (§6.9).
- *Later, optional:* the same images can be split across two hosts (edge on the VPS, core elsewhere over WireGuard/Tailscale) with `docker-compose.edge.yml` / `docker-compose.core.yml`. This is not built in v1.

---

## 4. Discord Server Layout

```
📁 DFS (category, private: only the bot can view it, D31)
 ├─ #storage-00   ┐
 ├─ #storage-01   │ data channels: blobs are spread across the least-loaded channel
 ├─ #storage-02   │ (default 4; more can be added at runtime)
 ├─ #storage-03   ┘
 ├─ #dfs-journal     encrypted metadata journal batches (for disaster recovery, §8)
 ├─ #dfs-backups     snapshot pointers, each with an encrypted manifest (the dumps are DFS files, §8). Made, and empty: snapshots aren't built
 └─ #dfs-log         human-readable bot events and alerts (nothing posts there yet)
```

- **Permissions:** `@everyone` is denied View Channel on the category. The bot role gets View, Send Messages, Attach Files, Read Message History, and Manage Messages, plus Manage Channels and Manage Roles while `dfs setup` creates the category and sets its permissions (they can be removed afterwards). No one else is given access to the category (D31).
- **Bootstrap:** `/dfs setup` (or `dfs setup` in the CLI) creates the category and channels if they are missing, then registers them in the `storage_channels` table.
- **Environments (D25):** development shares the server and the bot with production. Production uses the `DFS` category, development a `DFS Dev` category (`DISCORD_CATEGORY_NAME`). Each environment registers only its own channels in its own `storage_channels`, and everything that reads or deletes messages (reconciler, scrubber, GC, recovery) works only in registered channels, so neither can take the other's messages for orphans. Three more guards back that up: a channel registered by hand on Admin → Storage must be a text channel inside this environment's category (the bot checks, and makes it private); the bot posts new blobs, and the reconciler reads history, only in registered channels that are inside that category in Discord, so a channel registered by mistake or moved out keeps its blobs readable but gets no more (the reconciler looks each time it runs; for posting, the bot lists the server's channels once, and again only when a channel is registered, since Discord allows 10 listings a minute and channels move only by hand: one dragged in or out counts from the bot's next start); and every data message carries its database's `i`, so even a channel both register can't mix them up. Development runs without a gateway connection (`DISCORD_GATEWAY=off`): slash commands belong to production, and development sets up its channels with the CLI (`dfs setup`). The two share Discord's rate limits, so load tests use `LocalBlobStore` or `ChaosBlobStore`, never Discord.
- **Message formats.** They leak no file names, and every attachment is encrypted:
  ```
  #storage-NN   content: dfs1 b=184467 k=pack n=212 i=3fa9c1d2e0b4   attachment: 184467.bin
  #dfs-journal  content: dfs1 j=5521 ids=9120004-9125003 i=3fa9c1d2e0b4   attachment: j5521.bin
  #dfs-backups  content: dfs1 snap=212 hwm=9125003         attachment: snap212.bin
  ```
  - **Data:** `b` is the blob ID, `k` the blob kind (`solo` | `pack`), `n` the number of frames, and `i` the ID of the database that posted it (12 hex digits, made once by its migration in the `instance` table). This lets a reconciler map orphan messages back to DB rows, and lets recovery rebuild blob locations by scanning channels (§8). Blob IDs restart in every database, so `i` is what tells a database its own messages apart: no environment, test stack or restored copy can take another's messages for orphans, even in a channel both registered. Recovery keeps the `i` of the database it rebuilds.
  - **Journal:** `j` is the batch number (contiguous, so a missing batch is detectable), `ids` the range of journal record IDs inside it (a range: IDs can have gaps), and `i` the database that posted it, as for data. The sealed batch names its database too, which recovery checks, since development stacks share a master key and a category.
  - **Backups:** `snap` is the snapshot number and `hwm` its journal high-water mark. The attachment is the encrypted manifest that locates the dump (§8).

---

## 5. Data Model (PostgreSQL 18)

Two layers keep the **logical** file system separate from **physical** storage:

- **Logical:** `nodes` (tree) → `file_versions` → `chunks`. A *chunk* is one encrypted *frame* holding a piece of one file version.
- **Physical:** `blobs`. A *blob* is one Discord attachment. A **solo** blob holds one frame (a chunk of a large file). A **pack** blob holds many frames from many small files. Each chunk points at `(blob_id, offset, length)`.

```mermaid
erDiagram
    users ||--o{ sessions : has
    users ||--|| nodes : "root folder"
    users ||--o{ nodes : owns
    nodes ||--o{ nodes : "parent of"
    nodes ||--o{ file_versions : has
    file_versions ||--o{ chunks : "split into"
    blobs ||--o{ chunks : "contains frames of"
    storage_channels ||--o{ blobs : stores
    nodes ||--o{ share_links : "shared via"
    users ||--o{ upload_sessions : starts
    users ||--o{ audit_log : performs
    nodes ||--o| folder_stats : aggregates

    users {
        uuid id PK "uuidv7"
        text username UK "lowercase"
        text display_name
        text password_hash "argon2id"
        timestamptz password_expires_at "set while the password is temporary"
        timestamptz activated_at "first own password"
        boolean is_owner "exactly one"
        enum role "admin | user"
        bigint quota_bytes
        bigint used_bytes
        bigint reserved_bytes "in-flight uploads"
        uuid root_node_id FK
        timestamptz disabled_at
        int failed_sign_ins "sign-in throttling"
        timestamptz sign_in_locked_until
        timestamptz password_reset_requested_at "Forgot your password? (§7.1)"
        timestamptz created_at
        timestamptz last_seen_at
    }
    nodes {
        uuid id PK "uuidv7"
        uuid owner_id FK
        uuid parent_id FK "null only for roots"
        enum kind "folder | file"
        text name
        text name_key "NFC + casefold"
        uuid current_version_id FK
        text mime_type
        bigint size_bytes
        timestamptz deleted_at "set on the trashed node"
        uuid trashed_via "set on descendants of a trashed folder"
        text moderation_reason "set when an admin trashed it"
        timestamptz created_at
        timestamptz updated_at "Modified: a file's own date, see below"
    }
    file_versions {
        uuid id PK "uuidv7"
        uuid node_id FK
        int version_no
        enum state "uploading | syncing | stored | failed | purging | purged"
        bigint size_bytes
        int chunk_size
        int chunk_count
        int chunks_stored
        bytea content_hash "SHA-256 over chunk hashes"
        bytea wrapped_dek
        text key_id
        uuid created_by FK
        timestamptz created_at
        timestamptz modified_at "the file's own date, from the browser"
    }
    chunks {
        bigint id PK "identity"
        uuid version_id FK
        int idx
        int plain_size
        int frame_size
        bytea plain_sha256
        bytea frame_sha256
        bigint blob_id FK "null until packed"
        int blob_offset
        text staged_path "frame file until packed"
        timestamptz purged_at
    }
    blobs {
        bigint id PK "identity"
        enum kind "solo | pack"
        enum state "building | staged | uploading | stored | deleting | deleted"
        int size_bytes
        int live_bytes "bytes of non-purged frames"
        int frame_count
        bytea sha256
        uuid channel_id FK
        text message_id
        text attachment_id
        text cdn_url
        timestamptz cdn_url_expires_at
        text staged_path
        int attempts
        text last_error
        timestamptz created_at
        timestamptz stored_at
        timestamptz last_verified_at
        timestamptz released_at "set when its last frame was released: the GC waits for the journal (§6.4)"
    }
    storage_channels {
        uuid id PK
        text discord_channel_id UK
        text name
        enum kind "data | journal | backup | log"
        bool enabled
        bigint blob_count
        bigint bytes_stored
        text reconciled_through "the reconciler's checkpoint (§6.1)"
    }
    folder_stats {
        uuid node_id PK
        bigint file_count
        bigint total_bytes
        timestamptz updated_at
    }
    share_links {
        uuid id PK
        uuid node_id FK
        uuid version_id FK "the version a file link was made for (a replace deletes the link); null for a folder link (§7.5)"
        bytea token_hash UK
        bytea token_sealed "the token, sealed, so its owner can copy the link again (§7.5)"
        timestamptz created_at
        timestamptz expires_at
        text password_hash
        int password_version "bumped on change: unlock cookies lapse"
        int max_downloads
        int download_count
    }
    upload_sessions {
        uuid id PK
        uuid user_id FK
        uuid node_id FK
        uuid version_id FK
        enum state "receiving | completed"
        bigint reserved_bytes
        timestamptz created_at
        timestamptz expires_at
        timestamptz alive_at "the page holding it said it is open (§6.1)"
    }
    sessions {
        text id PK "SHA-256 of the cookie token"
        uuid user_id FK
        text csrf_token
        timestamptz expires_at
        text ip "where it signed in"
        text user_agent "first 300 characters"
        timestamptz last_seen_at "every 5 minutes at most"
    }
    audit_log {
        bigint id PK
        uuid user_id FK
        text action
        uuid node_id
        jsonb meta
        timestamptz at
    }
```

**Modified.** `nodes.updated_at` is what the drive shows and sorts as "Modified". A file's is its own modification date, as the browser that uploaded it read it (`File.lastModified`, kept per version in `file_versions.modified_at`), or the time of the upload when the browser didn't know; renaming or moving a file leaves it, as a file system does. A folder's is when it was made, renamed or moved. ZIP downloads carry the same dates (§6.2). A single downloaded file can't: browsers date it to the download. Creation dates, permissions and attributes are out of any website's reach; an archive uploaded as a file keeps them.

Supporting tables not drawn above: `journal` (outbox of metadata changes, §8), `journal_batches` (the sealed batches, staged until the bot posts them, §8), `instance` (the database's own ID, §4), `folder_stats_dirty` (§12.1), `archive_tickets` (single-use ZIP links, §9), `metrics` (the admin's graphs, §16), `media_info` (what an audio or video version holds, derived, §6.7), `media_subtitles` (subtitles extracted from inside a file, sealed, §6.7), `playback_positions` (where each user stopped, §10.4), and pg-boss's own schema. A `backups` table, for snapshots and their manifests (§8), doesn't exist yet: snapshots aren't built. Planned, and not drawn: `device_tokens` (§7.6), `dav_locks` (§6.8), `backup_sources` (§6.9), the columns of locked folders on `users`, `nodes` and `sessions` (§7.7), staging reservations on `upload_sessions` (§6.1), and `file_versions.device_id` (§7.6). The Drizzle schema in `packages/db` is the exact definition; this diagram shows its shape. A received upload part is its chunk row, so upload sessions don't list parts separately. Storage channels have their own ID, so a Discord channel ID appears once, in `storage_channels`.

### 5.1 Key rules and indexes

- **IDs:** user-facing entities use **UUIDv7** (time-ordered, generated with PG 18's native `uuidv7()`), which gives good B-tree locality for inserts. High-volume internal tables (`chunks`, `blobs`, `audit_log`, `journal`) use `bigint` identity to keep rows and indexes small.
- **Unique names per folder:** `UNIQUE (parent_id, name_key) WHERE deleted_at IS NULL`. `name_key` is the NFC-normalized, case-folded name, so `Photo.JPG` and `photo.jpg` cannot exist side by side. This keeps behaviour predictable on Windows and macOS.
- **Folder listing:** index `(parent_id, kind, name_key, id) WHERE deleted_at IS NULL`, with **keyset pagination** (folders first, then name). There is no `OFFSET` and no `COUNT(*)` on the hot path.
- **Search:** a GIN `pg_trgm` index on `name_key`, always filtered by `owner_id` and `deleted_at IS NULL AND trashed_via IS NULL`.
- **Chunk addressing:** `UNIQUE (version_id, idx)`. Because chunk size is fixed per version, a byte offset maps to a chunk with `idx = floor(offset / chunk_size)`. Index `chunks (blob_id)` for GC and compaction.
- **Blob queues:** partial indexes `blobs (state) WHERE state IN ('staged','uploading','deleting')` and `chunks (id) WHERE blob_id IS NULL AND purged_at IS NULL` (frames waiting for the packer).
- **Tree queries:** paths and breadcrumbs use recursive CTEs, which are cheap because trees are shallow. A move is one `UPDATE` plus a cycle check (the new parent must not be a descendant).
- **Quota:** `upload_sessions` reserve bytes up front (`users.reserved_bytes`). When the upload completes, the reservation becomes `used_bytes` in one short transaction.
- **Users:** `username` is stored lowercase with a unique index, so `Sam` and `sam` are the same account. A partial unique index `(is_owner) WHERE is_owner` allows only one owner (D28).
- **Versions:** a file keeps **only its current version** (D42). Replacing it purges the version it replaces as the upload completes, and the file's share links are deleted with it (§7.5): a link never shares what replaced the file it was made for. The leading bot's janitor purges any earlier version left over from before D42, when versions were kept while a link served them, and deletes the links made for them. A version being uploaded counts toward the owner's quota beside the current one until it replaces it (D24). There is no version history to browse.

### 5.2 Lifecycle state machines

```mermaid
stateDiagram-v2
    direction LR
    [*] --> uploading : upload session created
    uploading --> syncing : all parts received (readable from staging)
    syncing --> stored : every chunk's blob stored in Discord
    uploading --> failed : session expired
    syncing --> failed : unrecoverable error
    stored --> purging : trash emptied / no share link serves it any more
    syncing --> purging
    failed --> purging
    purging --> purged : all frames released
```
*File version.* It is readable in `syncing` (served from staging) and in `stored` (served from Discord).

```mermaid
stateDiagram-v2
    direction LR
    [*] --> building : packer assembling (pack only)
    [*] --> staged : solo blob written by API
    building --> staged : pack sealed & written
    staged --> uploading : bot job picked up
    uploading --> stored : message posted + verified
    uploading --> staged : retryable error (backoff)
    stored --> deleting : live_bytes = 0, or compacted away
    deleting --> deleted : message deleted
```
*Blob.*

---

## 6. Core Flows

### 6.1 Upload (streamed, resumable)

A file is stored in parts of **exactly the version's chunk size**, each one encrypted frame, as in an S3 multipart upload. A small file goes in a single `PUT` of its one part. A larger one **streams in one request** (`PUT /api/uploads/:id/content`), which the API cuts into parts as the bytes arrive: the browser sends the file straight from disk, and its progress counts the bytes as they go (D30). **Plaintext never touches disk.**

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API
    participant S as Staging volume
    participant Q as pg-boss (Postgres)
    participant Bot as Bot
    participant D as Discord

    B->>A: POST /api/uploads {parentId, name, size, mime, modifiedAt}
    A->>A: check name, reserve quota, create version (uploading), generate DEK
    A-->>B: {uploadId, chunkSize, chunkCount}
    alt small file: one part
        B->>A: PUT /api/uploads/:id/parts/0 (body, X-Part-SHA256)
    else larger file: one stream
        B->>A: PUT /api/uploads/:id/content?from=0 (the file, read from disk as it goes)
    end
    loop each part, as its bytes arrive
        A->>A: hash, AES-256-GCM encrypt → frame
        A->>S: write frames/<versionId>/<idx>.dfs (durably, before its chunk row commits)
    end
    A-->>B: 204
    B->>A: POST /api/uploads/:id/complete {partSha256} (a small file completes itself)
    A->>A: check every part's hash, version → syncing (downloadable from staging now)
    A->>Q: a large frame is a blob of its own: enqueue blob.upload(blobId)
    opt small files
        Bot->>S: packer concatenates frames → blobs/<blobId>.bin
        Bot->>Q: enqueue blob.upload(blobId)
    end
    loop each blob job
        Bot->>S: read blob
        Bot->>D: POST /channels/{ch}/messages (attachment, nonce)
        D-->>Bot: message {id, attachments[0].id, url}
        Bot->>Bot: verify size
        Bot->>Q: blob stored → journal blob.stored, chunks_stored++ per version, delete staged file
    end
    Bot->>Q: version fully stored → state stored, journal record, pg_notify
    Q-->>A: NOTIFY dfs_events (every API instance LISTENs)
    A-->>B: SSE: file synced
```

**Details**

- **Resume:** `GET /api/uploads/:id` returns the session with `receivedParts`, the part indexes already received. A broken or paused stream starts again at the first part missing (`?from=`): the API keeps every part that arrived whole, and drops the one cut short. A session expires 24 h after its last sign of life (its creation, a stored part, or its page saying it is open), so an upload under way never expires however long the file takes; a janitor job cleans up expired sessions and releases their reserved quota.
- **Uploads live in their page**, as on any website: closing or reloading it cancels them (the browser asks first while any are under way). As it goes, the page cancels its sessions not yet complete in requests that outlive it (`fetch` with `keepalive`), so no half file stays in its folder. A page can't always say goodbye (a crash, a phone closing the tab, a lost network), so a session is also a lease: while the page holds it, it says every minute that it is still open (`POST /uploads/alive`), and every stored part renews it too; the leading bot gives up sessions quiet for 10 minutes, and their open folders refresh. A computer asleep for longer comes back to an upload to retry from the start. An upload that fails gives up its session at once, with what had arrived, so Retry starts it afresh; one paused for 5 hours is canceled, and the panel says when beforehand. Files already uploaded reach Discord without the page.
- **A stream's integrity:** the stream carries no hashes. While it uploads, the browser reads the file a second time, one part at a time, and hashes each part; `POST /complete` sends them all (`partSha256`), and the API compares them with the parts it received. Parts that differ are dropped before the `400 hash_mismatch`, and the client streams again from the first one.
- **Small files in bulk:** `POST /api/uploads/batch` creates up to 500 sessions in one call. It answers per upload, in request order (`{results: [{ok: true, session} | {ok: false, error}]}`), because a batch can partly fail: an invalid name, or the quota running out halfway (`507 quota_exceeded`). A single-part file is uploaded with one `PUT` and **auto-completes**, so uploading a small file costs 2 requests in total. Folder trees are created first with `POST /api/folders/ensure` (like `mkdir -p` for many paths in one transaction).
- **Same name, new version (D20):** an upload whose name matches a non-trashed **file** in the target folder (by `name_key`, so ignoring case) creates a new version of that file instead of a new node. The node keeps its ID and its stored name, so links, shares and paths keep working. A matching **folder** is a `409 name_conflict`. Renames and moves still answer `409` on any clash; only uploads make versions.
  - **The web app asks first.** Its uploads send `ifExists: 'ask'`: a name a file already has (in the folder, or earlier in the same batch) then starts nothing and answers `409 file_exists` with that file (`existing: {nodeId, links}`). The upload waits in the panel, and a dialog asks, one file at a time: **Replace** (sent again with `ifExists: 'replace'`, a new version), **Keep both** (under another name, `name (1).ext` by default, editable), or **Skip**. Closing the dialog skips. A choice can be made for every file of the drop that already exists; copies are then numbered, counting on past numbers already taken. The dialog says how many working share links the file has: replacing it deletes them (§7.5, D42). Without `ifExists`, as from scripts, an upload replaces.
  - **Dropping a folder again finishes it** (D44). An upload that asks first, whose name's file is the same file (its current version the same size and modification date, uploaded and on its way to Discord or there), starts nothing and answers `409 already_uploaded` with that file: nothing to send, and nothing asked. So a folder dropped again sends only what isn't there yet: what failed, what was cancelled, what changed since. It is the quick check of tools such as rsync, which a file edited without changing its size or its date would get past; without a date from the browser, it asks. A name held only by a file not yet uploaded (an upload under way, or one a crashed page left, until the bot gives it up) isn't asked about either: the upload becomes another version of that file, and the one that completes last stays.
  - The new version reserves its full size; old versions still count (D24), so there must be room for both.
  - `current_version_id` moves to the new version only when the upload completes, in the same transaction that turns the reservation into used bytes. Until then, readers and shares get the previous version.
  - Completing it purges the earlier version, which frees its quota, and deletes the file's share links, journaled as `share.deleted` and counted in the upload's audit entry (§7.5, D42). A download of a purged version under way is cut short; one resumed later gets the whole current version (`If-Range`, §6.2).
  - The upload session says which version it creates (`versionId`) and whether it is a new version of an existing file (`isNewVersion`, so the UI doesn't animate the row in as new). `GET /uploads/:id` answers until the session expires, also after completion (`state: 'receiving' | 'completed'`).
- **Completing doesn't wait for the disk** (D43): a completion's transaction commits with `synchronous_commit = off`, so it doesn't hold the user's row and the journal lock while the disk flushes, which every completion of that user waits on. Postgres keeps the order of commits, so a crash of Postgres or the VPS forgets at most about the last second of completions, each whole or not at all: their files come back as unfinished uploads, given up 10 minutes later (their pages had moved on), to send again. A later commit that waits for the disk, as everything else does, keeps those before it too, so nothing posted to Discord or to the journal can be forgotten. The mount and the backup app complete the same way (§6.8, §6.9 say what each does about it).
- **Retries are harmless:** sending a part again, alone or in a stream, is accepted, also after the upload completed, as long as its SHA-256 matches the part received (otherwise `409 upload_completed`); completing a completed upload is a no-op, and cancelling one leaves the file. A client whose response was lost simply retries, and a `404` means the session expired.
- **Idempotency:** Discord's `nonce` + `enforce_nonce` on message create prevents duplicate posts when a job retries within a short window: a retry reuses the blob's channel and its random nonce (random, since blob IDs repeat across databases sharing the bot). A reconciler reads its environment's registered channels (§4) every hour from where it last stopped, and deletes the bot's data messages carrying this database's `i` that no blob records (one posted again after the nonce window, say). It leaves messages younger than an hour alone, since an upload may still be recording them, and never adopts one: posting again is cheaper than checking a stray copy. Each channel is reconciled on its own, so one that is gone or out of reach doesn't keep the others from being cleaned.
- **Channel selection:** the least busy enabled data channel, which spreads rate-limit buckets across channels. Each channel takes `UPLOAD_CHANNEL_CONCURRENCY` posts at a time (default 2), so a channel Discord slows down gets fewer blobs while the others keep going. The bot holds about 32 blobs at once to keep the channels busy, but reads a blob from staging only when its post starts, so waiting blobs take no memory.
- **Backpressure:** if staging passes `STAGING_MAX_BYTES`, `PUT part` returns `503` with `Retry-After` (seconds or an HTTP date) and the client backs off. A stream instead stops reading while staging is full, which pauses the browser's sending with it, and answers `503` only after 45 s, less than the minute Caddy lets an upload stall. Staging cannot grow without limit when Discord is slower than the user's upload. What staging holds is counted one way everywhere (`stagedBytesSql` in `packages/db`): frames on their own, plus sealed packs waiting to be stored. The upload limit, the overview's staging alert and graph, and Admin → System all read it.
- **Files larger than staging** *(planned, not built; D38, the user's decision, 2026-10-11)*. An upload's frames stay in staging until it completes, since only completion hands them to the bot. So a file larger than `STAGING_MAX_BYTES` can never finish, every other upload waits on `503 staging_full` while it fills staging, and two large uploads can block each other the same way. The mount and the backup app (§6.8, §6.9) would make large uploads routine. The plan: an upload reserves staging for what it has yet to send before it sends it, and a file that could never fit is refused.
  - *The cap:* `POST /uploads` and the batch refuse a file whose frames would take more than `STAGING_MAX_BYTES` with `413 file_too_large`, naming the limit (30 GiB in production). The web app says so before sending anything; the mount and the backup app report it.
  - *Reservations:* a stream (`PUT /uploads/:id/content`) reserves, as it starts, the framed size of the parts it has yet to send, gives back each part's share as the part arrives (its frame then counts in staging itself), and the rest when it stops. Staging is full when what it holds and what is reserved reach the limit together, so an upload that has started always has room to finish, and one that can't get room waits before sending a byte (up to 45 s, then `503` with `Retry-After`, as now) instead of filling staging halfway. Reservations are kept on the upload session, so every API instance counts them, and the lease's janitor (above) gives back those of a stream whose API died. Letting a stream in is one short transaction under an advisory lock of its own, so two streams starting at once on different API instances can't both take the last room. A single-part `PUT` needs no reservation, its part being the whole file, but takes its turn as below.
  - *Turns:* a stream that finds no room records that it is waiting (`staging_waiting_since` on its session, kept while its client keeps coming back after each `503`, and dropped once it hasn't for 2 minutes). The oldest waiting stream goes first: anything newer, a stream or a single part, gets in only if what is left after that stream's reservation still fits. So small uploads can't keep a large one waiting for ever, and the price falls the other way: a file that needs most of staging holds the others back until it is in, and while it uploads.
  - *Counting:* the upload limit counts what staging holds and what is reserved. The overview's staging alert and graph keep counting what it holds (`stagedBytesSql`), since a reservation is room promised, not disk used, so a large upload starting doesn't raise the critical alert; Admin → System shows reservations beside it. The VPS's disk sets the cap: raising `STAGING_MAX_BYTES` raises it.
- **Read-your-writes:** a `syncing` version is fully readable. The download path reads frames from staging until their blob is `stored`.
- **Progress:** the UI shows two phases. *Uploading* is browser→API. *Syncing to Discord* is in the background and streamed via SSE from `GET /api/events` (`nodes.synced`).
- **Live events across API replicas:** the bot never talks to browsers, and a user's SSE stream can be on any API instance. Every state change the UI shows (version synced or failed, quota changed) calls `pg_notify('dfs_events', …)` in the same transaction, so the event is delivered only if the change commits. Each API instance `LISTEN`s on one dedicated connection and forwards events to its own SSE clients for that user. Payloads stay small (user ID, event type, a few IDs; Postgres caps them at 8 KB). Bulk changes send one coalesced event per transaction (for example, per pack). Events are not durable: after a reconnect, the client refetches. Postgres serializes the commits of transactions that issue `NOTIFY`, so only transactions that are already infrequent send one: per pack, per batch, or rare events. Per-file transactions, such as completing a small-file upload, don't notify. The uploading browser already knows about those, and it refetches the quota when a batch finishes.
- **Event payloads** (shared Zod schemas, `liveEventSchemas`): the SSE `event` field is the type and `data` is JSON. They say what changed, so the UI updates in place instead of refetching whole folders (a 6,000-file folder is 30 pages):

  | Event | Payload | The UI |
  |---|---|---|
  | `nodes.synced` | `{nodes: [{id, parentId, syncState}]}`, at most 500 nodes | patches the rows in the cache; the upload panel ticks off phase two (or shows the failure) |
  | `nodes.changed` | `{parentIds}` | refetches only those folders' listings (background changes, e.g. moderation) |
  | `quota.changed` | `{usedBytes}` | sets the quota meter directly |
  | `ping` | `{}` | every 25 s. Proxies keep the stream open, and a client that hears nothing for 60 s reconnects |

  The `NOTIFY` itself carries only IDs (a pack or a few versions), well under the 8 KB cap; the API instance that receives it expands them into the SSE payload. A pack of more than 500 files becomes `nodes.changed` for their folders instead. An event the client can't parse makes it refetch everything, and after a reconnect the upload panel re-checks the files it still shows as syncing, so a newer server or a missed event never leaves a stale screen.

### 6.2 Download (streaming, Range-aware)

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API
    participant C as Frame cache
    participant Bot as Bot
    participant CDN as Discord CDN

    B->>A: GET /api/files/:id/content (Range: bytes=X-Y)
    A->>A: authz, find chunks covering [X,Y], unwrap DEK
    loop each needed chunk (read ahead up to 2 as the reader keeps up)
        A->>C: lookup chunkId
        alt cache miss
            alt blob not yet stored
                A->>A: read frame from staging
            else blob stored
                alt cdn_url missing or expiring
                    A->>Bot: POST /internal/urls/refresh [blob refs, batched]
                    Bot-->>A: urls + expiry (also saved to DB)
                end
                A->>CDN: GET signed URL, Range: offset..offset+frame_size-1
                CDN-->>A: frame ciphertext
            end
            A->>A: verify frame_sha256
            A->>C: store (encrypted)
        end
        A->>A: decrypt (GCM tag check) and slice to range
        A-->>B: stream bytes
    end
```

- Responds `206 Partial Content` with `Accept-Ranges: bytes`, so `<video>` seeking and resumable downloads work.
- **Revalidation:** the ETag is the version's ID and the answer is `private, no-cache`, so a browser asks again each time; one that names the version it has (`If-None-Match`) gets `304 Not Modified` and no bytes, so going back and forth between previews (§10.3) moves nothing again. A resumed download names its version with `If-Range` instead, and one of another version gets the whole file.
- **Pack reads** use an HTTP `Range` request against the CDN (the contract test checks it answers `206`), so reading a 50 KB file out of a 20 MiB pack moves about 50 KB. If the CDN ever ignores `Range` (returns `200`), the API cuts the frame out of the whole blob.
- **Folder download:** `GET /api/folders/:id/archive` streams a ZIP built on the fly (ZIP64 for large archives, store-only with no compression). Each entry carries its "Modified" (§5) twice: as an MS-DOS time, which has no time zone and is read as local time, so the server writes it in the downloader's zone (`?tz=`, which the web app sends from `Intl`; UTC without it), and as Info-ZIP's extended timestamp in UTC (1901 to 2038), which 7-Zip, macOS and unzip prefer. Before streaming, it signs the URLs of the packs it needs in one call, and fetches a pack **whole** when the round trips that saves outweigh the bytes it adds (a round trip of 40 ms against 7 MB/s, measured from the development machine: for files of 100 KB, from about a quarter of a pack on, whatever its size; measure both again from the VPS, whose faster link makes whole packs pay off earlier). Its frames go to the cache, where each file finds them, and the next pack is fetched while this one's files are sent. A folder of 1,000 small files usually means a handful of pack downloads; a second download of it, none.
- **The cache** holds *ciphertext* frames on local disk (LRU, `CACHE_MAX_BYTES`, default 5 GiB), so it is safe even if the disk is compromised. It is keyed by each frame's SHA-256: frames never change, so an entry stays right even after compaction moves its frame. Every hit is checked again (a bad copy is dropped and fetched anew), readers of the same frame share one fetch, writes skip `fsync` (a torn file fails its check), and the index is rebuilt in the background at start. Only frames of stored blobs read from Discord go through it; the local store and staging don't need one. It also keeps single segments of format 2 frames read in part (§7.3), under the same size and the same order: a PDF's pages and ffmpeg's reads come back to the same few, each of which would otherwise be another request to Discord. Their own tags check them when opened, so a bad copy is dropped and fetched again; only segments that passed their tag are kept; and a frame kept whole replaces its segments. Hits and misses count per segment as per frame.
- **A deleted message's attachment** (checked live, 2026-10): Discord still signs new links to it, but its CDN answers them with 404, and an attachment no one had read is gone at once; only a link that read it before the deletion keeps serving it, from the CDN's cache, for a while. So a read that fails looks its frame up again and reads it where it is now, if it moved since: packed or stored while it was read from staging, or compacted into another pack whose old message went (§6.6). A download looks up 64 chunks at a time, and a ZIP plans whole packs at its start, so a frame can move under a long one. The frame cache needs nothing: a move doesn't change a frame's hash.
- **Streaming a chunk** (format 2, §7.3): one that isn't in staging or kept whole in the cache is read segment by segment, each checked by its own tag and sent as soon as it has arrived; the first bytes wait for one 256 KiB segment, not a whole 20 MiB frame. Each segment comes from the cache if kept there, from another reader's fetch if one is under way (shared, as checked plaintext in memory), or else from Discord by `Range`, consecutive ones in one request. A small range that ends before its chunk does also reads the next segments, up to 1 MiB in all, into the cache, so the reads that follow it find them (**read-around**); a range to the end of its chunk, as a player asks, gets none, so a seek cancelled at once still fetches only what it asked for. A chunk read whole is fetched whole, checked against its SHA-256 and kept as one frame. Bytes are counted: a range Discord cuts short fails, never taken for a whole one, and if a frame moves mid-stream (§6.6) the rest is read where it is now, from the next segment. Staged, cached and format 1 frames are read whole, and only the segments wanted are opened.
- **Discord's CDN asking to slow down.** Discord publishes no limits for its CDN, which counts by address, and everything DFS reads comes from the VPS's one. When it answers 429, every read of the process waits as long as it asked (`Retry-After`, at most a minute) or, when it didn't say, a pause that doubles with each 429 in a row, then the refused request is sent again, three times at most (`CdnGate`). A read cancelled while waiting leaves at once, and a request's minute runs from when it is sent. The API counts them (`cdn.429`) on the graph beside failed CDN reads, and five in an hour raise a warning.
- **A video's end, ahead of its player** (the user's decision, 2026-10-09). Most tools write a video's index last (an MP4's sample tables, about 2 MB an hour of 30 fps video, when it isn't saved for streaming; an MKV's cues, a few kilobytes), and a browser reads it before it plays, right after the file's first bytes. So when a player opens a video (`GET …/playback`, which comes before the player asks for any of it), the API fetches its last 4 MiB from Discord into the frame cache (`warmEnd`, `WARM_END_BYTES`), the last megabyte on a request of its own, first, since it holds a shorter video's whole index and would come last in one request with the rest: the browser's look at the end then finds it kept, or shares the fetch under way, a round trip to Discord sooner. On a review stack against Discord (2026-10-09), opening an MP4 with its index at the end as a browser does (its start, then its end), the index's first byte came in 265–287 ms, against 573–824 ms without; from the VPS, where Discord's first byte takes about 0.1 s, the fetch should be over before the browser asks. Only for videos, and only what isn't kept or staged; nothing is sent, it runs on if the viewer leaves (30 s at most), takes its share of the read-ahead budget, and a few at once per API, one per version, so a player that asks again starts nothing. An index larger than 4 MiB has its first bytes fetched when asked, as before; nor is the last 28 MB of an MKV that Firefox on a phone was seen to read before playing (2026-10-09).
- **Many streams at once.** Nothing caps how many requests the API makes of the CDN: what many viewers share is bandwidth, which a cap would only divide into queues. From the VPS, three 20 MiB frames at once came no faster than about 34 MB/s together, so some 30 cold 1080p streams (about 1 MB/s each) would fill that link (an estimate from one measurement; the VPS's own upload to viewers isn't measured). Under load, read-ahead drops out first (its 256 MiB budget), a file several watch is fetched once (the cache, shared fetches), and the whole API backs off together if Discord asks. The graphs show CDN reads under way against downloads to browsers, and the CDN's time to first byte (§16), so contention shows before anyone feels it; giving reads someone waits for priority over read-ahead comes only if it does.
- **Read-ahead** starts at nothing and grows by one chunk per chunk the client takes (not per segment of one), up to 2, never past the requested range, so a whole file keeps up to 3 requests overlapping. The first chunk read ahead doesn't wait for the first to be taken whole: it starts once the client has taken 2 MiB of it, or half of what it wants of it, whichever comes first (`READ_AHEAD_AFTER_BYTES`; the user's decision, 2026-10-09). On production, reads after a seek had waited on Discord 1.4–2.4 s each, the next chunk asked for only once the client had all of the one before; this way it is under way well before it is wanted, wherever in a chunk the seek landed, and a seek left before then still reads nothing past its chunk. From the VPS, one request to Discord brings 22–34 MB/s, several times what a viewer takes (4–9 MB/s), so reading the next chunk doesn't slow the one being sent. The development machine's link, about 7 MB/s for everything, can't show it: there the two share the link, and old and new were within noise of each other (2026-10-09), as read-ahead depths were before. On production, what shows it is the Seeks graph (§16) and, before and after, the `file sent` lines of reads starting mid-file: their wait for storage after the first byte (`waitedForSourceMs` less `firstByteMs`). The share of waits on storage says less: a player with enough loaded leaves its response waiting on the client for minutes, which outweighs any seek. A response asks the reader for its next piece only once its socket has taken the last (`paced`, in `send.ts`); Node's `Readable.from` alone asks again as soon as it hands a piece on. So a stalled client stalls its download, and holds one chunk outside the budget, in the socket's write buffer. But a socket takes a piece before the client has it, as far as the connection's buffers go: behind Caddy, with the VPS's buffer limits (a receive buffer may grow to 32 MiB), they take a whole 20 MiB piece at once, so reading ahead starts anyway. So a response that closes before it has finished, as a seek closes one (and Chrome's player on opening a video), **aborts what is being read for it** (`cancellation`, in `send.ts`): its CDN requests stop at once, and nothing given up on is cached. A frame another download waits for too is fetched on: the frame cache stops a shared fetch only once every reader has left it. Measured on Discord (2026-10-08), behind Caddy with the VPS's buffer limits, a client reading at 7 MB/s: a seek cancelled within its first 1 to 10 MB took 3 whole frames from Discord before (about 62 MB), and 1.1 to 1.7 frames' worth after, the first frame and what of the next had arrived by the cancel; full reads were as fast, and so were cold ZIPs (60 files of 150 KB from one pack fetched whole, 1.4–1.7 s; 28 of 200 KB read by range from three sparse packs, 2.1 s). A `HEAD` request, which Fastify answers by draining the stream it was given, read the file from Discord for nobody (3 frames within 10 s, and on) and a folder's whole pack for a ZIP; it now gets an empty stream, with the length, and reads nothing. Frames read ahead come from one budget of 256 MiB for the whole API (whole packs for archives too); a download that finds no room reads a chunk at a time. Whole packs fetched for a ZIP (below) finish into the cache, even for a ZIP cancelled meanwhile.
- **Measured with segments** (format 2, 2026-10-09), on Discord, 125 MB files of each format and the frame cache cleared each time. Discord's CDN itself: a range of an attachment never read takes 0.2 s to its first byte (0.5–0.9 s with a new TLS connection), and 256 KiB more arrive within 20–50 ms; once read, 0.05–0.15 s. Through the API on the development machine, a cold seek's first byte: format 1, 2.7–3.0 s; format 2, 0.40–0.52 s with Discord cold and 0.08–0.09 s once it has the file, as fast as passing bytes on unchecked would be. Behind Caddy with the VPS's buffer limits, a seek cancelled after 1 MB of a client reading at 7 MB/s: first byte 0.14–0.19 s against 2.8–3.3 s, and about 1.5 MB from Discord against 24 MB (after 10 MB, 12 MB against 34). Full reads and cold ZIPs took as long as before, and examining a 30 MB MP4 cold took 0.54–1.0 s against 4.3–6.3 s. Sealing in segments kept uploads as fast (`scripts/performance.ts`: whole parts the same within noise, 1 MiB parts faster, sealed in parallel). With the segment cache and read-around (2026-10-09), behind Caddy with the VPS's buffer limits: a PDF read as pdf.js reads one (140 ranges of 64 KiB, 14 in a row in each of 10 places) took 16 requests to Discord and 3.1 s, against 140 and 11.3 s, and opened again, none and 1.3 s, against 140 and 11.1 s; cancelled seeks cost as before (first byte 0.14–0.20 s, about 1.5 MB from Discord after 1 MB).
- **Measured** before segments, from the development machine (a link of about 55 Mbit/s, which caps every cold figure). With 20 MiB chunks (2026-10-08) and a 125 MB file: a cold first byte, a seek's too, takes 2.9–4 s (a whole frame has to arrive before its tag can be checked; with 10 MiB chunks it took 1.5–2 s, so the chunk size is the lever, at the cost of more messages), a cold full read 6.2–7 MB/s, the same before and after pacing, with no stall for a client reading at 7 MB/s. From the VPS, Discord's CDN gives a 20 MiB frame in 0.6–0.95 s (22–34 MB/s), so a cold seek in production waits about a second; three frames at once come no faster (34 MB/s together), so there read-ahead overlaps waiting, not bandwidth. With 10 MiB chunks, a 256 MB file and 300 files of 100 KB: a warm read 345 MB/s with first bytes in 31 ms; the ZIP of the 300 files 6 s cold with whole packs against 15 s reading each file's range, and 0.75 s warm. Read-ahead depths of 0 to 2 were within noise on the development machine's link.

### 6.3 Metadata operations (no Discord traffic)

Rename, move, create folder, and trash/restore are plain SQL transactions.

- **Trash a folder:** set `deleted_at` on the folder, and in the same transaction set `trashed_via = <folder id>` on all its descendants (recursive CTE update). This keeps search and stats queries simple (`trashed_via IS NULL`). For very large subtrees (over `TRASH_SYNC_LIMIT`, default 50k nodes), the descendant update runs as a batched background job; the folder itself is hidden immediately.
- **Restore** clears both fields for the subtree, auto-renaming to `name (1)` if the name has since been taken.

### 6.4 Deletion & garbage collection

1. **Trash:** the item can be restored for `TRASH_RETENTION_DAYS` (default 30). After that, the leading bot's janitor purges it, every 10 minutes, the oldest 500 items at a time and one drive per transaction under its tree lock, as emptying the trash would; each is logged as deleted for good by the system.
2. **Purge:** triggered by emptying the trash, the retention expiring, or a file being replaced. The version goes to `purging`, its chunks get `purged_at`, each affected blob's `live_bytes` drops by the frame size, and quota is released right away.
3. **Blob release:** a blob with `live_bytes = 0` moves to `deleting` (also when it was purged while being uploaded). The GC (bot leader) deletes messages one at a time: one every 2 s while blobs wait to be uploaded, up to 20 every 2 s otherwise. Uploads get most of the rate-limit budget, and deleting never stops altogether. A message goes only once every journal record written by its release is in `#dfs-journal` (`blobs.released_at`, against the oldest record not posted yet): with the VPS lost first, the database rebuilt from Discord would point at a message gone, and once compaction moves frames (§6.6), lose files still in use. So messages go a minute or two after their files, and wait while the journal can't be posted. A failed deletion is counted on the blob (`attempts`, `last_error`), and blobs are taken fewest failures first, so one that keeps failing never holds up the rest. It works the same on the local store.
4. **Pack compaction** (§6.6) reclaims packs that are mostly dead.
5. When all of a version's chunks are released, the version becomes `purged`.

### 6.5 Integrity & self-healing

| Mechanism | What it catches |
|---|---|
| Per-part plaintext SHA-256 (client→API: with each part's `PUT`, or with a stream's completion) | Corruption in transit during upload, and a stream cut into parts in the wrong place |
| `frame_sha256` checked on every read | CDN, cache, or staging corruption |
| `blobs.sha256` checked by the scrubber | Corrupted or truncated blobs |
| AES-GCM authentication tag | Tampering with a frame or its header, wrong key, swapped or reordered chunks (the AAD binds the header, object type, version, and index, §7.3). Needs no DB, so it also protects recovery. |
| `content_hash` = SHA-256 of the ordered chunk hashes | Truncated or missing chunks |
| **Rolling scrubber** *(not built)* | Silent loss or damage on Discord's side, the only kind left now that no one but DFS deletes its messages (D31); whether it is worth building is open (§18.1). It would check blobs in order of `last_verified_at` within a fixed request budget (`SCRUB_REQUESTS_PER_HOUR`), so a full pass takes *blobs ÷ budget* hours regardless of how many files there are, and check each blob's **message**, not just its URL, since a link can serve a deleted attachment for a while (§6.2). |

### 6.6 Small-file packing & compaction

```mermaid
flowchart LR
    F1["frame A (40 KB)"] --> P
    F2["frame B (1.2 MB)"] --> P
    F3["frame C (300 KB)"] --> P
    FN["… frames …"] --> P
    P["Packer (bot)<br/>add a frame only if it fits<br/>seal at PACK_TARGET_BYTES, when nothing fits,<br/>or oldest frame ≥ PACK_MAX_WAIT"] --> BL["pack blob ≤ BLOB_MAX_BYTES<br/>= concatenated frames"]
    BL --> UP["blob.upload → 1 Discord message"]
```

- **Which frames are packed:** every frame of less than `PACK_THRESHOLD_BYTES` (default 4 MiB) of plaintext: small files, and the last chunk of a large file, so nearly every message is close to full. Each file still has **its own DEK and frame**. A pack is just a concatenation of self-delimiting frames, so **the packer needs no keys** and runs in the bot. Backup snapshots are never packed (§8).
- **Packer loop** (single bot leader): `SELECT … FROM chunks WHERE blob_id IS NULL … ORDER BY id FOR UPDATE SKIP LOCKED` over a window of waiting frames. A frame is added only if `pack_bytes + frame_bytes ≤ BLOB_MAX_BYTES`; a frame that doesn't fit stays queued and goes into the next pack. The pack is sealed when it reaches `PACK_TARGET_BYTES`, when no waiting frame fits in the space left, or when its oldest frame has waited `PACK_MAX_WAIT_MS`. Sealing writes `packs/<uuid>.bin` in staging, sets `blob_id`/`blob_offset` on each chunk, and enqueues `blob.upload`, all in one transaction. The frame files are deleted after it commits, and until the pack is stored, reads cut frames out of the staged pack. If the bot crashes in the middle, the transaction rolls back and the frame files are still there. The packer runs every second and seals every pack that is due; frames are taken in upload order, so files uploaded together share packs, which keeps folder downloads to a few messages.
- **Compaction**: the leading bot merges packs that hold little into fewer (`apps/bot/src/compactor.ts`, D32).
  - *Which packs:* a stored pack whose live bytes are under `COMPACT_THRESHOLD` (0.3) of a full pack (`PACK_TARGET_BYTES`), whatever its own size, stored at least `COMPACT_MIN_AGE_DAYS` (7) ago, so files deleted soon after their upload go first. That takes mostly dead packs and the small ones a lone upload sealed after `PACK_MAX_WAIT_MS` alike. Candidates are grouped in pack ID order, so files uploaded together stay together, as many whole packs to a group as fit in `PACK_TARGET_BYTES`, and a group of one is left: rewriting one pack saves no message. A merged pack still under the threshold may be merged again `COMPACT_MIN_AGE_DAYS` later, saving messages each time. The rule is one function (`packages/db/src/compaction.ts`), by which the bot merges and Admin → Storage counts what it would, so that deleted files' bytes leaving Discord within some days (not now) would only change it.
  - *When:* one group per run, a minute after the last run ends, and only while no blob waits to be stored, as deletions yield to uploads (§6.4), and no file was downloaded in the last minute (`downloads.bytes`, which the API saves every 5 s): a run reads whole packs from Discord over the link downloads use too, and measured on a home link, downloads of packed files took up to half again as long while one ran. A run that sees a download start stops before its next pack read, having reserved nothing. Admin → Storage's Compact packs now runs every group there is, without the days' wait and without waiting for downloads. One run at a time, shared by the loop and the task.
  - *A group:* each pack is downloaded whole and checked (its size and SHA-256, then each live frame's), one at a time, keeping only its live frames, so a group of many sparse packs never holds them all in memory. One that fails is left out with a warning and `compaction.failures`, and skipped until the bot restarts; its files would fail to download as well, and nothing else shows it (D31). A read the store may answer later (a rate limit, a timeout) ends the run instead, to be tried again a minute on. The live frames, still ciphertext, go into a new pack in chunk ID order. Its row is reserved as `building`, for the blob ID its message names, and the pack is posted from memory, never staged.
  - *Then one transaction* takes the frames' versions, then the old packs and the new one by ID (`locks.ts`); gives up if the new row isn't `building` any more, or was reserved over half an hour ago, well inside the hour after which the janitor and the reconciler clean up after it; moves each chunk still where it was read (the same `blob_id` and `blob_offset`: a frame purged meanwhile stays behind, as dead space in the new pack); sets `live_bytes` on both sides from what moved, the new pack `stored` and an old one left with nothing `deleting`; and journals `blob.stored` for the new pack, then `blob.relocated`. The old messages go only once that is in `#dfs-journal` (§6.4), so a VPS lost at any point leaves the journal pointing at packs that are there.
  - *A failure midway* leaves nothing pointing at the new pack. When the move fails or gives up, its row goes `deleted` and what was posted is deleted at once. After a crash, the janitor turns a `building` row older than an hour `deleted`, removing its file from the local store, and the reconciler deletes its message if it was posted (§6.1).
  - *Reads* that looked a frame up before it moved read it from its new pack once the old one fails (§6.2); the frame cache, keyed by frames' hashes, needs nothing.
- **Trade-off:** a deleted small file keeps taking up space in Discord until its pack is compacted, which may be never while the pack stays mostly live. Its quota is released immediately, though, and Discord space is free, so the only real cost is message count. Its bytes stay readable to whoever holds the master key; making them leave Discord within some days was considered and left for later (2026-10-07).

### 6.7 Audio and video streaming

```mermaid
flowchart LR
    B["Browser<br/>players (§10.4)"] -- "direct play:<br/>content (Range)" --> A["API"]
    V["Another player<br/>(the device's, VLC)"] -- "stream link:<br/>content (Range)" --> A
    A -- "probe, subtitles,<br/>covers" --> M["media<br/>ffmpeg"]
    M -- "plaintext of one version<br/>(Range, a token for it)" --> A
    A -- "frames (Range)" --> CDN["Discord CDN"]
```

Audio and video play in the browser as they are whenever it can decode them, and otherwise in another player, the device's own or VLC, through a stream link (D34). Nothing is converted on the server: the VPS (6 cores, no video hardware, and other work of the user's) can't convert a video while it plays (the user's decision, 2026-10-08); a remux (the container, or only the sound, repackaged while it plays) was built and dropped (the user's decision, 2026-10-10), as too much machinery (ffmpeg sessions, an encrypted cache of segments, limits on how many at once, and Chrome's Media Source refusing a 4K film's segments) for what VLC does on the viewer's own device, every sound, subtitle and track included. The players are §10.4.

- **Media info.** Each audio and video version is examined once with ffprobe: right after its upload completes, at the API's request and best effort, or else when first played. `media_info` keeps, per version: its kind, duration and container; each stream's codec with its RFC 6381 string (`avc1.640028`, `hvc1.2.4.L153.B0`, `mp4a.40.2`, `opus`, `ec-3`), profile, resolution, frame rate, HDR transfer and rotation, channels and sample rate, language, title, and default and forced flags; chapters; tags (title, artist, album, album artist, track and disc numbers, year, genre); and whether it has a cover. It is derived, so it is not journaled: after a recovery, files are examined again as they are played.
- **Direct play, else another player.** The player chooses from what the browser says it decodes, given the exact codecs (`MediaSource.isTypeSupported`, `canPlayType`), never from a list of formats, since that differs by browser, system and hardware:
  1. **Direct play:** the original, from the content route with Range (§6.2), as a download. Nothing runs on the server. Most phone videos and music play this way.
  2. **In part:** the picture plays, and not all the rest: a sound the browser can't decode (AC-3, E-AC-3, DTS and TrueHD, which few browsers decode) leaves it silent; picture subtitles (PGS, VobSub) can't be shown; other sound tracks can't be chosen where the browser lists none of its own (all but Safari). The player says which, and offers another player (§10.4).
  3. **Not here:** a picture the browser can't decode (HEVC without a decoder, AV1 on older devices, MPEG-2, MPEG-4 Part 2, VC-1, WMV), or a file it can't open (an MKV in Safari): the player says why, with Open in… (another player) and Download.
- **HDR** plays as the browser plays it: in HDR on an HDR screen, and on an SDR one as the browser or the system tone-maps it. DFS converts nothing; a browser that can't play it fails like any other, with the error and Download (the user's decision, 2026-10-08). Details shows HDR from the media info.
- **Stream links** (the user's decisions, 2026-10-10): a share link's address another player opens to play an audio or video file without DFS's session or the link's password, served as any download is, with Range, so the player seeks, and, as playing, never counted toward the link's downloads. Like the share link it comes from, it is public and has no end of its own: anyone who has it can play the file until the link is turned off or expires, its password changes, or the file is deleted or, for a file link, replaced, which deletes the link (a folder link plays the file's current one). Through a share link, the viewer gets that link's (`POST /s/:token/files/:id/stream-link`, from DFS's own pages); in the drive, the owner gets the address of the file's plain share link (no password, to its current version, one that never ends first), and, where it has none, `POST /files/:id/stream-link {create: true}` makes one, which Shared links lists and turns off like any other. It is short, to copy and paste (the user, 2026-10-10: "easily copy pastable, maybe like a uuid"): `…/api/stream/<token>`, the token the share link's ID, the file's when it is one inside a shared folder, and 12 bytes of an HMAC (a key derived from the master key, as media tokens and unlock cookies are, under a claim of its own) over them and the link's password's version, in base64url: 38 characters for a file link, 59 inside a folder. It is derived, not stored, so the same link gives the same address each time and it survives a recovery with its share link; a new password changes it. Those of the first, longer form (`s.<share>.<password version>.<file>.<HMAC>/<name>`, given out for a few hours on 2026-10-10) still play, and a name after either is ignored. The API keeps tokens out of its logs. A user, or an address through links, asks 30 times in 10 minutes at most. The players offered are the device's own first, then VLC (the user's decision, 2026-10-10); any other that plays an address (mpv, IINA, Infuse, Kodi) is another entry in the web app's list (`external-players.ts`), as the address is the same for all.
- **Quality** is the original's alone: lower qualities for a slow connection would be transcodes.
- **Seeking** is exact, and as slow as the file's full frames are far apart (found 2026-10-10, on a 4K, 60 fps, 10-bit AV1 clip with a full frame every 5.6 s). A seek fetches from the full frame before the target and the browser decodes every frame up to it: the server's first byte after a seek took 0.06–0.25 s, while the picture took 2.7–6.2 s on the viewer's side, and 3.4–3.75 s with the data already local, so no change to the server or the network makes it faster. Landing on the full frame instead was tried and rejected as landing off the target (the user's decision). Nothing is re-encoded on the server (the VPS manages about 0.09 times real time per core, in more memory than the media service has). For the user's own videos, `tools/dfs-reencode` re-encodes them on their own machine with a full frame every 0.5, 1 or 2 s, chosen so that a seek decodes at most about 30 frames of 4K (AV1 on an NVIDIA card, sound, subtitles and HDR kept): on that clip the worst exact seek fell from 4.3–4.5 s to 0.9–1.3 s, and the file from 384 to 214 MB.
- **Tracks.** Direct play plays the default audio track; Safari offers the others, and elsewhere the player offers another player for them. Text subtitles inside the file (SRT, ASS and SSA, mov_text, WebVTT) are extracted to WebVTT by the media service, all of a file's in one pass, right after its upload completes, while it is still in staging: an MKV's are spread through the whole file, so this way they cost nothing from Discord. A file examined later (uploaded before this, or after a recovery) has them extracted when one is first chosen, which reads an MKV whole once (about 30 s a GB from the VPS). They are kept in Postgres beside the media info (`media_subtitles`), each sealed as a journal batch is (§7.3, its own data key, bound to its version and stream), since a stolen database dump must hold no content (§7.4); they go with their version and aren't journaled (the user's decision, 2026-10-09). Subtitle files beside a video with its name (`Film.srt`, `Film.it.srt`, `Film.en.forced.vtt`, `.ass`, `.ssa`) are found by the API and converted to WebVTT in plain code, since the media service opens no subtitle formats: SRT and ASS, read as UTF-8 or UTF-16 with a byte-order mark, else in the Windows encoding of the language their name gives (Western by default). ASS styling is lost. Picture subtitles (PGS, VobSub) would have to be burned into the video, a transcode: they are listed in Details, and not shown.
- **Cover art:** the picture in an audio file's tags, copied out as it is by the media service when a browser first shows it, and kept by the browser a year rather than on the server (the user's decision, 2026-10-09); else an image named `cover`, `folder` or `front` (JPEG, PNG or WebP) in the same folder, which a file link doesn't offer, as it shares that file alone.
- **The media service** (`apps/media`, Node 24 with Debian's ffmpeg, its own image) runs ffmpeg and ffprobe, and the API is its only client. ffmpeg parses files anyone with an account uploads, so the service holds no secret: no master key, no database, no Discord token, and no internet (the internal network only, §3.2). It runs without root, on a read-only root filesystem, within Compose limits (1 CPU, 512 MiB: it examines and extracts, and converts nothing), and ffmpeg at a low priority. It reads a version's plaintext from the API (`GET /internal/media/:versionId`, with Range, on the API's port but outside `/api`, so the edge never forwards it) with a token the API signs for that version alone, valid a few hours (HMAC with a key derived from the master key, as share cookies are, §7.5). A flaw in ffmpeg reaches only the files it is asked to play.
- **Reads from Discord.** ffmpeg reads through the API's reader, so it shares the frame cache and its read-ahead (§6.2). A seek costs the 256 KiB segment holding that point, and those after it as far as ffmpeg reads (§6.2, §7.3).
- **Shared links** play the same way, within the same limits (the user's decision, 2026-10-08), and playing never counts toward a link's download limit (§7.5); nor does a stream link made through one, which ends with the link. A link's viewer may set off extracting the subtitles inside a file, as its owner may (once per version, one at a time; the user, 2026-10-09).
- **Planned, not yet built:** seek thumbnails (frames above the seek bar, made once in one pass that decodes only a video's keyframes, at a low priority, and kept). The user counts them important (2026-10-08). Measured 2026-10-10 on the 4K clip, in a container with the media service's 1 CPU and 512 MiB, scaled to 320 px and tone-mapped: 31 pictures in 9.4 s and 181 KB, but reading the whole file. Reading only the keyframes would need their index (an MKV's cues, an MP4's sample table), and a keyframe of that clip averages 717 KB, so a two-hour 4K film's 1,300 or so would read about 0.9 GB from Discord.

### 6.8 Network drive (WebDAV)

*Planned, not built (D39).* The drive mounted as a disk on a computer, to open and save files in place (the user, 2026-10-11: "I want to use this file system as a network drive sometimes"). DFS speaks WebDAV (RFC 4918), which macOS and Linux mount without installing anything, Windows too while its own client lasts (below), and which rclone mounts better on all three. The API serves it at `https://<domain>/dav/`, through Caddy: the user's own drive, signed in with a device token (§7.6), never with the account password. SMB and a FUSE client of DFS's own were set aside: SMB is made for local networks and would need a file server open to the internet on the VPS, and a FUSE client is a program per system, which rclone already is for WebDAV.

- **Clients.** What each is documented to do; every point is to be checked against the real client before it is built on.
  - *Windows' own* (Explorer's Map network drive, the WebClient service): nothing to install, but Microsoft deprecated it in November 2023 ("isn't started by default"; still installed on Windows 11 in 2026-10, its service starting on demand, with no removal date). So on Windows, rclone is the mount to rely on, and this one a convenience while it lasts: DFS doesn't bend its design to this client's quirks. It downloads a whole file before a program can open it (a film plays only once it has all arrived), refuses files over 50 MB until a registry value raises the limit (`FileSizeLimitInBytes`, at most 4 GiB), and is slow on large folders. Fine for documents and photos. Settings → Devices gives the steps and the registry line.
  - *rclone* (`rclone mount dfs: X: --vfs-cache-mode full`, with WinFsp on Windows or macFUSE on a Mac): reads by Range and keeps what it read on the local disk, writes to a local cache and uploads on close, any size up to D38's cap. The way for video, large files and heavy use. In its `owncloud` mode it sets files' modified dates with an `X-OC-Mtime` header, which DFS honours.
  - *macOS Finder* (Go → Connect to Server): mounts read-only from a server without locks, which DFS has (below). It sends files without their length up front (to check: it should send `X-Expected-Entity-Length`), and writes `._name` and `.DS_Store` files beside the user's.
  - *Linux:* GNOME Files and KDE Dolphin (`davs://`), and davfs2.
  - *Phones* have none built in (an iPhone's Files mounts SMB alone); file managers do (Documents on an iPhone, Solid Explorer on Android, and others). On a phone the web app stays the way in.
- **Paths:** `/dav/` is the user's root folder and `/dav/Photos/2024/a.jpg` a file in it, by name (UTF-8, percent-encoded), found folder by folder by `name_key`, so a path matches ignoring case, as Windows and macOS expect. A folder can be mapped by its own path. The trash isn't shown, nor are files still uploading (`uploading` versions). A locked folder (§7.7) shows as an empty folder that refuses writes (`403`), even while it is unlocked in a browser, since a device token can't unlock it; showing it keeps its name from being taken from the mount by mistake.
- **Methods** (WebDAV classes 1 and 2):
  - `PROPFIND`, depth 0 or 1; infinity is refused (`403` with `propfind-finite-depth`, as RFC 4918 allows). The listing's keyset pages are read one after another into one streamed answer, so a folder of 100,000 files is a long answer, never a large one in memory. Properties: `resourcetype`, `getcontentlength`, `getlastmodified` (Modified, §5), `creationdate`, `getetag` (a file's current version's ID), `getcontenttype`, `displayname`, `quota-used-bytes` and `quota-available-bytes` (RFC 4331, which Windows shows as the drive's size and free space), `supportedlock` and `lockdiscovery`, and Windows' `Win32FileAttributes` (hidden for a name that starts with a dot).
  - `GET` and `HEAD`: the content route's reader (§6.2), with Range, the ETag, `If-Range`, read-ahead and the frame cache. `HEAD` reads nothing.
  - `PUT`: an upload, made and completed in one request. Its size comes from `Content-Length`, or from Finder's `X-Expected-Entity-Length`; with neither, `411 Length Required`. The body is streamed in as `PUT /uploads/:id/content` is, the API hashing each part itself: there is no client hash to compare, and TLS covers the way. A name that exists gets a new version (D20), replaced without asking, since a mount can't ask; the file keeps its node and play positions, and the version replaced is purged, its share links deleted (§5.1, D42; there is no history, §1.2). D38 applies: `413` for a file too large, `503` with `Retry-After` while staging is full, and `507 Insufficient Storage` when the quota is spent. A `PUT` broken off gives up its upload and leaves nothing. It completes as the web app's uploads do, without waiting for the disk (D43), so a crash of Postgres or the VPS can forget about the last second of `PUT`s already answered `201`, which a mount won't send again: a new file is gone, a replaced one has its earlier content back. The user accepted that rare loss over making devices' completions wait for the disk (2026-10-12). A file's modified date is the upload's time, unless `X-OC-Mtime` gives one (rclone) or Windows sets one after writing (`PROPPATCH` of `Win32LastModifiedTime`), either of which sets the version's `modified_at` and the file's Modified.
  - `PROPPATCH`: the modified date, as above. Other properties are answered as set and not kept: Windows sets creation times and attributes on every file it writes.
  - `MKCOL`: a folder.
  - `DELETE`: to the trash (§6.4), restorable for `TRASH_RETENTION_DAYS`, with one audit entry per item, as from the web app. A mount makes deleting a whole tree one keystroke, and Explorer's deletes on a network drive skip the Recycle Bin. One exception keeps the trash from filling with editors' scratch files (`~$Report.docx`, `.~lock.Report.odt#`, `Report.tmp`, written and deleted on every save): a file whose only version this user's mount made in the last 10 minutes (`file_versions.device_id`, §7.6) is deleted for good.
  - `MOVE`: renaming and moving, metadata only, as `PATCH /nodes/:id`. Onto an existing file (`Overwrite: T`, which is how many editors save safely: write a temporary file, then rename it over the original), the moved file's current version becomes the next version of the file it replaces, numbered after that file's last, so that file keeps its node and positions; the version replaced is purged, and its share links deleted, as with `PUT` (D42); and the moved node is deleted for good, with its links, as a purge takes them. That is metadata only too, since a version's data key is bound to the version's ID, not its node (§7.3). It is journaled as `version.stored` again, with the version's new node and number (a record carries its entity's whole state, so replaying both is harmless, §8), the replaced file's `node.upsert`, and the moved node's `node.purge`. Onto an existing folder, that folder goes to the trash first. `Overwrite: F` onto an existing name is `412`. To check: Word's save, which on a network drive is said to rename the original aside (`~WRL0001.tmp`), rename its new file into place, then delete the original. Taken as it comes, every save would make the document a new node, losing its positions and leaving a copy in the trash. Either way a save replaces the file, so a link to a document edited through the mount is deleted at its next save (D42). If Word does that, the mount recognises the swap (a file given, within a minute, a name this mount renamed another file away from) and keeps the original node, with the new content as its new version.
  - `COPY`: `501 Not Implemented`, since there is no server-side copy (D3), and a client copies by reading and writing. To check: whether Explorer and Finder fall back to that within the drive or refuse the copy. If they refuse, copying within the drive goes back to the user as a question about D3; it isn't changed quietly.
  - `LOCK` and `UNLOCK`: exclusive write locks (depth 0 on a file, or infinity on a folder), at most an hour each and renewed by the client, kept in Postgres (`dav_locks`) so every API instance agrees. A write without the lock's token (the `If:` header) to something another client locked is `423 Locked`. Without locks, Finder mounts read-only and Office won't edit in place. They only keep one user's devices apart: nobody else writes to someone's drive. They aren't journaled, so a recovery forgets them as it forgets sessions, and the drill leaves the table out with that reason.
  - `OPTIONS`: `DAV: 1, 2` and the methods. Windows probes the site's root address before it maps a drive (to check), which Caddy answers with the web app today: `OPTIONS /` must reach the API, which answers it as WebDAV, while `GET /` stays the web app.
  - `POST` is refused (§7.6 says why).
- **Finder's files** (`._name`, `.DS_Store`): refused with `403`, which keeps them out of the web app's folders, if Finder copes with the refusal (to check); otherwise kept like any file.
- **Names Windows can't hold** (`\ : * ? " < > |`, or a name ending in a dot or a space), which the web app allows, are listed as they are: Windows' client shows them garbled or not at all, and rclone encodes them. DFS doesn't rename them.
- **Caddy** (§3.2): `/dav/*` and `OPTIONS /` go to the API as `/api/*` does, without the 22 MiB body limit (a `PUT` is a whole file, which the API checks against its upload), unbuffered (`flush_interval -1`), and compressing `PROPFIND`'s XML but never a file. Caddy passes WebDAV's methods as it passes any.
- **Metrics:** WebDAV requests by method, failures, and bytes each way go on the API's graphs (§16) as `dav.*`; file reads are logged and graphed as any download is.
- **Tests:** the mock API lives in a browser, so the contract suite has no WebDAV part. The API's tests cover each method against Postgres and the local store; `litmus`, WebDAV's conformance suite, runs against a stack; and the clients above are checked by hand (docs/TESTING.md).

### 6.9 Desktop backup app

*Planned, not built (D40).* A program on the user's computers that backs their folders up to their drive by itself (the user, 2026-10-11: "auto backups/sync with local machines directly to my dfs account"). It backs up **one way**, from the computer to DFS (the user's decision, 2026-10-11): what changes on the computer reaches the drive, and nothing in the drive changes the computer except a restore the user asks for. It is a **mirror without history** (the user's decision, 2026-10-11): the drive holds each file as it is now, as everything in DFS does (§1.2). Deleted files are kept in the trash for 30 days, and a run pauses when too much changes at once.

- **The app:** `apps/desktop`, Windows first: a tray icon, started at sign-in, backing up while its user is signed in to Windows. It is not a service, so nothing runs while signed out, and files open in other programs are retried rather than copied from a shadow copy, which needs administrator rights; both can come later. It is built with Electron, so it is TypeScript like the rest: its window (sources, progress, problems, restore, settings) is React with the web app's components and Tailwind, and it speaks to the API with `@dfs/shared`'s schemas. The engine is a package of its own (`packages/backup-engine`), plain Node with no Electron in it, so a command-line `dfs-backup` for Linux servers can come later at little cost.
- **Signing in:** pairing through the browser (§7.6), which gives the app a device token of kind `backup`; the app never sees the password. It keeps the token in Windows' credential store (DPAPI, through Electron's `safeStorage`).
- **Sources and targets:** each source is a folder on the computer, backed up to a folder of the drive, by default `Backups/<computer name>/<folder name>` (made if missing). Any folder may be chosen except one inside a locked folder (§7.7); a target belongs to one source, so two computers can't replace each other's files (the server refuses a second). The target is an ordinary folder: browsed, previewed, downloaded and shared in the web app. The server keeps a row per source (`backup_sources`: its device, its target, the local folder's path, its last completed run, its files and bytes, its problems), which the app reports after each run and every few minutes during one. Settings → Devices lists them. The target folder says where it comes from ("Backed up from ALEX-PC · 5 minutes ago"), and editing inside it warns that changes there aren't copied back and may be replaced by the next change on the computer. An alert (`backup_stale`, for its owner in Settings and on the folder, and as a count on the admins' overview) says when a source hasn't completed a run for `BACKUP_STALE_DAYS` (3): a backup that has stopped is the failure nobody sees otherwise.
- **Finding changes:** a full scan at start and every 6 hours, and between scans Windows' change notifications for each source (`fs.watch`, recursive, which is `ReadDirectoryChangesW`), uploading a file once it has stayed unchanged for 30 s. Notifications get lost (a full buffer, the app not running), and the scans make up for them. A local index (SQLite, in the app's data folder) keeps, per file, its path, size, modified date and NTFS file ID, and the node and version uploaded. A file whose size and date match its row isn't read, as rsync does; Check contents, in the app, hashes everything once against the drive's chunk hashes (`content_hash`, §5).
- **Checking the index against the drive:** at start and at each full scan, the app reads what its targets hold (`descendants`, below) and sends again every file the drive lacks, or holds at an earlier version than its row says (`version_no`). Uploads complete without waiting for the server's disk (D43), so a crash of the server can forget about the last second of them, files the index already counts as backed up; the check finds them within 6 hours (the user's choice, 2026-10-12, over making devices' completions wait for the disk). A file deleted from a target in the web app or the mount is lacking too, so it comes back; one replaced there (a later version) is left until it changes on the computer, as the target's warning says.
- **Renames and moves** are found by file ID (`fs.stat`'s `ino`, which on Windows is the NTFS file index): a file or folder whose ID turns up under another path is renamed or moved in the drive (`PATCH /nodes/:id`, metadata only) rather than deleted and uploaded again. Renaming a folder of 10,000 photos is one move.
- **Uploading** goes through the API as the web app does (§6.1, §10.2): folders with `/folders/ensure`, small files in batches (`/uploads/batch`, then one `PUT` each), large ones streamed with their parts' hashes, sessions kept alive (`/uploads/alive`), retries with backoff, `ifExists: 'replace'`, and the file's modified date. A file that changes while it uploads (its size or date moved) is uploaded again once it settles. One that another program holds open and won't let be read (Outlook's mail file while Outlook runs) is retried at each run and listed in the app. Files over D38's cap are skipped and listed. Symbolic links and junctions aren't followed (a Windows profile has junctions that loop), and by default the app leaves out `Thumbs.db`, `desktop.ini`, Office's `~$` files, `*.tmp`, `$RECYCLE.BIN` and `System Volume Information`, plus patterns of the user's for each source.
- **Deletions:** a file the app uploaded that is gone from the computer goes to the drive's trash, kept 30 days (§6.4), then deleted as anything in the trash is. The app touches only what it put in the drive: files added to a target through the web app or the mount are never replaced or deleted by it.
- **No history** (§1.2): a changed file replaces the one in the drive, and the version replaced is purged at once, its share links deleted (§5.1, D42). Keeping replaced versions for 30 days was offered and declined (the user's decision, 2026-10-11). What keeps bad changes from reaching a backup (ransomware encrypting files, a failing disk, a folder emptied by mistake) is the pause below, and the trash for deletions.
- **Pausing when too much changes:** a run that would replace or trash, within an hour, more than 50 files and more than 10% of a source's (both settings of the app) stops before doing so, shows what it would do (how many, and some of them), and waits for Continue or Stop in the app. The source's row says so, and the web app shows it on the folder and in Settings. A source folder that is missing or empty (a disk unplugged, a network share down) is never taken as everything deleted: its run stops and says why.
- **Sharing the server:** an upload speed limit, pausing on a metered connection and on battery (Windows says both), a Pause button, and an optional time window. Uploads share staging and Discord's rate limits with everyone: the server already makes uploads wait when it can't keep up (§6.1), and the app waits as it is told.
- **Restoring:** the app downloads a target, or a folder in it, to a folder the user chooses, with each file's modified date, resuming with Range after a break and skipping files whose size and date already match. To learn what a target holds (a first run on a new install, a restore, Check contents), `GET /nodes/:id/descendants` streams a whole subtree in one answer (newline-delimited JSON: each item's path inside the folder, kind, size, modified date, version and content hash), read in keyset order on the server, rather than a request per folder. The web app's ZIP (§6.2) stays the way to pick out a few files.
- **Updates:** the installer and its updates come from DFS itself (Caddy serves `/downloads/`, which `docker/deploy.sh` fills; electron-updater's generic provider, checked daily). An app older than the API accepts gets `426` with the version it needs, stops backing up and asks to be updated. It isn't code-signed at first, so Windows SmartScreen warns on its first install; a signing certificate, paid yearly, would end that.
- **Recovery:** sources aren't journaled. After a recovery each computer pairs again (§7.6) and links its sources back to their folders, whose files it still knows by their node IDs, which recovery keeps.
- **Not planned now:** two-way sync (it needs a feed of the drive's changes, which the journal can't be, since its rows are pruned a week after they reach Discord, §8, and conflict handling), apps for macOS and Linux (the engine is ready for them), backing up while signed out, and copying files held open through Volume Shadow Copy.

---

## 7. Security

### 7.1 Authentication: usernames and passwords

- **No Discord accounts (D27).** People sign in with a username and a password. Discord is only the storage layer: the server is private to the owner, and users never join it.
- **An admin makes every account (D27).** On the Users page, an admin enters a username, a display name, a quota, a role and a **temporary password** (typed or generated), and hands the username and password to the person. There is no sign-up and no email.
- **First sign-in:** a temporary password opens a **limited session** that can only choose a new password. Until then, the API answers every other route with `403 password_change_required`; only `GET /auth/me`, `POST /auth/password` and `POST /auth/logout` work, and the session lasts 15 minutes. Choosing a password **activates** the account (`activated_at`). A temporary password expires after `TEMP_PASSWORD_DAYS` (7); signing in with an expired one answers `403 password_expired`, and an admin sets a new one.
- **Forgotten passwords:** an admin sets a new temporary password on the Users page. That ends all of the user's sessions, and they choose a new password at their next sign-in. The sign-in page's **Forgot your password?** asks for one by username (`POST /auth/password-reset`): there is no email yet, so only an admin can tell it's really that person, and the request goes to the admins. Admin → Users marks the account and the overview raises an alert, until an admin sets a temporary password or the person signs in. The answer is the same whether or not the account exists; an account's request is recorded once in 15 minutes and audited, and one address may ask 5 times in 15 minutes. An email with a link will replace the admin's part.
- **The owner (D28)** is created on the server with `dfs owner`, a command in the api image that prints a temporary password. Run again, it gives the existing owner a new temporary password and ends their sessions. That is how the owner gets back in, since there is no email. The owner is a flag in the database, always an admin, and nobody can demote, disable or reset the owner from the app. Any admin can make other users admins.
- **Passwords:** hashed with argon2id. 12 to 256 characters of any kind, with no rules about character classes. The API refuses the username itself and common passwords: the ones among SecLists' million most common that are long enough to pass the length rule, about 30,000 (MIT licensed, `apps/api/src/auth/common-passwords.LICENSE`). Changing a password needs the current one (except in the limited session above) and ends the user's other sessions.
- **Sign-in protection:** an unknown username and a wrong password get the same `401 invalid_credentials`, and an unknown username is still checked against a dummy argon2 hash, so the response time doesn't tell them apart. `account_disabled` and `password_expired` are only answered after a correct password. Sign-in is rate-limited per IP and per account: after 10 failures in a row, the account must wait before the next try, starting at 1 minute and doubling up to 1 hour (`429` with `Retry-After`); a successful sign-in resets that. Sign-ins, failed sign-ins, password changes and resets go to the audit log.
- **Sessions** are server-side rows in Postgres, referenced by an `HttpOnly; Secure; SameSite=Lax` cookie with a sliding 30-day expiry. Every sign-in and password change gets a new session ID. Disabling a user ends their sessions at once.
- **CSRF:** every state-changing request needs a CSRF token header, except `POST /auth/login` and `POST /auth/password-reset`, which come before there is a session. Those routes accept only requests whose `Origin` is `PUBLIC_BASE_URL`, and are rate-limited as above (like share unlock, §7.5).
- **Development** signs in the same way; `dfs owner` makes the first local account.

### 7.2 Authorization

- Every node has an `owner_id`. A user can only access nodes in their own tree, plus anything reached through a **share link**. A share grants read access to the shared node and, for a folder, to its non-trashed subtree.
- **Admins** (D4) can manage users and quotas, see system health, and **view any user's metadata**: file names, folder tree, sizes, dates, and usage. This is for moderation. Admin access is **metadata-only**: content, preview, archive, and share routes still require ownership. Admins can move a user's item to trash with a reason (moderation). Removing an item also deletes every share link to it or to what's inside it, expired and used-up ones included, so restoring it brings none back; the dialog says how many beforehand (`GET /admin/nodes/:id/links`), and the result, the toast and the audit entry say how many went. Every admin metadata view and action is written to the audit log.
- All authorization checks run in the API service layer in one place (`assertCanReadMetadata(node, actor)` / `assertCanReadContent(node, actor)` / `assertCanWrite(node, actor)`), and route handlers never skip them.
- *Planned:* locked folders (§7.7) add one rule to these checks: nothing inside a locked folder is read or listed unless the session has it unlocked. Device tokens (§7.6) reach only the routes of their kind.

### 7.3 Encryption

```mermaid
flowchart TD
    MK["MASTER_KEY (256-bit)<br/>Docker secret, key_id = 'k1'"]
    DEK["Per-version DEK (256-bit, random)"]
    WDEK["wrapped_dek in file_versions<br/>AES-256-GCM(MK, DEK,<br/>AAD = 'dfs1-dek'|key_id|version_id)"]
    CH["Frame for chunk i<br/>AES-256-GCM(DEK, nonce_i,<br/>AAD = header|0x01|version_id|i)"]
    MK -->|wraps| WDEK
    DEK -.-> WDEK
    DEK -->|encrypts| CH
```

- **Envelope encryption:** each file version gets a random data key (DEK). Only the wrapped DEK is stored. The wrap uses `AAD = "dfs1-dek" | key_id | version_id`, so a wrapped DEK copied onto another version fails to unwrap.
- **Frame format** (self-delimiting, so packs can be parsed without the DB), in two formats under one magic:
  - **Format 2, file chunks (D37):** `magic "DFS1" (4B) | format ver 2 (1B) | flags 0 (1B) | plaintext length (4B, BE) | segment size (4B, BE) | segments`, each segment `nonce (12B) | ciphertext (up to 256 KiB) | GCM tag (16B)`. The plaintext is sealed in segments of 256 KiB, the format's size and no other, so a reader can check part of a chunk before the rest arrives (§6.2). Overhead is 14 bytes plus 28 per segment: 2,254 bytes for a 20 MiB chunk.
  - **Format 1, journal batches and chunks stored before format 2:** `magic "DFS1" (4B) | format ver 1 (1B) | flags (1B) | ciphertext length (4B, BE) | nonce (12B) | ciphertext | GCM tag (16B)`, one seal over the whole plaintext. Overhead is 38 bytes per frame.
  - A chunk's format, and in format 2 where each segment is, follow from its plaintext and frame sizes in the database (format 1 adds exactly 38 bytes, format 2 never does), so a reader asks Discord for the segments it needs without reading the header first.
- **Segment AAD** (format 2) = the 14 header bytes, the segment's index (4B, BE), whether it is the last (1B), then the typed context below: a segment can't be moved, dropped, or passed off as the end, and a changed header fails every segment. A reader rebuilds the header it expects from the database, so it checks a segment without the frame's header.
- **Frame AAD** (format 1) = the first 10 header bytes (magic, format version, flags, length) followed by a typed context. The GCM tag therefore authenticates every header field by itself. That matters during recovery (§8), when there is no `frame_sha256` from the DB to check against. The leading type byte keeps one kind of object from passing as another:

  | Object | AAD context after the header |
  |---|---|
  | File chunk | `0x01` \| `version_id` (16B) \| chunk index (4B, BE) |
  | *Reserved: thumbnails (§1.2)* | `0x02` \| `version_id` (16B) |
  | Journal batch (§8) | `0x03` \| batch number (8B, BE) |
  | Backup manifest (§8) | `0x04` \| snapshot number (8B, BE) |
  | Subtitles kept in the database (§6.7) | `0x05` \| `version_id` (16B) \| stream index (4B, BE) |
  | A share link's token, kept (§7.5) | `0x06` \| `share_id` (16B) |

- **Objects without a file version** (journal batches, backup manifests, and the subtitles and share tokens kept in the database) each get their own random DEK, stored in front of the frame as `key_id | wrapped_dek`. That wrap's AAD uses the object's context in place of a version ID.
- **Sizes:** `BLOB_MAX_BYTES = DISCORD_ATTACHMENT_LIMIT − 64 KiB` caps every attachment. `CHUNK_SIZE` is the largest multiple of 64 KiB that still fits one frame under that cap. At the 20 MiB limit, that is 20 MiB − 128 KiB (20,840,448 B), so a solo blob is at most 20,842,702 B (format 2).
- **Nonces** are 96 bits and random per frame, and per segment in format 2. A DEK encrypts one version: about 4.2 million segments for a 1 TiB file, far below the roughly 2³² messages per key at which random nonces become a concern.
- **Key rotation** *(designed, not built)*: add a new master key with a new `key_id`, then a background job re-wraps the DEKs in the DB. **No data in Discord has to be re-uploaded.** Retired keys must be **kept**, though: journal batches, backup manifests, and the wrapped DEKs inside journal records stay encrypted under the key that was current when they were written. What exists is the key file's format, which holds the current key and every retired one, and every reader of it (`MASTER_KEY_FILE`, §15); there is no command or job that makes a new key current or re-wraps.
- **Key loss = data loss.** `dfs master-key <file>` writes the key and never overwrites one; keeping a copy off the server is the operator's job (docs/DEPLOY.md §3). Nothing in the app asks for it.

### 7.4 Threat model summary

| Adversary | Protected? |
|---|---|
| Discord (or anyone who gets into the guild) reads stored data | ✅ They see only ciphertext and numeric IDs. File names, sizes per file, and folder structure are not in Discord in plaintext. |
| Stolen DB dump without the master key | ✅ The DEKs are wrapped. Metadata (file names, tree) **is** exposed. |
| Stolen staging/cache disk | ✅ Ciphertext only |
| Malicious or compromised DFS server operator | ❌ The server holds the keys. Fixing this needs E2EE (future: per-user keys derived in the browser, client-side encryption, and more complex sharing). |
| DFS admin curious about other users | ⚠️ By design (D4), admins **can see file names, the folder tree, and sizes**, but cannot open or download content through the app. Every admin view is audit-logged. A locked folder (§7.7, planned) shows them its size and file count alone. |
| *Planned:* a stolen DB dump against a locked folder (§7.7) | ✅ Names, types and data keys inside are sealed under the lock code. With the master key as well, an attacker can try codes offline at argon2id's pace (64 MiB and 3 passes a try): every six-digit PIN in a few days on one core, hours on many, so a long code is what makes that hopeless. Files that were in DFS before going in are re-encrypted and their old frames deleted from Discord; their earlier names stay in journal batches on Discord, under the master key. Sizes, dates and the tree's shape are exposed. |
| *Planned:* someone at a browser where a locked folder is open | ⚠️ They see inside until it locks itself (15 minutes with nothing done inside) or is locked. |
| *Planned:* a stolen device token (§7.6) | ⚠️ It reaches what its kind reaches until it is removed: the drive's files through the mount, or the backup app's routes. Never locked folders, share links, settings or admin. |
| Someone who has a stream link (§6.7) | ⚠️ It plays that one file without the share link's password, as long as the link works: it stops when the link is turned off or expires, its password changes, or the file is deleted, as the link does. It is public by design, as share links are; the API keeps its token out of the logs. |
| A crafted audio or video file exploiting ffmpeg | ⚠️ Contained: the media service holds no key, database access or token, and reaches only the API, through which it reads the files it is asked to play (§6.7). |
| Compromised Caddy container | ⚠️ No keys, DB, or Discord token in it, but it sees traffic passing through (including session cookies). |
| Root on the VPS | ❌ It's a single host, so root can read everything. Harden the VPS (§13.2). A locked folder (§7.7, planned) holds out until its owner next opens it, as far as its code resists guessing offline: the server sees the code and the files then. |
| Discord deletes data or bans the bot | ❌ Detected, not prevented. See §2. |

### 7.5 Other hardening

- Downloads are served with `Content-Disposition: attachment` by default. Inline previews use a strict CSP and `X-Content-Type-Options: nosniff`, and HTML/SVG are always served as attachments, never inline.
- Share-link tokens are 128-bit random values. A request's link is found by its SHA-256; **the token itself is kept, sealed**, so its owner can copy the link again whenever they like, from Shared links, the link's edit dialog, or Share on the item, which lists its working links above the form for a new one (the user's decision, 2026-10-09: sharing publishes, and a link is no secret from its owner). It is sealed as a journal object is (§7.3, its own data key, bound to the link's ID), so a stolen database dump holds no working link (§7.4). It is journaled sealed, and a recovery writes it back as it was. Only the owner's routes open it (`GET /shares`, `PATCH /shares/:id`); Admin → Access lists links without it (D4). Links made before tokens were kept (migration 0026) have none, and can't be shown again: their owner makes a new one. **Turning a link off deletes it**, whether its owner or an admin does: it stops working at once, answers like a link that never existed (`404 share_not_found`), and leaves both link lists; the audit log keeps the entry. **A file link shares the file as it was when the link was made** (`share_links.version_id`, its version then), **and is deleted when the file is replaced** (D42), as the upload completes, so a link never shares something its owner didn't share: it then answers like any link turned off (`404 share_not_found`), and its owner makes a new link to share the file as it is now. A link being made when the replace completes waits for it and shares the new file, or is made first and deleted with the rest. A file can only be shared once its first upload completed. A folder link serves its files as they are, replaced ones included, as it does files added to it. **The web app warns before an action changes what links do:** moving items to the trash asks first when outstanding links (not expired or used up) reach them or anything inside them, which stop working while they are there; deleting forever and emptying the trash say how many links go with them; replacing a file says how many of its links it deletes. It counts them with `POST /shares/count` (`{ids}`, subtrees included, or `{trash: true}`). Optional password (argon2id), expiry, and download cap, all editable later. A password-protected link reveals nothing, not even the item's name, until a correct password (`POST /api/s/:token/unlock`) sets a short-lived cookie scoped to that share, HMAC-signed with a key derived from the master key and bound to the share's password version, so changing the password invalidates those cookies. The share routes have no session, so `POST /api/s/:token/unlock` is exempt from the CSRF token check (§7.1); it is protected instead by rate limiting, an `Origin` check, and a `SameSite=Strict` cookie whose path is `/api/s/:token`. The only other route under a link that takes a body, a viewer's play report (`POST /api/s/:token/files/:id/playback-report`, §10.4), checks `Origin` too, and takes 60 in 10 minutes from an address. A file download counts toward the cap only when the request starts at byte 0, so seeking in a video doesn't use it up; a ZIP (`GET /api/s/:token/archive`) counts as one download. A preview never counts (`?preview=1`, §10.3): the cap limits downloads, and looking is free, as often as the recipient likes (the user's decision, 2026-10-08). A preview is the whole file all the same, so the cap limits the Download button, not who can keep a copy: anyone with the link could ask for one as a preview. Nor does a browser that has the file count (`304`, §6.2). Once the last download is used, the link is dead, its previews too.
- Stream links (§6.7) carry a signed token in their address, for a file through one share link, lasting as long as the link; the API's logs show their addresses without it, and Caddy keeps no access log.
- Sign-in (§7.1) and share-link access are rate-limited.
- An audit log records sign-ins, password changes and resets, completed uploads, moving to the trash, restoring and deleting for good (one entry per item, not per file below it), shares, and admin actions. It keeps a year: the leading bot's janitor drops older entries. Every entry is journaled (§8), so a recovery brings the log back with the data.
- Internal API→bot RPC runs only on `dfs_internal`, needs a shared `INTERNAL_RPC_SECRET`, and is blocked at the edge.
- **Network exposure** (D2): only Caddy publishes ports. `api`, `bot`, and `postgres` publish **no** ports. Postgres is on the internal network only and has no egress.
- Containers run as non-root, with read-only root filesystems where possible, `no-new-privileges`, and dropped capabilities.

### 7.6 Device tokens

*Planned, not built (part of D39 and D40).* A credential for one device and one use, for what can't hold a browser session: the mount (§6.8), of kind `dav`, and the backup app (§6.9), of kind `backup`.

- **What it is:** 32 random bytes (`dfs_` and base64url), found by its SHA-256 (`device_tokens`: its user, name, kind and hash, when it was made and last used (every 5 minutes at most, as sessions), and the address and program last seen). It is shown once, when made, and never kept: unlike a share link (§7.5) it is a credential, not something to publish.
- **Making one:** in Settings → Devices. *Add a network drive* asks for a name ("Laptop") and shows the username, the token as the password, the address, and the steps for Windows, macOS, Linux and rclone. The *backup app* pairs through the browser, as a native app signs in with OAuth (RFC 8252, with PKCE): it listens on `127.0.0.1` at a free port and opens `/devices/pair?name=…&port=…&challenge=…` in the browser, where the signed-in user approves it ("Let DFS Backup on ALEX-PC back up to your drive?"). That approval, `POST /devices/pair` with the session and its CSRF token, answers a one-time code good for a minute; the page sends the browser on to the app's address with the code, and the app trades the code and its verifier for the token (`POST /devices/token`, without a session, limited per address). The user's password never reaches the app.
- **Using one:** the mount signs in with HTTP Basic (the username, and the token as the password). The account password is never accepted there, which keeps argon2 off every request and the password out of the computer's credential store. The backup app sends `Authorization: Bearer`. Each route says which kinds it takes (the routes' `access`, §7.1, gains `device:dav` and `device:backup`): `dav` reaches `/dav` alone, and `backup` the routes the app uses (listings, `/folders/ensure`, uploads, moving, renaming and trashing, content, `descendants`, its sources' reports) and nothing else: no share links, settings, devices, passwords or admin, whatever the account's role. Neither needs a CSRF token, since neither comes from a cookie. A browser does send HTTP Basic credentials it has stored with requests other sites make, but the only one another site can send to `/dav` is a `GET`, whose answer it can't read: a form can `POST`, which `/dav` refuses, and WebDAV's other methods need a CORS preflight, which `/dav` never grants.
- **How long:** until it is removed. A device token ends when its user removes it in Settings → Devices, or an admin does in Admin → Access, which lists them beside sessions; when the user changes their password or an admin resets it, as other sessions end (§7.1); when the account is disabled; and with Sign out everywhere. A device that has lost its token asks to be paired again.
- **What it leaves:** the versions a device uploads name it (`file_versions.device_id`), for the mount's deletes (§6.8) and to say which computer a file came from. Failed tokens are limited per address as sign-ins are (§7.1). Pairing, removal and failures go to the audit log.
- **Recovery:** device tokens aren't journaled, as sessions aren't: after a recovery, devices pair again. The drill leaves the table and `file_versions.device_id` out, with that reason.

### 7.7 Locked folders

*Planned, not built (D41).* Folders for what is most sensitive, opened only with a code (the user, 2026-10-11: "extra security for extra sensitive data, where you can only access using a code"). A locked folder is **sealed with the code** (the user's decision, 2026-10-11): the names and data keys inside are encrypted under a key that only the user's lock code, or their recovery key, opens. Neither a stolen database with the master key, nor an admin, nor DFS itself while the folder is locked can read what is inside. The server does see the code, and the files, while the user has the folder open: this protects data at rest, and isn't end-to-end encryption, which stays a non-goal (§1.2, §7.4).

- **For the user:** one *lock code* per account, chosen in Settings → Locked folders (at least 6 characters, so a six-digit PIN will do: the user's decision, 2026-10-11; choosing one says that a longer code seals better against someone holding the master key, §7.4), with a *recovery key* shown once (24 characters in groups of four, to print or save as a file). Any folder can then be locked from its menu (Lock folder), except one inside a locked folder or holding one. A locked folder shows a lock, its size and how many files it holds, and nothing inside; opening it asks for the code. Unlocking holds **in that browser only**, until 15 minutes pass with nothing done inside (`LOCK_IDLE_MINUTES`), the user locks it (Lock now, in the header while anything is open), signs out, or the session ends. Every locked folder of the account opens and locks together. Unlock folder (removing the lock for good) needs it open.
- **A forgotten code:** the recovery key sets a new one. Without either, what is inside can't be read by anyone: not admins, not the owner, not with the server's keys. The folder can still be deleted, with the account password, to free its quota. Changing the code needs the current one or the recovery key; a new recovery key can be made while a folder is open, and the old one stops working.
- **Keys** (§7.3): an account with a lock code has a *vault key* (256-bit, random), stored wrapped twice. Once under a key from the code: argon2id of the code with a salt of the account's (64 MiB, 3 passes), joined through HKDF with a key derived from the master key, so a database without the master key gives nothing to try codes against. Once under a key from the recovery key (HKDF alone: it is random enough). A version inside a locked folder has its data key wrapped by the vault key and then by the master key, in two layers that its `key_id` names, so rotating the master key re-wraps the outer layer without anyone's code. Names inside are sealed with a key derived from the vault key (AES-256-GCM, bound to the node's ID), and `name_key` becomes an HMAC of the normalized name under another, so the unique-name rule (§5.1) holds without the name. MIME types inside are sealed too.
- **Going in.** A file uploaded into a locked folder is sealed from its first byte. A file already in DFS, in a folder being locked or moved into one, is **re-encrypted** (the user's decision, 2026-10-11): its data key and names were journaled to Discord under the master key alone, and its frames are there under that key, so re-wrapping the key in the database would leave it readable to anyone with the master key and the journal.
  - Its current version gets a new data key, wrapped by the vault key as the work starts (the folder is open then) and kept wrapped by the master key alone while it lasts. Its chunks are read, decrypted, sealed again under the new key and stored as an upload's are (staged, packed and posted, within D38's staging room), which takes about as long as uploading it again. The work is a job of the API's, since it needs the master key, and carries on after a restart. Meanwhile the file is marked as going in, and is readable while the folder is open.
  - Once the new version is stored, it replaces the old one, whose frames are released. The GC deletes its solo blobs once the journal allows (§6.4), and the packs that held its frames are compacted at once, whatever their age and fill (§6.6), so the old ciphertext leaves Discord within minutes. Its links went as the folder was locked (below).
  - What stays outside is its earlier names, in journal batches already on Discord, sealed under the master key and readable only with it. In the database, journal rows that name it are dropped as soon as their batch is on Discord rather than a week later (§8), and earlier audit entries about it are rewritten to "a locked item" with the locked folder's ID, journaled as `audit.redacted` so that a recovery and the drill agree (the user's decision, 2026-10-11).
- **Coming out** (moving items out, or Unlock folder) is metadata only: data keys are wrapped by the master key alone again and names unsealed. Once out, a file is as any other.
- **What stays visible:** sizes, dates, counts and the tree's shape (which item is in which folder), which the quota, listings and folder sizes need, and the locked folder's own name, which is in the open folder above it.
- **Unlocking** (`POST /locked/unlock`, a full session only): the API derives the key from the code, unwraps the vault key, and keeps it in the session's row, sealed under a key derived from the session cookie's token, with when it locks. The database holds only that token's hash (§7.1), so a dump taken while a folder is open still can't open it, while every API instance can, for requests that carry the cookie. Wrong codes are limited per account as sign-ins are (10 in a row, then a wait that doubles from a minute to an hour) and audited. The code is used for the derivation alone, never logged or kept.
- **While open**, inside works as anywhere: browsing, previews, players, uploads, renaming, moving, the trash, downloads and ZIPs. An upload's data key is wrapped by the master key alone while its parts arrive, as now, and by the vault key as well when it completes, which needs the folder still open; the uploading page's requests keep it so. Names are sealed or unsealed in batches of 1,000, each its own transaction, while the page waits with progress; a move interrupted is finished at the next unlock. Re-encrypting what goes in runs on after the page has gone (above). A folder inside a locked one is listed whole, decrypted and sorted by the API, since the database can't sort sealed names, so it holds at most `LOCKED_FOLDER_MAX_CHILDREN` (10,000) items, refused beyond.
- **While locked**, every route that reaches inside answers `403 folder_locked`, and nothing lists what is inside. The queries that read many nodes at once (listings, search, lookups, paths, the ZIP planner, audio queues, the trash, admins' views and usage, `descendants`, WebDAV) filter on `locked_via`, as they filter on `trashed_via`, each with a test.
- **Never, open or not:**
  - share links and stream links of a locked folder or anything in it. Locking a folder with links inside says how many there are and deletes them, as an admin's removal does (§7.2);
  - search: the trigram index sees only sealed names. Searching inside while a folder is open, decrypting as it goes, can come later;
  - the mount and the backup app, which a device token can't unlock (§6.8, §6.9);
  - admins' views, which show "Locked folder", its size and its file count; their usage by file type counts its files as locked. Moderation can trash it with a reason without seeing inside (D4);
  - a folder's audio queue reaching into one (`deep=1`), and a ZIP of a folder above one, which leave it out. Download it on its own while it is open.
- **The trash:** items trashed from inside one are listed as "Locked item", with their size, until it is open, and are restored only while it is. Emptying the trash, and its expiry, delete them without any key, as purging needs none.
- **Media** (§6.7): the media service reads a version through the API with a token. For a version inside a locked folder, that token, made while the folder is open, carries the version's data key sealed under a key derived from the master key, so the service's reads work for its few hours without the session, and no copy of the key is kept. Media info and subtitles of such a version are kept sealed under the vault key, or not kept (decided when built). Play positions hold only times.
- **The audit log** names nothing inside a locked folder: its entries say "a locked item" and the locked folder's ID.
- **Journal and recovery** (§8): `node.upsert` carries the lock flag, the sealed names and the name keys; `user.upsert` the wrapped vault keys and the salt; `version.stored` the two-layer wrap. A recovery brings them back as they were, still sealed, and the code still opens them. The drill compares the sealed bytes as it compares any column. Which nodes are inside a locked folder (`locked_via`, set on descendants as `trashed_via` is, §6.3) is derived and recomputed; the vault key sealed in a session isn't journaled, as sessions aren't.
- **Columns:** `users` gains the salt, the two wrapped vault keys and its own count of failed unlocks with their wait; `nodes` gains `locked` (on the folder locked) and `locked_via` (derived); `sessions` gains the sealed vault key and when it locks.

---

## 8. Disaster Recovery

The design aims to survive **losing the VPS** (DB plus disks), as long as the Discord guild and the master keys survive. Recovery needs **only Discord and the key file**: everything it reads is found through other objects in Discord, never through the lost DB.

1. **Metadata journal (outbox pattern).** Every metadata change that matters for recovery is inserted into a `journal` table **in the same transaction** as the change. Records carry the entity's full state after the change, so replaying a record twice is harmless:
   - `user.upsert`, `node.upsert` (create, rename, move, trash, restore), `node.purge`
   - `blob.stored` (blob ID, kind, size, SHA-256, and its Discord location: the Discord channel ID, `message_id`, `attachment_id`), `blob.deleted`. Records name channels by their Discord ID, not by the database's own `storage_channels.id`, so they stay meaningful without the database.
   - `version.stored` (version metadata, wrapped DEK and `key_id`, and each chunk's blob ID, offset, size, and hashes), `version.purged`
   - `blob.relocated` (compaction, §6.6): `{id, chunks: [{versionId, idx, offset}]}`, the new pack and where each moved chunk is in it, named by its version and index as `version.stored` names chunks. Written in the transaction of the new pack's `blob.stored`, after it. Recovery moves the chunks of the versions it has; a version not journaled yet names its chunks where they are by then.
   - `share.upsert` (a share link's state, its token's hash in hex, and a file link's version; its download count is a usage counter and is left out, so a rebuilt link counts afresh), `share.deleted` (a link turned off; migration 0019 journaled one for each link revoked before links were deleted, and an older `share.upsert` with a `revokedAt` set means the same). A `node.purge` takes the item's links with it. A file link whose version was purged (`version.purged`) serves nothing, as in the database, where the purge clears its `version_id`.
   - `audit.added` (an audit log entry as written, §7.5), in the transaction of the action it records, so the log survives with the data. Entries written before this record existed were journaled by migration 0016, as were share links.
   - *Planned:* locked folders (§7.7) add the lock flag and sealed names to `node.upsert`, the wrapped vault keys to `user.upsert`, and `audit.redacted` (earlier audit entries about a file that went into a locked folder, rewritten without its name). Device tokens, WebDAV locks and backup sources aren't journaled (§7.6, §6.8, §6.9): devices pair again after a recovery.

   Derived values (`live_bytes`, `used_bytes`, `folder_stats`, `nodes.trashed_via`, channel counters) are not journaled. Recovery recomputes them.

   Uploads still under way are not journaled either. An upload lives in its page (§6.1) and can't survive the VPS, so a file joins the journal with its first completed version, and a version once it is stored: starting, renaming or giving up an upload not yet complete writes nothing.
2. **Commit order.** A transaction writes its journal records last, right after taking a transaction-scoped advisory lock (`pg_advisory_xact_lock`), so `journal.id` order is commit order. Without this, a transaction that took a lower ID but committed later could be skipped by both the flusher and a snapshot's high-water mark. The cost is that journaled commits are serialized, at about one fsync each (completions, which don't wait for it, excepted, D43), so they top out near 1 ÷ fsync latency (hundreds to a few thousand per second on an SSD). That is fine at this scale, because bulk work is journaled once per batch or per pack, not once per file.
3. **Journal batches.** A singleton job (`journal.flush`, in the API because it needs the master key) runs every `JOURNAL_FLUSH_INTERVAL_MS` (60 s) or as soon as 5,000 records wait. One API instance flushes at a time (a lock of its own, never the journal's, which every journaled write takes). Each batch is sealed in a transaction of its own, which takes the next number and gives it back if it rolls back, so numbers stay contiguous; the sealed bytes wait in `journal_batches` until the leading bot posts them, in number order, and then only Discord holds them (rows of batches posted a week ago are pruned). The plaintext is `{v, instance, batch, records: [{id, kind, at, record}]}` as JSON, gzip'd (frame flag `0x01`), sealed as an object (§7.3: `key_id length | key_id | wrapped DEK | frame`); a record too large for a batch is cut into pieces, one per batch, `{piece: {id, index, count, data}}`, all sealed in one transaction, and recovery joins their `data`. A batch takes the unflushed records in ID order and is cut at about 8 MiB, so it always fits in one attachment. Records written while a flush seals wait for the next one, so a flush adds one message unless more than a batch's worth was waiting (AAD type `0x03`, §7.3); only a `version.stored` of a multi-terabyte file is large enough to need pieces. The bot posts each batch to `#dfs-journal` (`journal.upload`, message format in §4). This adds **one message per batch, not one per file**, which matters when there are millions of files.
4. **DB snapshots** *(designed, not built: recovery replays the whole journal until they are, step 5)*. A nightly `backup.snapshot` job would run in the API (it holds the keys, and its image would ship `pg_dump` 18):
   - It opens a `REPEATABLE READ` transaction, exports its snapshot, and reads the high-water mark (`max(journal.id)`) inside it. `pg_dump --snapshot=…` then dumps that same snapshot, so the dump holds exactly the changes up to the high-water mark.
   - The dump (custom format) is streamed into a DFS file owned by a system account. Backup files are **always stored as solo blobs**, never packed, so compaction never moves them.
   - Once the dump's version is `stored` in Discord, the API seals a **manifest** (AAD type `0x04`) holding everything needed to fetch the dump without the DB: version ID, size, chunk size, `content_hash`, wrapped DEK and `key_id`, and each chunk's `channel_id`, `message_id`, and `attachment_id`. The bot posts it to `#dfs-backups` with the snapshot number and high-water mark in the message content (§4).
   - The newest `BACKUP_RETENTION` (default 7) snapshots are kept. Older dumps are purged like any file, and their pointer messages are deleted. Journal batches are kept forever, so a full replay stays possible.
5. **Recovery tool:** `dfs recover --into <database-url> [--from discord|local] [--instance <id>] [--key-file <…>]`, where the key file holds every `key_id`, current and retired (`apps/api/src/recover/`). It only reads Discord (or the local blob store), and only writes into a new, migrated database that holds no user or item:
   1. *(With snapshots, which aren't built:)* read the newest pointer in `#dfs-backups`, decrypt its manifest, download and verify the dump straight from the listed messages, and `pg_restore` it. Until then there is no snapshot, and the tool replays the whole journal from the first batch.
   2. Read `#dfs-journal` in the environment's category and open every batch. Each must say the batch number and record range its message says, and belong to the database being recovered: development stacks share a category and a key, so with batches of several databases the tool asks which (`--instance`). A batch found twice with the same bytes is read once (a retried post can land twice, past Discord's nonce window); twice with different bytes, or a number missing, stops the tool, which names the batches, rather than replay a journal with a hole. Records cut into pieces are joined, and records are replayed in ID order, which is commit order.
   3. Replay into memory: each record carries its entity's full state, and what the database did without a record is done too: purging an item takes everything below it, purging a version clears the version of the file links made for it (since D42 a replace journals their deletion too), and a link journaled with a `revokedAt` (before 0019) was turned off.
   4. Settle: a file whose current version was never journaled as stored (its bytes were only in staging) falls back to the newest earlier version still journaled, or is dropped (the journal has no wrapped key or chunk size to make a `failed` version of); a file recorded with no current version, an upload journaled before uploads in progress were left out, is dropped too. A version with a frame in a blob the journal lacks, or one it says was deleted, is dropped first, as if never journaled, and its file falls back the same way: only DFS deletes its messages (D31), so this means a journal cut short. All of these are listed by the tool.
   5. Write it all in one transaction, under the IDs it had (blob and audit IDs too: blob IDs name the blobs' messages and local files), the database's instance ID (§4) included, and the batches read as posted, so the next one is numbered after them. The channels of the category are registered again from Discord. Derived values are recomputed: usage, trash marks, live bytes (a blob with nothing live left goes to the garbage collector), folder sizes. Identity sequences continue past the highest IDs seen, the blobs' past the highest `b=` this database posted in the data channels, journaled or not. Records written before they carried a field recovery needs are filled in where the code guarantees the value: a version's maker is its file's owner, a first version was made with its file, a solo blob holds one frame. What can't be is known no better: a later version's making is taken as when it was journaled stored, a pack's frame count as the frames still pointing at it.
   6. The orphan reconciler is **not** run: with an incomplete blob table it would delete messages that hold data. The scrubber and reconciler can be started once the result is checked.

   **The drill:** `dfs drill` recovers into a database of its own on the same server, compares it with the one in use column by column (every column of every table, but for a short list of what isn't journaled, each with its reason; a table it doesn't know fails the comparison), prints the differences and drops it. Its integration test (`recover.test.ts`) uses a drive every way the journal records, rebuilds it and reads every file back byte for byte.

**What a VPS loss costs (RPO):** journal records not yet uploaded (up to about one flush interval, plus upload time), and files still in staging that had not reached Discord. A crash the VPS comes back from costs at most about the last second of completed uploads (D43).

> [!IMPORTANT]
> Back up the **master keys** (including retired ones) and the **`.env`** somewhere outside DFS and outside the VPS. Without them, nothing in Discord can be decrypted.

---

## 9. API Surface (v1)

All routes are under `/api`, use JSON unless noted, and are validated with Zod schemas shared with the frontend (`packages/shared`). All list endpoints use **cursor (keyset) pagination**.

| Method & Path | Purpose |
|---|---|
| `POST /auth/login` `{username, password}` · `POST /auth/password` `{currentPassword?, newPassword}` · `POST /auth/password-reset` `{username}` → `204` · `POST /auth/logout` · `GET /auth/me` | Auth (§7.1). Login, password change and `me` answer `{user, csrfToken, passwordChange}`; `passwordChange` is `'activate'` or `'reset'` while the session can only choose a password, else `null`. A request for a new password answers `204` whether or not the account exists |
| `GET /nodes/:id` · `GET /nodes/:id/children?kind&sort&order&cursor&limit` · `GET /nodes/:id/path` · `POST /nodes/lookup` `{ids[]}` | Browse. `kind=folder` lists subfolders only (folder tree, move dialog). Folder nodes carry `hasChildFolders`, so the tree only shows an expand arrow where there is something to expand. The lookup returns the caller's visible nodes among up to 500 IDs, leaving out the rest: the upload panel re-checks thousands of files' sync states with a few requests |
| `POST /folders` `{parentId, name}` · `POST /folders/ensure` `{parentId, paths[]}` | Create folder / `mkdir -p` in bulk |
| `PATCH /nodes/:id` `{name?, parentId?}` · `POST /nodes/move` `{ids[], parentId}` | Rename / move (single or bulk) |
| `DELETE /nodes/:id` · `POST /nodes/trash` `{ids[]}` · `POST /nodes/:id/restore` · `GET /trash` · `DELETE /trash/:id` · `DELETE /trash` | Trash: move, restore, list, delete one item forever, empty |
| `POST /uploads` · `POST /uploads/batch` (per-upload results) · `POST /uploads/alive` `{ids[]}` (the page holding them is still open, §6.1) · `GET /uploads/:id` (`receivedParts`; also `state` and `versionId`, until the session expires) · `PUT /uploads/:id/parts/:idx` (binary) · `PUT /uploads/:id/content?from=` (the file from part `from` to its end, streamed) · `POST /uploads/:id/complete` (`partSha256` for a streamed file) · `DELETE /uploads/:id` | Uploads (§6.1) |
| `GET /files/:id/content` (Range; `?version=<id>`) | Content: the current version, `304` to a browser that has it (§6.2). With `?version=`, only that version: `412 version_changed` once the file has another, so a player never mixes two (§10.4). A file has no earlier versions (D42) |
| `GET /folders/:id/audio?deep=1` · `GET /s/:token/audio?folderId&deep=1` | The audio bar's queue (§10.4): a folder's audio files, or everything below it, in play order, at most 1,000 (`truncated` past that), each with its version, length, title, artist, album and whether it has a cover, from the kept media info. Through a link, the shared folder or one inside it |
| `GET /files/:id/playback` · `GET /files/:id/media` · `PUT /files/:id/position` `{versionId, positionMs}` · `DELETE /files/:id/position` · `GET /files/:id/media/:versionId/delivery` · `POST /files/:id/playback-report` · `GET /connection-test?bytes` · `POST /files/:id/stream-link` `{create}` · `GET /stream/:token/:name` · `GET /files/:id/media/:versionId/subtitles/:track.vtt` · `GET /files/:id/media/:versionId/cover` (a picture every browser draws: the one in the file's tags, copied out by the media service each time and kept by the browser a year, else `cover`, `folder` or `front` beside it; `503` while the service can't say) | Audio and video (§6.7, §10.4): what a player needs to start, from the database alone (the current version, where this user stopped, the subtitle files beside it); the media info of the current version (examined on the first ask if need be); saving where they stopped, and clearing it; how fast this viewer's reads of the version go, a play's report, and bytes for testing the connection (§10.4); a share link's address for another player (in the drive, the file's plain link, made with `create`), and what it reads, without a session (§6.7); subtitles as WebVTT (a stream inside the file by its number, extracted on the first ask if need be, or a subtitle file beside it by its ID) and the cover. `503 media_unavailable` without the media service. The share page uses the same under `/s/:token/files/:id/…`, behind the link's checks, without positions: a file link plays its file until the file is replaced (a folder link the current one), and offers no subtitle files beside it, as it shares that file alone; its connection test is `GET /s/:token/connection-test`, limited per address (§10.4) |
| `GET /folders/:id/archive` · `POST /archive` `{ids[]}` → `{url, fileName, expiresAt}` · `GET /archive/:ticket` | ZIP download. Several items get a short-lived, single-use link (D17), which the browser then downloads with a plain navigation |
| `GET /search?q=&type=&cursor` | Name search (`pg_trgm`) |
| `POST /shares` · `GET /shares` · `PATCH /shares/:id` (expiry, password, cap) · `DELETE /shares/:id` | Share links (owner), each with its `url` to copy again (`null` for one made before tokens were kept, §7.5) |
| `GET /s/:token` · `POST /s/:token/unlock` `{password}` · `GET /s/:token/children?parentId&cursor` · `GET /s/:token/files/:id/content` (Range; `?preview=1` for a preview, which never counts toward the download limit, §7.5; `?version=` for a player, as in the drive) · `GET /s/:token/archive?nodeId` | Public share access, no login. Used by the SPA page at `/s/:token`. `:id`, `parentId` and `nodeId` must be the shared node or inside its subtree. `GET /s/:token` answers `{locked: true}` for a password-protected link that isn't unlocked, otherwise the shared node, who shared it, the expiry and the downloads left. Children come with their `path` inside the share. Dead links answer `410` (`share_expired`, `share_used_up`); unknown ones, and those turned off, which are deleted, `404`. A locked link or a wrong password is `403`, never `401`, which means "sign in" to the app (D18) |
| `GET /events` (SSE) | Sync progress, background changes, quota, keep-alive pings (fed by `LISTEN/NOTIFY`; payloads in §6.1) |
| `GET /admin/users` · `POST /admin/users` `{username, displayName?, temporaryPassword, quotaBytes?, role?}` · `PATCH /admin/users/:id` (display name, quota, role, disable) · `POST /admin/users/:id/password` `{temporaryPassword}` | Admin: users. The owner can't be demoted, disabled or given a new password here (`409 owner_protected`), and admins can't demote, disable or reset themselves (`409 self_change`) |
| `GET /admin/users/:id/usage` · `GET /admin/nodes/:id` · `GET /admin/nodes/:id/path` · `GET /admin/nodes/:id/children` · *`GET /admin/search?q=&userId=` (not built, §18.1)* | Admin: **read-only metadata** of any user (no content routes) |
| `GET /admin/nodes/:id/links` → `{links}` · `DELETE /admin/nodes/:id` `{reason}` → `{deletedLinks}` | Admin: moderation trash (audited; the owner sees the reason in their trash), which deletes the item's share links |
| `GET /admin/health` (with its alerts, §16) · `GET /admin/channels` · `POST /admin/channels` · `PATCH /admin/channels/:id` `{enabled}` · `GET /admin/audit?actions&actorId&q` | Admin: system. At least one channel always stays enabled. Admins can't demote or disable themselves. The audit log narrows to prefixes of action names (`auth.`, `share.,node.`), one actor, or words in what an entry is about or its details |
| `GET /admin/sessions?userId` · `DELETE /admin/sessions/:key` · `POST /admin/users/:id/sign-out` → `{ended}` · `GET /admin/shares/owners` · `GET /admin/shares?active&ownerId&q&cursor` · `DELETE /admin/shares/:id` · `GET /admin/uploads` · `DELETE /admin/uploads/:id` | Admin: people and access. A session is named by the first 16 hex digits of its hash, which can't sign in; it lists where it signed in, with what browser, and when it was last used. Only the owner may sign the owner out (`409 owner_protected`), and the session asking can't end itself (`409 self_change`; signing yourself out everywhere keeps it). Share links come without their token or URL (D4), grouped by owner (`/admin/shares/owners`, with how many work) and found by item name, folder path, owner name or username (`q`); turning one off is audited with its owner's name. Giving up an upload deletes what arrived and releases its reservation |
| `GET /admin/storage` · `GET /admin/tasks` · `POST /admin/tasks` `{kind}` → `202` · `GET /admin/tasks/:id` | Admin: storage control (§11). The status lists uploads retrying or given up, deletions that keep failing, and what compaction would merge (`compaction`): for packs `COMPACT_MIN_AGE_DAYS` old and for any age, how many packs into how many, their files' bytes, and the bytes that would free in Discord. A task goes to the leading bot through the `admin.task` queue: `503 bot_unavailable` while no bot leads, `409 not_discord` for a Discord task on other storage; its state goes `pending` → `running` → `done` or `failed`, with what it did in a sentence |
| `GET /admin/database` · `POST /admin/database/sessions/:pid/cancel` · `POST /admin/database/sessions/:pid/terminate` | Admin: PostgreSQL now (§16): connections by service, what runs (its SQL as sent: DFS sends values apart, so its own queries show placeholders; SQL typed in psql shows as typed), the slowest statements, the largest tables, unused indexes, settings. Cancelling a query or ending a connection touches only this database's client connections, never the asking one, and is audited; a connection idle in a transaction has no query to cancel (`409 not_running`), only ending it closes the transaction |
| `GET /admin/system` · `POST /admin/system/cache/clear` → `{freedBytes}` · `POST /admin/database/tables/:name/vacuum` | Admin: system (§15). The settings in effect, safe ones only, compared with the bot's; whether each secret is set; the registered Discord channels by kind; staging and this instance's frame cache. Clearing the cache frees its disk (`409 no_cache` with local storage, which has none); frames are read from Discord again as needed. Vacuum takes a table by the name the Database page lists, looked up in the catalog and quoted, and runs `VACUUM (ANALYZE)` on it. Both are audited |
| `GET /admin/metrics?range&series` | Admin: graphs (§16). `range` is `1h`, `6h`, `24h`, `7d`, `30d` or `1y`; `series` lists up to 24 `<metric>:<reading>`, such as `http.ms:p95` or `discord.posted:rate`. Answers the bucket starts and one value per bucket for each series, a few hundred at most, plus each series over the whole range |
| *Planned (§7.6):* `GET /devices` · `POST /devices` `{name, kind: 'dav'}` → `{token}` (shown once) · `DELETE /devices/:id` · `POST /devices/pair` `{name, challenge}` → `{code}` · `POST /devices/token` `{code, verifier}` → `{token}` | Device tokens: the user's devices, a network drive's token, removing one, and the backup app's pairing |
| *Planned (§6.9):* `GET /nodes/:id/descendants` (newline-delimited JSON) · `GET /backup-sources` · `PUT /backup-sources/:id` | The backup app: a whole subtree in one answer (the web app may use it too), the user's sources, and an app's report on one |
| *Planned (§7.7):* `POST /locked/setup` `{code}` → `{recoveryKey}` · `POST /locked/unlock` `{code}` · `POST /locked/lock` · `POST /locked/code` `{code \| recoveryKey, newCode}` · `POST /locked/recovery-key` → `{recoveryKey}` · `POST /nodes/:id/lock` · `DELETE /nodes/:id/lock` | Locked folders: choosing the lock code, opening them in this session and locking them again, a new code, a new recovery key, locking a folder and removing its lock. Every route that reaches inside one while it is locked answers `403 folder_locked` |

There is no copy endpoint (D3). *Planned outside `/api`:* WebDAV at `/dav/*` (§6.8), and the desktop app's installer and updates at `/downloads/` (§6.9).

Internal (bot), only reachable on `dfs_internal` and returning `404` at the edge: `POST /internal/urls/refresh` (batched, up to 50 blobs), `GET /internal/health`.

---

## 10. Frontend (React)

**Stack:** React 19 with the **React Compiler** (automatic memoization, so no hand-written `useMemo`/`useCallback`), Vite 8, TypeScript 6.0, TanStack Query (server state, infinite queries), **TanStack Virtual** (virtualized lists and grids for folders with 100k+ entries), React Router 8 (data router; route loaders gate on the session), Tailwind CSS 4 + shadcn/ui (Radix primitives), zustand (client state: selection, uploads, preferences, drag state), and Zod (schemas shared with the API). Dark mode is the default; light and system themes are available.

**Visual style:** squared-off corners (6 px base radius); a softly cool-tinted neutral palette instead of pure black and white (body text about 13:1, every text pair at least WCAG AA). Motion is cut to a minimum under `prefers-reduced-motion`, View Transitions included.

**Motion:** smooth and a little bouncy, like iOS, without glass effects. Color and hover changes use one short ease-out curve (160 ms). Anything that moves or appears uses **springs**: CSS `linear()` curves sampled from a damped spring, so they run on the compositor like any CSS animation, with no animation library. There are three, each paired with the duration it needs to settle (`motion-*` utilities): *glide* (no overshoot, 350 ms) for opacity, heights and page slides; *spring* (2% overshoot, 430 ms) for menus, dialogs and rows moving; *bounce* (8% overshoot, 580 ms) for small things that pop, such as badges, checkmarks and the switch knob. Overshoot is only ever applied to transforms. Specifically:

- Navigating slides the content pane with a View Transition: into a folder from the right, back out from the left, between sections with a soft zoom. Only the pane is named, the overlay lets clicks through, and nothing animates while dragging or when the page is hidden.
- Rows glide to their new place when items are added, removed or re-sorted (a transform-only transition, keyed so a grid reflow doesn't animate). Removed rows shrink out first; new, restored and uploaded rows pop in.
- Buttons and tiles shrink slightly while pressed and spring back. Tree groups open and close to their natural height; tab underlines slide between tabs.

**Drag-to-move:** a small pointer-driven controller instead of a library (D16). While dragging, a requestAnimationFrame loop moves the floating preview with a transform and finds the folder under the pointer, so React only re-renders the two rows whose highlight changes. Drop targets are folder rows and tiles, tree folders and breadcrumb ancestors; a folder can't be dropped into itself or its subtree. Resting on a folder makes it blink and spring open (tree folders expand instead); lists scroll near their edges; Escape cancels and the preview floats back. Moves update the cache at once, with Undo. Mouse and pen only: touch and keyboard users have the Move dialog. Files dragged in from the desktop onto a folder row upload into that folder.

**Live connection:** SSE (`GET /api/events`) rather than WebSockets (D15). Event payloads patch the cache in place (§6.1), reconnects back off from 1 s to 30 s, a missing ping or the browser coming back online reconnects at once, and a reconnect refetches what is on screen. A dot in the header shows the connection state.

**Data updates:** mutations update the cache optimistically (moved and trashed rows leave at once, renames show at once) and then refetch only the folders they touched, never every cached folder.

**Mock API:** in development, MSW 3 serves the §9 API from the browser with seeded demo data (including a 6,000-file folder, deep nesting and every sync state), so the UI can be built and tested before the API exists (D14). `VITE_API_MOCKS=off` switches the dev server to the real API on `localhost:3000`. No mock code ships in production builds.

### 10.1 Screens

| Screen | Key features |
|---|---|
| **Login** | Username and password; a wrong one shakes the card. Explains a disabled account or an expired temporary password. Forgot your password? asks the admins for one by username (§7.1) |
| **Choose a password** | Right after a sign-in with a temporary password, before anything else: a new password, typed twice. Welcomes a first sign-in; after a reset, says an admin reset it |
| **Drive** (main) | Breadcrumbs, virtualized list/grid (file-type icons; thumbnails come later, §1.2), sort, multi-select (shift/ctrl, Ctrl+A for the rows loaded so far), right-click context menu, drag-drop upload (files *and* folders, onto the folder or straight onto a subfolder), drag-to-move, rename (a dialog), keyboard shortcuts (F2, Del, Ctrl+A), sync status icon per file (syncing / stored / failed), download (one file as itself, folders and multiple items as a ZIP) |
| **Upload panel** | Docked queue showing aggregate progress (files and bytes), speed and time left, per-file two-phase progress (upload → Discord sync), pause/resume/cancel per file and for all, retry failed. Closing it keeps files still syncing, and a button in the header brings it back. While uploads are under way it says closing the page cancels them, and the browser asks before leaving |
| **Preview** | Full screen over the drive (§10.3): images, PDFs, text and code, with Download, Share and Details, and video, in its player (§10.4) |
| **Audio player** | A bar docked at the bottom, playing on while the user browses, with the folder as its queue (§10.4) |
| **Trash** | Restore, delete forever, empty trash |
| **Shared links** | List, copy, delete, and edit expiry, password and download limit. Each row has Copy, and the link is in its edit dialog and on Share (§7.5); a link made before links were kept can't be shown again and says so |
| **Public share page** | Minimal, unauthenticated SPA route `/s/:token` (data from `/api/s/*`), loaded without the signed-in app: a password prompt if needed (a wrong password shakes the card), then the file with a download button, or a folder to browse (breadcrumbs inside the share, per-file download, ZIP of any folder). Shows who shared it, the expiry and the downloads left, and a clear message for expired and used-up links, and for those gone or never there. Files preview in the drive's viewer and play in it and in the audio bar (§10.3, §10.4) |
| **Settings** | Profile, password change, quota usage bar. *Planned:* Devices (network drives and backup computers, with their sources, §7.6, §6.9) and Locked folders (the lock code and the recovery key, §7.7) |
| **Admin** | Tabs: **Overview** (what needs attention, worst first; service status, sync backlog with speed and time left, job queue, staging and cache use, storage, and an Integrity card whose scrubber and backup figures are placeholders until those exist (§6.5, §8), refreshed every 5 s; then the history over a chosen range, from an hour to a year: stored bytes, bytes received and sent, requests and response time as figures with their trends, and graphs of throughput, the sync backlog, storage and refused or failed requests), **Monitoring** (every graph of §16 by area: traffic, Discord, reading back, storage, database, processes, people; one request per area), **Users** (add a user with a temporary password, typed or generated, and copy their sign-in details; reset a password; quotas, roles, disable; users who haven't signed in yet are marked; the owner is marked and can't be changed; per-user usage by file type and a **read-only metadata browser**: names, tree, sizes, dates, with no open/download/preview; moderation trash with a reason; their sessions in a side panel, each with Sign out, and Sign out everywhere), **Access** (everyone signed in, with browser, address and last activity, each with Sign out; every share link, working or all, grouped by owner (each group opening on that user's links, newest first, with how many work), found by the item's name, the folders it is in or its owner (`GET /admin/shares/owners`, `GET /admin/shares?ownerId=&q=`), each with the folders it is in, its state and downloads, linked to the metadata browser and turned off behind a confirmation, never showing its address; uploads under way with their progress, each given up behind a confirmation), **Storage** (tasks for the leading bot, with their results; the channels: create one in the category, add one by ID, enable or disable; uploads retrying or given up, with their errors; released blobs that fail to delete; the packs compaction would merge, the bytes that would free, and Compact packs now; `/admin/channels` leads here), **Database** (PostgreSQL now: version, uptime, size, connections against the limit, buffer cache hits, deadlocks; what runs longer than a quarter second, waits for a lock or holds a transaction, each with Cancel query and End connection behind a confirmation; its graphs over the chosen range; connections by service, the slowest statements, the largest tables with dead rows and their last vacuum, unused indexes, the settings that matter for tuning; each table can be vacuumed now), **System** (environment, instance ID, Node.js and uptime; the Discord server, category and gateway, every registered channel by kind, and Check the layout; staging and the frame cache with how full they are, and Clear the cache behind a confirmation; the settings in effect by group, default or set, each as the service reading it has it, with the bot's where both read one and it differs; whether each secret is set in the service that uses it), **Audit log** (narrowed to a kind of action: sign-ins, accounts, sharing, content, system; and to words, found as you type). A `requireAdmin` route loader makes the pages a 404 for everyone else |

### 10.2 Client upload engine

- **Folder drops** walk the directory tree (`DataTransferItem.webkitGetAsEntry`) with at most 12 requests to the browser's file system at once (`WALK_CONCURRENCY`), a folder's entries read in the batches the browser gives (Chrome's 100) until an empty one. The engine creates the folders with `POST /folders/ensure`, 500 paths per call. A file the browser won't open or a folder it won't list (a locked or cloud-only file, a path too long, an `InvalidStateError`) is left out, not fatal (found on the first big folder, 2026-10-11: a Python venv's `lib64`, a symbolic link, which Firefox won't list and answers `InvalidStateError`): the drop goes on without it, and a toast names the first few with the browser's own error, the console the first 25 in red. Nothing is queued until the walk has finished; a toast counts the files found if it lasts over 0.4 s, then says it is preparing them. **Upload folder** keeps its `<input webkitdirectory>` in the page until the browser answers, since a big folder takes a while to list and an input only a variable holds could be collected before it says `change`. Its list is the browser's own, `input.files`, and cannot leave out what fails: the browser lists a picked folder whole, and Firefox gives up the whole listing, with no error, when one folder inside can't be listed (found 2026-10-11 on a Python venv's `lib64`, a Linux-style symlink; Firefox's recursive listing returns the error up and abandons the rest), so the page hears of a folder with no files. `webkitEntries` is no way round it: it holds the same flattened files, not a folder to walk (tried, and removed). So a folder that comes back empty says why it may have, and to drag it onto the page, which lists folder by folder and leaves out what fails. A dismissed picker does nothing, and a failure of the browser's reports the step it happened in (opening the picker, or reading the files it listed) in the toast and the console. Both ways in share one start, `startUploads`: the toast, the report of what was left out, then the engine.
- **Sessions ahead of time:** sessions are created in batches (`POST /uploads/batch`, 64 per call, the next batch once fewer than 32 are ready, so few placeholder files exist at once), so the new files show up in their folders at once, marked as uploading, and a small file then costs a single `PUT`. A batch that partly fails fails only those files.
- **Concurrency:** up to 8 requests in flight. A file larger than one part streams in one request, one such file at a time; small files fill the remaining slots, read and hashed a little ahead (2 files, within 100 MiB). All configurable.
- **Retries:** a failed request is retried up to 6 times with exponential backoff (1 s doubling to 30 s, ±20% jitter), or exactly as long as `Retry-After` asks; a stream that stored more parts than the try before counts afresh. Network errors, 408/425/429/5xx and `hash_mismatch` are retried; other 4xx fail the file. When the browser comes back online, waiting retries go at once. A single-part retry that finds its session gone checks the node, because the lost response may have been the one that completed it.
- **Pause, resume, retry:** pausing aborts the file's request but keeps its session; resuming asks `GET /uploads/:id` which parts arrived and streams from the first one missing. A pause runs out after 5 hours (`PAUSE_LIMIT_MS`): the upload is canceled, and the panel says so. A file that fails after its retries gives up its session at once (staging is not held for a page that may stay open), and Retry starts it afresh. Cancelling, or clearing a failed file from the panel, deletes its session, so no stuck "uploading" file is left behind.
- **Small files:** `file.slice()` → SHA-256 with Web Crypto (`crypto.subtle.digest`, which runs off the main thread) → `PUT` with `X-Part-SHA256`. **Larger files:** `file.slice(from)` as an XMLHttpRequest body, which the browser reads from disk as it sends; the parts' hashes are worked out alongside, one part in memory, and go with `POST /complete`.
- **The upload report:** what became of every file the page was given, among however many thousands: **failed** (with why, or uploaded but not stored on Discord), **not read** (what the browser wouldn't open or list while walking a folder, which never became uploads), **in progress**, **uploaded**, **already there** (dropped again, the same file, D44) and **skipped** (or cancelled). The panel's header opens it: a red count when something went wrong, otherwise a report button; its title counts them. Each file shows its name, its path and why; a kind's list can be copied (a line each), the whole report downloaded as CSV (path, name, outcome, detail, size; UTF-8 with a byte-order mark; a field a spreadsheet would take for a formula starts with `'`), and the failed uploads retried together. The path is inside the folder dropped or picked (`Photos/2024/a.jpg`), or the name alone for a file on its own: a browser never tells a page where a file is on disk beyond that. The report lives with the page, as uploads do; the way to finish a folder later, from another page or after a crash, is to drop it again (D44).
- **Progress** counts bytes as the browser sends them (XMLHttpRequest's upload events; `fetch` reports none), so the bar and the speed move steadily. After a failure it goes back to the parts the server kept.
- **A page older than the deploy:** after a deploy, a tab opened before it, or a page the browser restores from its history, would run the old app against the new API. Each deploy has a version, its git revision, built into the web app and the server images with when it was made (`docker/deploy.sh`). Every API answer says the deployed one (`X-DFS-Version`), as does `GET /api/version`, which a page asks at startup, every five minutes, on returning to the tab and on a back/forward-cache restore. A production page that finds another version reloads at once at startup (once per version, so a stale cache can't loop it), and later offers a reload, which asks first while uploads are under way. A page also loads each screen's code the first time it opens one, and an older page asks for files the deploy removed: Caddy answers those `404`, never the app's HTML, and the route's error page, seeing a part of the app fail to load, reloads into the new version at the same address instead of showing an error. Caddy serves the HTML with `no-store`, and only files that exist as `immutable`. Settings shows the version a page runs, and Admin → System the API's and the bot's, warning when they differ.
- **No lag with big batches:** the engine keeps its own state and publishes it to the UI store at most ten times a second; the upload panel is virtualized. Speed is the bytes sent over the last 5 s, or since sending started if that is sooner; the panel says "starting…" before the first byte, and "waiting…" when nothing has gone for 5 s (staging full, or a connection retrying).
- **No resuming after a reload** (the user's decision, 2026-10-07: an upload lives in its page, like any website's). Closing or reloading the page cancels what is under way: the page warns before leaving while uploads run, and cancels their sessions as it goes (`pagehide`, with a keep-alive request). A session the page can't cancel (a closed laptop, a lost connection) is a lease: the engine renews it every minute, and the bot gives up one idle for 10 minutes.

### 10.3 Previews

What a file holds, seen without downloading it (D33). Images, PDFs, text and code are shown here; audio and video have players of their own (§10.4) and streaming (§6.7). There is no version history (§1.2), and office documents have no preview (§1.2): they download, as does every file the viewer can't show.

- **The viewer:** full screen over the drive, opened by double-click, Enter or the context menu's Preview, for a file it can show. Its place is in the address (`?preview=<id>` on the folder's or the search's URL), so Back closes it and a reload keeps it open. The arrows, ← and → move through the previewable files of the list it was opened from (at a large folder's end, its next page loads), Esc closes it, and on a phone it fills the screen and swipes. Its header has the name, Download, Share and Details (size, type, modified, sync state), and the next image is loaded ahead. Trashed items have none, and neither have admins' views of other users' files (D4).
- **Which viewer** comes from `fileCategory` (MIME type, then extension), as icons do. A file that turns out unreadable (an image the browser can't decode, text that is binary) says there's no preview, with Download.
- **Images:** an `<img>` of the content route: JPEG, PNG, GIF (animated), WebP, AVIF, BMP, ICO, and SVG, which as an image runs nothing. Fit to the screen or at 1:1 (a photo smaller than the screen stays at 1:1; an SVG grows to fill it); the wheel and a pinch zoom around the pointer, a drag pans, a double-click or double tap switches between the two, and + − 0 zoom from the keyboard. HEIC, HEIF and TIFF show where the browser decodes them (Safari, and every browser on an iPhone or iPad). An SVG uploaded without its MIME type downloads instead: a browser draws one only when told its type, and the server sends no type it wasn't given. The browser applies EXIF orientation.
- **PDF:** pdf.js (`pdfjs-dist`), loaded with the first PDF opened, its worker from `/assets`. Its viewer draws pages as they scroll into view, with zoom, the page count and text that can be selected, and reads the document with Range requests the page makes itself, in pdf.js's 64 KiB chunks, so a large PDF opens at its first pages. The first read is the first 64 KiB, which gives the file's length and version (its ETag); every later one names that version (`If-Range`), so a file replaced while it is open fails, rather than mixing two versions. Given a URL, pdf.js would first ask for the whole file and cancel once it had the headers, which cost the API its first chunk and two read ahead from Discord for nobody (now the first alone, and what of the next arrived before the cancel, §6.2). pdf.js reads every page's dictionary before it shows the first (it checks that the last page exists): a 58 MB PDF that keeps them together opened with 4 requests, 0.6 MB to the browser and two chunks from Discord; one that spreads them between its pages' images read every chunk from Discord the first time (8.8 MB to the browser), and the frame cache keeps them for the next (measured on Discord, 2026-10-08). Its zoom fits the window (and fits it again when the window changes), with buttons, Ctrl and the wheel, and + − 0; the PDF's own keys scroll it, while ← and → still move to the next file. Its character maps, standard fonts and JavaScript image decoders are static files under `/assets/pdfjs-<version>/` (copied from `pdfjs-dist` by a Vite plugin, `apps/web/pdfjs-assets.ts`), kept for a year like the hashed assets since the version names them. pdf.js 6 runs no `eval`, so the CSP keeps `script-src 'self'`; it decodes JPEG 2000 and JBIG2 images with WebAssembly by default, and `useWasm: false` has it use its JavaScript decoders instead, so the CSP needs no `'wasm-unsafe-eval'` either (the cost: slower decoding of those images, and no ICC colour profiles; no PDF with such images has been opened yet, so those decoders are untried). A PDF with a password says so, with Download; forms show but can't be filled, and links open in a new tab.
- **Text and code:** the first 5 MiB (`Range: bytes=0-…`), read as UTF-8 (or UTF-16 with a byte-order mark); text with NUL bytes, or mostly invalid UTF-8, is binary. A read-only CodeMirror 6 editor shows it: colours for the language of its name (each language loaded when first needed), line numbers, wrap on and off (on for prose, off for code), search (Ctrl+F; Esc closes the search before the viewer), and only the lines on screen drawn, so a large log scrolls smoothly. The editor and its languages load with the first text file opened, not with the drive. A file cut at 5 MiB says so, with Download. **Markdown** is shown formatted (GitHub's flavour, through `react-markdown`, without raw HTML, so nothing in it runs), with a switch to its source; its images aren't loaded but shown as their description, since the CSP stops other sites' and one on this site would be a request made in the reader's name (a share link's download, say). **JSON** is laid out when it parses, with a switch to the file as it is; only the spaces between its tokens change, so a number keeps every digit that `JSON.parse` would round. HTML, SVG and XML are shown as source, never rendered. Which files are text comes from the MIME type, then the name (`main.ts`, `Dockerfile`, `.gitignore`), and the name wins over a type that is neither image nor text: Windows calls TypeScript `video/mp2t`.
- **Safety:** the server sends content as it always has, an attachment with `nosniff` (§7.5): images go through `<img>`, text is rendered as text, and PDFs are drawn by pdf.js. Nothing uploaded runs in the page.
- **Caching:** the content route answers `304` to a browser that has the version (§6.2), so going back and forth between files moves no bytes again.
- **Share page:** a file link's preview fills its page, under a bar with its name, the link's facts and Download; a folder link opens its files in the same viewer as the drive, with Download and Details but no Share. Previews ask with `?preview=1`, which never counts toward the download limit (§7.5); only Download does. A file the viewer can't show keeps the page as it was, with Download.
- **Mock:** the demo's images, PDFs and text files have sample content, so previews work in it too; every video plays one 12-second sample (`apps/web/src/mocks/sample-video.mp4`, made by `make-sample-video.sh` in the media image), with made-up media info: chapters and subtitles inside, an MKV's sound in Dolby Digital and an AVI in MPEG-4 Part 2, so the player's notice and reasons show, and an Italian subtitle file beside one video. Every audio file plays one 10-second MP3 (`sample-audio.mp3`, by `make-sample-audio.sh`), with a cover (`sample-cover.jpg`), its title and track number from its name and its album from its folder's.

### 10.4 Audio and video players

The players of D35, over the streaming of §6.7.

- **Video** plays in the viewer (§10.3), with its own controls rather than the browser's, made of the app's own components (no player library), which the audio bar shares:
  - play and pause, a seek bar showing how far it has loaded from where it plays, as one stretch, as YouTube's does (not each range loaded, which after a seek drew a fragmented line; the user, 2026-10-09), and the time (and chapter) under the pointer, time, volume and mute, speed (0.5–2×), subtitles, audio track (where the browser lists a file's tracks: Safari, in direct play), picture-in-picture and full screen; while it plays untouched, the controls hide after 2.5 s, and in full screen the pointer with them;
  - keys: Space or K plays and pauses, J and L skip 10 s, ← and → 5 s, ↑ and ↓ change the volume, M mutes, F goes full screen, C turns subtitles on and off, `<` and `>` change the speed, 0–9 jump to tenths, Home and End to the ends. Shift+← and Shift+→ move to the previous and next file, as ← and → do for other files (the user's decision, 2026-10-09). Esc leaves full screen, then closes a menu, then the viewer;
  - on a phone, a tap shows the controls, a double-tap on either side skips 10 s, a swipe outside full screen moves to the next file, and full screen turns to the video's orientation where the browser allows it (Android);
  - what a browser lacks is left out rather than broken: picture-in-picture where it has no API for it (Firefox has a button of its own), full screen on an iPhone (which has none for elements) is its own player, given the subtitles, and where a page can't set the volume (iOS), there is only mute;
  - chapters mark the seek bar, the current one shows beside the time, and a list jumps to one;
  - Media Session: media keys and the system's controls play, pause and seek it;
  - the volume, mute and the subtitle language last chosen are kept in the browser;
  - Details shows the formats (e.g. HEVC Main 10 4K HDR10, E-AC-3 5.1 English), the subtitles, and how it plays: directly, or why it can't.

  At its end a video stops: there is no "next video" (the user's decision, 2026-10-09).
- **Starting a video.** The player first asks `GET /files/:id/playback`, which reads the database alone: the version to play, where this user stopped, and the subtitle files beside it. It then plays at once, from that point, without waiting for the media info, whose first examination can take a second, or fail without the media service. The media info, when it comes, adds the formats, the chapters and the subtitles inside the file, and each codec is put to the browser (`canPlayType` with its RFC 6381 string; never the container, since Chrome plays MKV but doesn't say so): a video codec it can't decode stops the player, with why, as the browser might play the sound over a black picture; a sound codec it can't decode leaves a warning that the video plays without sound, which offers VLC (§6.7); picture subtitles, and sound tracks the browser can't switch to, get one that fades. When the browser won't start with sound before a click (an address opened or reloaded), it waits on a Play button.
- **The version played.** The video element can't name the version it started with (pdf.js does, with `If-Range`), so a file replaced while it plays would mix two files. Its address names it instead: the content route's `?version=` answers `412 version_changed` once the file has another, and the player says the file was replaced, with Play the new version, from the same time (the user's decision, 2026-10-09).
- **Subtitles** are drawn by the player, above its controls (they move up when the controls show), from WebVTT tracks (`<track>`, from `GET /files/:id/media/:versionId/subtitles/:track.vtt`, on the same origin, so the CSP is unchanged); only the chosen one is loaded. Forced subtitles (for the parts in another language) show by themselves unless others are chosen, or Off; the language chosen last is chosen again for the next video. Picture subtitles are listed in Details, not shown.
- **Audio** plays in a player bar docked at the bottom of the app, which keeps playing while the user browses (it lives outside the routes):
  - opening an audio file plays it, with the folder's other audio files queued in order: disc and track number from the tags, else the name in natural order; Play and Add to queue on files and folders, a folder bringing everything below it, folder by folder in name order (at most 1,000 files; the user's decision, 2026-10-09);
  - previous (to the track's start once 3 s in) and next, shuffle, repeat (all or one), seek, volume, speed (0.5–3×, for audiobooks and podcasts), and a queue to open, reorder and clear;
  - title, artist, album and cover from the tags (§6.7), else the file's name; a playlist (M3U, M3U8, PLS), which browsers type as audio, isn't audio, and downloads;
  - Media Session: the lock screen, notifications and media keys show and control it, so a phone plays on in the background;
  - on a computer, one bar under the page, with the queue in a side panel; on a phone, a slim bar (cover, title, play, next) that opens a full view with the rest (the user's decision, 2026-10-09);
  - a track this browser can't play (its codec, from the media info, or the browser's error) stops the bar with why, and Download; Next goes on (the user's decision, 2026-10-09);
  - opening a video pauses it; after a reload, the queue and the position come back, paused (stored in the browser). The bar and its `<audio>` live outside the routes, so playing goes on from page to page, the share page included.
- **Resuming.** Where a user stopped a video, or an audio file over 20 minutes, is kept per user and file on the server (`playback_positions`, with the version it was in), so it follows them to another device. It is saved every 10 s while playing, on pause, and on leaving it (closing the viewer, moving to another file, the page hidden), the last with `keepalive`; the first 10 s aren't kept. **A video, or an audio file over 20 minutes, starts at the beginning**, offering to resume where it stopped ("Stopped at 12:34 · Resume"; the user's decisions, 2026-10-09, in place of picking up there with Start over). The offer shows for 8 s once it plays, then fades (the user, 2026-10-09: it stayed until played past); what it offers stays kept through the first 30 s of play, or until it ends, so opening a video and leaving it, or letting it play a little, loses nothing; past that, what plays is kept as before. Finishing (the last 5%) clears it, as does a new version of the file. It is not journaled, and the drill leaves it out.
- **Fallbacks.** A direct play that fails (a browser can say yes to codecs it then can't play, or can't open the container) says why (the codec, from the media info, and the browser's error), with Open in… (another player) and Download. Without the media service, files play only directly, and the others say why, with Download. A read that fails while playing (Discord answering badly, say) offers Try again, from the same time.
- **Saying why it is slow** (added after a phone waited two minutes for a 4K, 60 fps, 24 Mbit/s AV1 video, 2026-10-09: the server had it ready in two seconds, and the phone took it at 2.7 Mbit/s). Nothing is transcoded, so a video too heavy for a device or its connection can't be made lighter; the player says which, instead of waiting in silence, each warning above the picture until dismissed (or, for decoding in software, until it fades):
  - before it plays, it asks the browser whether this device decodes this exact picture smoothly (Media Capabilities, with its codec, size, frame rate, bitrate and HDR), and warns when it may not keep up (saying so when it decodes in software); one it would keep up with, but in software rather than in hardware (not power-efficient, as browsers answer for a codec the device has no decoder for), gets a warning of its own that it may play less smoothly, warm the device and drain its battery, which fades 10 s after it starts playing and can be closed sooner (the user, 2026-10-10); Details shows the answer (smooth or not, in hardware or in software);
  - waiting more than 4 s while asked to play (before its first frame, stalled, or after a seek; a video paused before its first frame waits for its viewer, as on an iPhone, which loads nothing until Play), it compares how fast the video arrives with what it needs, and says when it arrives slower, and on which side the server waited ("arrives at 2.7 Mbit/s and needs 24.3 Mbit/s. The server has it ready and waits on this device's connection"). The rate comes from the API, which counts what it sends to the user's reads of the version and how long it waited for storage against the client (`GET /files/:id/media/:versionId/delivery`, cumulative, asked every 2 s while the player waits): a page can't count what its video element receives, and what the browser says it has loaded can't stand in for it (Firefox says nothing of an MKV until it has read the index at its end, which first showed as 0 kbit/s). A stretch in which the server had no read running and sent nothing says nothing of the connection (the browser reading its own cache, or waiting on its decoder), so it gives no rate;
  - Details has a connection test: bytes from the VPS itself, not from Discord (`GET /connection-test`, random, at most 32 MiB, read for 8 s), giving this device's rate to the server and its first byte, so a slow network shows apart from a slow file, and logged;
  - playing, it says when the browser drops more than a fifth of the frames over 10 s;
  - when the play ends (the viewer starting to close or moving on, the page hidden), it reports it to the API (`POST /files/:id/playback-report`, `keepalive`): whether it played, failed or was left, the time to its first frame and to its playing, how long it was open, stalls and their time, seeks and their waits, frames shown and dropped, the arrival rate while it waited, the browser's answer on decoding and the reason it couldn't play, in words and as a kind (`problemKind`: `codec`, `file`, `read` or `other`; a page loaded before it was asked sends none, counted as `other`). The API logs it with the video's formats and the browser, and graphs the times and the kinds (§16).
- **Shared links:** the share page plays a video in the viewer and audio in the bar, through the same routes under the link (`/s/:token/files/:id/…`), behind its checks; a file link plays its file until the file is replaced, which deletes the link, a folder link its files as they are. Positions are kept in the viewer's browser, by link, file and version, as viewers have no account. A file link's page has Details for a video, as the viewer has, with its formats and the connection test. The subtitle files beside a video are offered only inside a shared folder: a file link shares that file alone. The "Loading slowly" warning follows each viewer's reads by the link and their address; their play reports are logged with the link, and they get the connection test (`GET /s/:token/connection-test`), both limited per address (the user, 2026-10-09). Playing through a link asks for the bytes as a preview (`?preview=1`), so it never counts toward the link's download limit.
- **Open in…** (§6.7): one button, in the viewer's header for a video, on a file link's page, and in the player's warnings and reasons, opening one menu (the user, 2026-10-10: "a single open in button that opens a context menu with all the supported applications") of the players this device plays it in, its own first, then VLC, and Copy link, with a line saying that anyone who has the link can play the file. On a phone a player opens at once: on Android, the phone's player (an intent naming no app, so the phone plays it in its default player or asks with its Open with list; no fallback, as the browser would download the whole file), then VLC (an intent naming its package, which goes to VLC's page in the store where it isn't installed); on an iPhone or iPad, VLC (`vlc-x-callback://x-callback-url/stream?url=`, which streams without asking whether to download), since the device's own player there is Safari's, the browser's. A computer's players take no address from a page, so a choice downloads a playlist of the one link, named after the file, to open from the downloads (the user, 2026-10-10: "download and open is the only viable way forward"; with Always open files of this type, one click): `.m3u` for the computer's own player, which on Windows is Media Player unless another took playlists (tried 2026-10-10: Media Player fetched the address from an `.m3u`, not from a `.wpl`, and neither its `ms-media-player://play` link nor `mms://`, which opens the old Media Player over plain HTTP, serves), and `.xspf`, VLC's own, for VLC. A page can't delete what it downloaded, so the playlist stays in the downloads, with the link in it. A Mac's playlists go to Music, so a Mac gets VLC alone. In the drive, a file without a plain share link gets one made when a player is first chosen, which a notice says, and Shared links lists. The browser's player pauses, as the video goes on there.
- **Not planned now:** a music library across the drive (artists and albums), and gapless playback between an album's tracks, which needs a different playback engine (the user's decision, 2026-10-08).

---

## 11. Bot Service

- **`@discordjs/core` and `@discordjs/ws`** (the discord.js v14 family), on the same REST client as everything else, so all calls share one set of rate-limit buckets. Intents: `Guilds` alone, the least a connection takes, since no message events are watched (D31) and nothing is cached. Users never touch Discord (D27), so `GuildMembers` and its privileged intent aren't needed. Message Content intent is **not** needed, because the bot reads its own messages. That holds only for as long as one bot wrote everything: a different bot reading them sees other users' messages, whose content and attachments Discord hides without the intent, so the journal would read as empty unless the intent is switched on. Changing bot is therefore a new server and a new database, which needs no intent (DEPLOY.md, “A new Discord server or bot”).
- **Leader election:** the bot takes a Postgres advisory lock at startup. A second instance waits as a hot standby, so only one gateway connection and one packer exist at a time.
- **Job workers (pg-boss queues):**
  | Queue | Priority | Notes |
  |---|---|---|
  | `blob.upload` | high | new jobs `NOTIFY` the leader, which takes them in batches of 8, four batches at a time, fetching again at once while batches come back full; concurrency per channel; retries with backoff; dead-letter after N attempts → affected versions `failed` |
  | `pack.seal` | high | packer loop (§6.6), every second; a loop over waiting frames, not a queue |
  | `journal.upload` | high | posts the journal batches the API sealed to `#dfs-journal`, in number order, every 5 s; a loop over `journal_batches`, not a queue; after a failure it waits longer each time, up to 5 minutes (backup pointers will go to `#dfs-backups` once snapshots are built) (§8) |
  | `blob.delete` | low | GC (§6.4), every 2 s; a loop over `deleting` blobs, not a queue |
  | `blob.compact` | low | merges packs that hold little (§6.6): a group a minute while no blob waits to be stored; a loop, not a queue |
  | `blob.verify` | lowest | rolling scrubber, request-budgeted *(not built, §6.5)* |
  | `reconcile.orphans` | hourly | scans channel history since the last checkpoint (`storage_channels.reconciled_through`) for this database's untracked `dfs1` messages (§6.1) |
  | `admin.task` | on demand | what an admin asks for on Admin → Storage (§9): create a data channel in the category, check the Discord layout (`dfs setup`), seal packs now, clean up orphans now, give uploads that gave up one more try (pg-boss's retry), try failing deletions now, compact packs now. One at a time, run once; the result is the job's output. The API queues one only while a bot leads with its queue running, and a task left waiting 10 minutes is dropped, so nothing runs long after it was asked for |
- **Slash command** (administrators only): `/dfs setup`. Status, health and adding a channel are on the admin pages (Overview, Monitoring, Storage), not in Discord; `/dfs status`, `/dfs health` and `/dfs channel add` were planned and aren't built.
- **Gateway:** for slash commands only; no message events are watched (D31). Only the leading bot connects, and only with `DISCORD_GATEWAY=on`, in the background: a failed connection is tried again every 30 s, and never holds up storing; on connecting it registers `/dfs` in the server (administrators only, checked again on every use). `/dfs setup` answers privately at once and reports what it changed when done.
- **Rate limiting:** relies on `@discordjs/rest`'s bucket handling, plus our own per-channel concurrency limiter. Rate-limit metrics are exported to `/internal/health`.

---

## 12. Scalability

Expected profile (D7): **few users (≤ ~20), many files.** The design targets **10M nodes and 10+ TB** without changing the architecture.

### 12.1 Where the bottlenecks are, and how each is handled

| Pressure point | Mitigation |
|---|---|
| **Discord message count** (rate limits) | Small-file packing (§6.6), batched journal (§8), batched URL refresh (50 blobs/call), more storage channels as needed. |
| **Discord upload throughput** | Parallel uploads across channels. Measure real per-channel throughput in M1 and size `UPLOAD_CHANNEL_CONCURRENCY` and the channel count from that. |
| **Postgres row counts** | Compact bigint keys on the high-volume tables. Every hot query is index-only or keyset-paginated, with no `OFFSET` or `COUNT(*)`. With 10M nodes, about 15M chunks, and a few million blobs, the DB stays in the tens of GB, comfortable on a single PG instance. `chunks` can be hash-partitioned by `version_id` later if needed (the schema allows it without app changes). |
| **Hot rows** (folder sizes, quota) | **Folder sizes are eventually consistent**: a write marks its folder dirty (`folder_stats_dirty`, one row per folder however many writes), and a loop in the bot recomputes dirty folders and their ancestors from the tree every 2 s, children before parents, a level per statement. Bulk uploads never contend on the root folder's row, and a recompute can't drift the way summed deltas can. Quota is a per-user row: completions take it last, so they hold it only until commit, and every writer takes its locks in one order (`packages/db/src/locks.ts`), so concurrent uploads can't deadlock. There are two deliberate serialization points: the journal's commit-order lock (§8) and Postgres's serialization of commits that `NOTIFY` (§6.1). Bulk work hits both once per batch or pack, not once per file. Single actions, such as one upload or a rename, cost one serialized commit each. |
| **Huge folders** | Keyset pagination plus virtualized rendering. No "load all children" code paths. |
| **Bulk operations** (trash or move 100k items) | Moves are O(1) (only the parent changes). Trash and restore of very large subtrees run as batched background jobs (§6.3). |
| **API CPU/IO** (encryption, streaming) | The API is **stateless**: sessions live in PG, staging is a shared volume, the cache is per instance, and live events fan out through Postgres `LISTEN/NOTIFY` (§6.1), so any instance can serve any user's SSE stream. Scale with `docker compose up --scale api=N`; Caddy load-balances. |
| **Job queue volume** | Jobs are per **blob**, not per file. Rows are inserted in batches. pg-boss archive retention is tuned (completed jobs are kept for 1 day). |
| **Postgres connections** | Each service has a small pool, plus one `LISTEN` connection per API instance. Add PgBouncer (transaction mode) if the API is scaled past a few replicas. The `LISTEN` connections and the bot's leader advisory lock need session-level connections, so they bypass PgBouncer. |
| **Scrubbing millions of objects** | Scrubbing works per blob (not per file) and is request-budgeted (§6.5). |

### 12.2 Capacity estimate (worked example)

| Input | Value |
|---|---|
| Files | 2,000,000 (90% small, average 200 KB; 10% large, average 25 MB) |
| Data | ≈ 360 GB small + ≈ 5 TB large |
| Small-file packs | 360 GB ÷ ~20 MiB per pack ≈ **17k messages** (vs. 1.8M unpacked) |
| Large-file blobs | 5 TB ÷ `CHUNK_SIZE` ≈ 483k, plus about half a chunk per file for the partial last chunk ≈ **580k messages** |
| `chunks` rows | ≈ 2.4M · `blobs` rows ≈ 615k · `nodes` rows ≈ 2.1M |
| DB size (incl. indexes) | roughly 3–5 GB |

---

## 13. Development & Deployment

### 13.1 Local development (Windows)

| Piece | How it runs locally |
|---|---|
| Node.js 24 LTS + **pnpm** (via Corepack) | Native on Windows. `pnpm` itself must be on the PATH (`corepack enable pnpm`), because Turborepo calls it; `corepack pnpm …` alone is not enough |
| PostgreSQL 18 | `pnpm db:up` (Docker Desktop), then `pnpm db:migrate`. Port `5432` is published to **localhost only**. It starts with `pg_stat_statements` loaded, as production will, for Admin → Database (§16) |
| media (`:3002`) | `pnpm db:up` too: its image, with ffmpeg, which the development machine needn't have (§6.7), built the first time (about a minute) and again when it changes. It reads files from the API on the host through Docker Desktop's `host.docker.internal`; port `3002` is published to localhost only. Without it, Admin → System says it isn't answering, and audio and video play only as they are |
| api (`:3000`), bot (`:3001`), web (`:5173`) | `pnpm dev` (pnpm runs all three in parallel, avoiding Windows batch-shell shutdown hangs: `node --watch` on the TypeScript sources, D22, and Vite) |
| First account | `dfs owner` creates the owner and prints a temporary password, as in production (§7.1) |
| Web → API | The Vite dev server proxies `/api` to `localhost:3000`, so the browser sees one origin, as it will in production |
| Discord | The production server and bot, with development's own `DFS Dev` channels and no gateway connection (D25, §4). Development never touches production's channels |
| No-Discord mode | `BLOB_STORE=local` swaps in `LocalBlobStore` (files under `./.data/blobs`). Most work, including all of M0–M3 UI work, can happen offline |
| No-backend mode | `pnpm dev` with no API running: the web app uses its in-browser mock API (§10, D14). `VITE_API_MOCKS=off` (in `apps/web/.env.local`) points it at the real API instead |

- The repository uses `.gitattributes` with `* text=auto eol=lf`, so shell scripts and config files work unchanged on Fedora.
- Paths are always built with `node:path`, never hard-coded separators.

### 13.2 Production (single Fedora VPS)

- **Container runtime:** Docker Engine + Compose plugin from Docker's official Fedora repository (recommended for Compose parity with dev). The Compose files also avoid features that break under Podman (`podman compose`), so Podman stays possible.
- **SELinux** (enforcing by default on Fedora): data lives in **named volumes**, and configs (Caddyfile, built SPA) are **baked into images**, so no SELinux relabeling (`:Z`) is needed. Any bind mount that is added later must use `:Z`.
- **firewalld** (not set up on the first VPS, see Host hardening below): allow only `ssh`, `http`, `https`. No `443/udp`: Caddy serves HTTP/1.1 and HTTP/2 only, not HTTP/3, which some networks hold far below TCP (a phone took 2–8 Mbit/s over it, and 30–70 over HTTP/2 from the same network, 2026-10-09). Docker writes its own iptables/nftables rules for published ports. That is fine here because only Caddy publishes ports.
- **Secrets:** one file each in `/etc/dfs/secrets` (`postgres_password`, `database_url`, `internal_rpc_secret`, `discord_bot_token`, `master_key`), mounted read-only as Compose `secrets:` in `/run/secrets`, and read through `DATABASE_URL_FILE`, `INTERNAL_RPC_SECRET_FILE` and `DISCORD_BOT_TOKEN_FILE` (§15) and `MASTER_KEY_FILE`. Each service gets only the ones it uses. Outside Swarm, Compose mounts the files as they are on the host, so each is mode `0400` and owned by the user of the container reading it: uid 1000 for the API and the bot, 70 for Postgres; on SELinux, the directory carries the `container_file_t` label. The master key is made by `dfs master-key` and kept off the server too. Nothing sensitive goes into images (`.dockerignore` leaves out `.env` files and `.data`) or into files committed to git; the settings that aren't secret are in `docker/.env`, from `docker/.env.example`.
- **Images:** `docker/server.Dockerfile` (the API, the bot and the migration: one image, three commands, keeping the workspace's layout, since Node runs the TypeScript sources and won't strip types under `node_modules`) `docker/caddy.Dockerfile` (Caddy with the Caddyfile and the built web app), and `docker/media.Dockerfile` (the media service with Debian's ffmpeg, §6.7). All run without root; logs rotate at 10 MB, five files each. A deploy reuses the base images it has, so security fixes in them arrive with `docker/deploy.sh --refresh`, which fetches the newest and builds anew (monthly, docs/DEPLOY.md).
- **Lifecycle:** `restart: unless-stopped` and Docker enabled via systemd (`systemctl enable --now docker`). Updates: `docker/deploy.sh` on the development PC, which sends the committed code over SSH to `/opt/dfs`, replacing it whole, and runs `docker compose up -d --build` there. Migrations run automatically in a one-shot `migrate` service before `api`/`bot` start. The runbook is [DEPLOY.md](DEPLOY.md).
- **Code (D26):** a private GitHub repository. The VPS has no access to it: it gets the code from the development PC (the owner's choice at the first deployment, over a deploy key). There is no CI: `pnpm check` (format, typecheck, lint, tests) runs locally before committing and deploying.
- **Host hardening:** `dnf-automatic` security updates, SSH key-only login, fail2ban (optional), and a non-root deploy user in the `docker` group. The first VPS goes without it, by the owner's choice: it serves other uses too.
- **Disk:** staging (`STAGING_MAX_BYTES`) and the frame cache (`CACHE_MAX_BYTES`) must fit on the VPS disk alongside Postgres. Size the VPS disk from those plus the DB estimate (§12.2).

---

## 14. Repository Layout

pnpm workspaces + Turborepo.

```
dfs/
├─ apps/
│  ├─ web/            React SPA (Vite), with an MSW mock API in src/mocks
│  ├─ api/            Fastify HTTP API
│  ├─ bot/            discord.js worker + packer + internal RPC
│  ├─ media/          ffmpeg: media info, subtitles, covers (§6.7)
│  └─ desktop/        (planned) the backup app: Electron, Windows first (§6.9)
├─ packages/
│  ├─ backup-engine/  (planned) the backup app's engine, plain Node (§6.9)
│  ├─ shared/         Zod schemas, DTO types, constants
│  ├─ config/         env parsing (Zod) shared by api/bot
│  ├─ db/             Drizzle ORM schema, migrations, query helpers
│  ├─ crypto/         envelope encryption, frame format (DFS1), hashing
│  ├─ storage/        BlobStore interface + DiscordBlobStore + LocalBlobStore + ChaosBlobStore
│  └─ contract/       the API's contract suite, run against the mock and the real API (§17)
├─ tools/
│  └─ dfs-reencode.*  re-encodes the user's own videos on their own PC so they seek fast (§6.7)
├─ docker/
│  ├─ docker-compose.dev.yml    local dev: Postgres and the media service
│  ├─ docker-compose.yml        production: caddy, api, bot, media, postgres, migrate
│  ├─ Caddyfile                 TLS, SPA, route allowlist, streaming settings
│  ├─ *.Dockerfile              multi-stage builds per app
│  ├─ deploy.sh                 sends the committed code to the VPS and restarts DFS there
│  └─ new-discord.sh            moves production to a new Discord server or bot (DEPLOY.md)
└─ docs/
   ├─ DESIGN.md      the spec
   ├─ DEPLOY.md      the server: setup, deploying, looking after it
   └─ TESTING.md     testing locally
```

The `dfs` admin CLI (`owner`, `setup`, `master-key`, `recover`, `drill`, `reset-storage`) is `apps/api/src/cli.ts`, run as `pnpm dfs`: it lives in the API and shares its code.

The **`BlobStore` interface** (`put(blob) → ref`, `get(ref, range?) → stream`, `delete(ref)`) keeps the file-system logic independent of Discord. It exists so tests and offline development can use `LocalBlobStore` and `ChaosBlobStore`. Production only ever uses `DiscordBlobStore` (no mirroring, D5).

### 14.1 Technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 24 LTS | Current LTS; native `fetch`, web streams. Runs the TypeScript sources directly with type stripping, so api, bot and packages have no build step (D22) |
| Language | TypeScript 6.0 | Strict, with `erasableSyntaxOnly` so shared code also runs under Node's type stripping. Not 7.0 yet: typescript-eslint does not support it |
| Frontend | React 19 + React Compiler, Vite 8, React Router 8, TanStack Query/Virtual, Tailwind 4 + shadcn/ui, zustand | See §10 |
| Package manager | pnpm 10 + Turborepo | Fast workspaces, cached task graph |
| HTTP | Fastify 5 | Fast, good streaming, schema validation via Zod type provider |
| Database | PostgreSQL 18 | Native `uuidv7()`, async I/O, mature |
| ORM / migrations | Drizzle ORM + drizzle-kit | SQL-first, typed, light; easy to drop to raw SQL for recursive CTEs and partial indexes |
| Job queue | pg-boss | Postgres-backed: one less service, transactional enqueue with metadata writes |
| Discord | @discordjs/rest, core and ws (the discord.js v14 family) | De-facto standard, built-in rate-limit handling; the bot needs only REST and a gateway connection for its slash command, so not discord.js's cache |
| Crypto | Node `crypto` (AES-256-GCM, HKDF, and argon2id through `crypto.argon2` for passwords and share-link passwords) | No exotic dependencies |
| Logging | pino | Structured JSON, fast |
| Testing | Vitest, Testcontainers (Postgres and the media image), MSW (mock API). Playwright was chosen for browser tests and isn't set up (§17) | |
| Lint/format | ESLint + Prettier | |

### 14.2 Conventions

**Running TypeScript in Node (D22).** Node 24 strips types, so `node src/main.ts` runs the sources as they are: the API, the bot, the media service and their packages have no build step. The base config enforces what that needs (`erasableSyntaxOnly`, `verbatimModuleSyntax`); the rest is these rules:

- **Imports name their files:** `import { x } from './x.ts'`. Workspace packages export `.ts` entry points.
- **No path aliases at runtime.** Use relative imports, or package.json [subpath imports](https://nodejs.org/api/packages.html#subpath-imports) (`"imports": { "#*": "./src/*" }`), which Node resolves natively.
- **JSON imports** need `with { type: 'json' }`.
- **Typecheck with Node's rules:** packages Node runs extend `tsconfig.node.json` (`NodeNext`), since the base config's `Bundler` resolution accepts imports Node would reject. The web app, which Vite builds, uses the base config.
- **Node refuses to strip types under `node_modules`.** Workspace packages are reached through pnpm's links, which resolve to real paths outside it, so they work as they are. The production image keeps the workspace's layout for the same reason (§13.2).
- Each service runs its own `src/main.ts` directly: `node --watch` under `pnpm dev`, and plain `node` in the images (the API, the bot and the migration share one image with three commands; the media service has its own, §13.2).

**The API.**

- **One error shape:** `{ error: { code, message } }` (the shared `apiErrorSchema`), with codes such as `name_conflict`, `invalid_move`, `quota_exceeded` and `share_locked`. A service throws an `ApiError` (status, code, message); anything else becomes `500 internal_error` with the request ID in the log, never a stack trace in the response.
- **Validation from the shared schemas:** routes declare their bodies, queries and replies with the Zod schemas of `@dfs/shared` through the Zod type provider, so the API and the UI can't drift. The mock API and the real one answer the same contract suite (§17).
- **Routes are thin:** a route parses, authorizes and calls a service function (`nodes`, `uploads`, `content`, `shares`, `admin`, `events`), which takes a transaction. Authorization checks live in the service layer (§7.2).
- **Changes that matter for recovery** write their journal records in the same transaction (§8).
- **Streaming:** content and archive routes stream; nothing reads a whole file into memory.

---

## 15. Configuration

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `DATABASE_URL` | — | |
| `BLOB_STORE` | `discord` | `local` for offline development and tests; `chaos` (development only) is `local` with the bot's writes failing now and then, to exercise retries (§17) |
| `LOCAL_BLOB_DIR` | `./.data/blobs` | when `BLOB_STORE=local` |
| `DISCORD_BOT_TOKEN` | — | bot only; not needed when `BLOB_STORE=local` |
| `TEMP_PASSWORD_DAYS` | `7` | how long a temporary password set by an admin or `dfs owner` works (§7.1) |
| `DISCORD_GUILD_ID` | — | the server; the bot needs it, and the token, with `BLOB_STORE=discord` |
| `DISCORD_CATEGORY_NAME` | `DFS` | the channel category this environment uses and creates (§4); `DFS Dev` in development |
| `DISCORD_GATEWAY` | `on` | `off` in development: REST only, no slash commands (D25) |
| `DISCORD_ATTACHMENT_LIMIT` | `20971520` | 20 MiB (unboosted server, since August 2026; D1). Only raise it if the server is boosted. |
| `BLOB_MAX_BYTES` / `CHUNK_SIZE` | derived | Not set directly. Attachment limit − 64 KiB (hard cap on every attachment) / the largest multiple of 64 KiB that fits one frame under that cap (§7.3) |
| `PACK_THRESHOLD_BYTES` | `4194304` | files smaller than this are packed |
| `PACK_TARGET_BYTES` | `BLOB_MAX_BYTES` − 256 KiB | soft target: seal a pack once it reaches this size. Packs never exceed `BLOB_MAX_BYTES` |
| `PACK_MAX_WAIT_MS` | `30000` | seal a partial pack after this long. Staging serves the files meanwhile, so waiting only delays when they are safe in Discord; files that trickle in within half a minute share a message instead of taking one each |
| `COMPACT_THRESHOLD` | `0.3` | share of a full pack (`PACK_TARGET_BYTES`) under which a pack's live bytes make it a candidate for compaction (§6.6) |
| `COMPACT_MIN_AGE_DAYS` | `7` | how long a pack waits before compaction merges it on its own; Compact packs now doesn't wait |
| `MASTER_KEY_FILE` | `/run/secrets/dfs_master_key` | api only. Holds the current key and every retired key, each with its `key_id` (§7.3). `dfs master-key <file>` makes a new one, never over an existing file |
| `STAGING_DIR` / `STAGING_MAX_BYTES` | `/data/staging` / `20 GiB` | shared volume. *Planned:* also the largest file an upload may be (D38, §6.1) |
| `CACHE_DIR` / `CACHE_MAX_BYTES` | `/data/cache` / `5 GiB` | per api instance |
| `MEDIA_INTERNAL_URL` | `http://media:3002` | api only: the media service (§6.7); unset, audio and video play only as they are. Development: `http://localhost:3002`; tests: none |
| `API_INTERNAL_URL` / `MEDIA_PORT` | `http://api:3000` / `3002` | media only: where it reads files from, with the API's token for each (never a caller's URL), and where it listens. It reads no other setting, and no secret |
| `UPLOAD_CHANNEL_CONCURRENCY` | `2` | in-flight uploads per channel |
| `SCRUB_REQUESTS_PER_HOUR` | `600` | scrubber budget. Read by nothing yet: the scrubber isn't built (§6.5) |
| `JOURNAL_FLUSH_INTERVAL_MS` | `60000` | |
| `BACKUP_RETENTION` | `7` | nightly snapshots to keep (§8). Read by nothing yet: snapshots aren't built |
| `TRASH_RETENTION_DAYS` / `TRASH_SYNC_LIMIT` | `30` / `50000` | |
| `LOCK_IDLE_MINUTES` | `15` | *planned:* how long a locked folder stays open in a browser with nothing done inside (§7.7) |
| `LOCKED_FOLDER_MAX_CHILDREN` | `10000` | *planned:* items in one folder inside a locked folder, which is listed whole (§7.7) |
| `BACKUP_STALE_DAYS` | `3` | *planned:* a backup source with no completed run for this long raises its alert (§6.9) |
| `DEFAULT_QUOTA_BYTES` | `100 GiB` | per user |
| `INTERNAL_RPC_SECRET` | — | api ↔ bot |
| `BOT_INTERNAL_URL` | `http://bot:3001` | used by the api |
| `PUBLIC_BASE_URL` | — | public URL (VPS domain), used for share links and the sign-in `Origin` check |
| `API_PORT` / `BOT_PORT` | `3000` / `3001` | |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.1/32,::1/128` | addresses allowed to set `X-Forwarded-*`. Production sets the subnet of the Compose network Caddy is on; otherwise every request seems to come from Caddy |
| `LOG_LEVEL` | `info` | |
| `DFS_VERSION` / `DFS_DEPLOYED_AT` | `dev` / — | which deploy this is (its git revision) and when: `docker/deploy.sh` builds them into the images, and pages use them to notice a newer version (§10.2). `dev` turns the pages' check off |

**Secrets from files:** `DATABASE_URL`, `INTERNAL_RPC_SECRET` and `DISCORD_BOT_TOKEN` may each come from a file instead, named by `<NAME>_FILE` (as Compose mounts them, §13.2), without its line ending; setting both is an error. Commands and migrations need only the database: the API–bot secret is required of the API and the bot alone.

**Development defaults:** with `NODE_ENV` set to `development` (the default) or `test`, every setting has a default that works with `docker/docker-compose.dev.yml`: `DATABASE_URL` points at it, `INTERNAL_RPC_SECRET` has a fixed development value, `PUBLIC_BASE_URL` is the Vite dev server (`http://localhost:5173`), `MASTER_KEY_FILE` is `./.data/master-key.json` (created on first start if missing, in development only), `BOT_INTERNAL_URL` is `http://localhost:3001`, `MEDIA_INTERNAL_URL` is `http://localhost:3002` (development only), `BLOB_STORE` is `local`, `DISCORD_CATEGORY_NAME` is `DFS Dev`, `DISCORD_GATEWAY` is `off` (D25), and staging and the cache live under `./.data`. Relative directories resolve against the repository root. Production has no defaults for the database and the secrets, and requires `INTERNAL_RPC_SECRET` to be at least 32 characters.

At startup, config parsing rejects size settings that can't work: it requires `PACK_THRESHOLD_BYTES + 38 ≤ BLOB_MAX_BYTES` (otherwise some small-file frames could never be packed) and `PACK_TARGET_BYTES ≤ BLOB_MAX_BYTES`.

**Admin → System** shows the settings in effect from a fixed list in `packages/config` (`describeSettings`): each as its variable, its value as it would be written (`20 GiB`), whether it was set or is the default, and which service reads it (the API, the bot, or both), since each container may be given only its own. The bot answers on `/internal/settings` with the settings it reads, whether its secrets are set, and its Discord server, category and gateway. Settings only the bot reads, and the Discord card, show the bot's; settings both read are marked where the bot's differ, since those must agree (the same staging directory, the same attachment limit). `DATABASE_URL`, `INTERNAL_RPC_SECRET`, `DISCORD_BOT_TOKEN` and `MASTER_KEY_FILE` show only whether they are set, in the service that uses them; no other part of the config leaves the process.

---

## 16. Observability

- Structured JSON logs (pino) with request and job correlation IDs. Each file read logs a line when its response closes (`file sent`): the range, the bytes sent, whether it finished or the client cancelled it, the time to its first byte, its rate, and how long it waited for the reader (the cache, staging or Discord) against how long for the client to take what was sent, so a slow download or play shows which side held it back. Players report each play (§10.4, `video play reported`), and the connection test logs each test (`connection tested`). A request the API refuses logs its error code beside its status (`request refused`, or `request failed` at warn for a 5xx it chose), never the message, which can repeat what the request held; a malformed request also logs where in it, not what was there.
- `/api/health` (liveness + DB check) and `/internal/health` for container health checks. `/api/health` is also asked by the API's own check (below), so its requests are logged only when something is wrong.
- **Metrics in Postgres** (D29), for the admin's graphs. Each process records what it does in memory, by half minute, and every 5 s adds it to the `metrics` table in one statement: a row per metric and bucket, of half a minute, a minute and an hour, with the sum, count and peak of what was recorded. Rows from several processes add up, so two API instances count as one. Half minutes are kept 3 hours (the last hour's graphs read them), minutes 2 days and hours 400 days; the leading bot's janitor drops older rows. Figures that couldn't be saved wait for the next flush (up to an hour), and a stopping process saves what it has.
- **What is recorded** (the catalog is `METRICS` in `packages/shared`):
  - *API:* requests, 4xx and 5xx; response times (as percentiles, from fixed buckets, so they add up across processes and time; the buckets are fine below 10 ms, where most answers are, so a percentile there is read to within a millisecond or two), leaving out downloads, uploaded parts and event streams, whose time depends on their size, and taking in health checks, which aren't counted as requests: the API's own check gives every half minute a response time; bytes sent to and received from browsers; for each file read once it closes, its time to the first byte, the time it waited after it for storage (the cache, staging or Discord) and for the client to take what was sent, so the graphs show which side holds viewers back, and whether it broke off (a failure of its source, not a client that left); frame cache hits, misses and size; CDN reads and failures, its 429s and the reads that waited them out, the time it takes to answer (percentiles), and, as peaks between samples, reads from it under way and downloads to browsers under way, which show many viewers sharing the link to Discord; open event streams; sign-ins and failed sign-ins.
  - *Bot:* every Discord request, 429 and 5xx, and every wait the REST client chose to stay inside a rate limit, all seen in one place, its shared client; blobs posted with their bytes, failed posts, deleted messages, signed URLs, packs sealed, packs compacted with the bytes that freed in Discord and the packs that failed to, orphans deleted.
  - *Media,* recorded by the API, which every request to the media service goes through (the service has no database): the time it takes to examine a file, extract its subtitles and copy out a cover, timed from the API's ask; the bytes it reads of files from the API (`media.read_bytes`), which never leave the VPS and aren't downloads: none of the downloads' figures count them, nor does compaction wait for them (examining each audio or video upload as it completes reads some of a long file and most of a short clip, so during an upload of iPhone videos on production, 2026-10-11, they had read 6.9 GB of 23.1 GB received, shown as sent to browsers until then); asks it failed (no answer, an error, or an answer out of bounds; a file that isn't media, or has no cover, is an answer); and files it examined and couldn't read as audio or video. An alert (`media_down`) says when it doesn't answer the API's health check: audio and video then play only as they are, and a file not examined yet shows no formats, chapters or subtitles inside it.
  - *Players,* as they report their plays (§10.4), through the drive and links: plays that showed their first frame, plays left before it, and plays that couldn't play, also by why (a codec the browser can't play, a file it can't read, a read that failed, or else; one counter each, as metrics have no labels); the time to a video's first frame and to its playing; each seek's time to its picture (a report sums its seeks, so each is timed as their average); and plays that stalled after it (with the time they waited).
  - *Both:* memory, heap, CPU and event loop delay, every 5 s. The delay is how much later the slowest ticks of a 20 ms timer came than its quickest, not than 20 ms: Windows keeps such a timer at about 31 ms, which would read as a constant 12 ms of delay.
  - *The system,* sampled by the leading bot every half minute, 2 s into it on the clock so each half-minute bucket gets exactly one sample, and counted once: sync backlog, staging, stored and live bytes, blobs by state, queue depth and failures, database size, users, files and sessions. These are the overview's figures too (`systemFigures`): each reads an index or a small table, except one pass over `blobs`.
- **The API's checks** (`apps/api/src/checks.ts`), so response times are measured all the time, not only while people use DFS: every 10 s, once it listens, each API instance asks Discord (`https://discord.com/api/v10/gateway`, which needs no token), the internet (Google's connectivity check, `https://www.gstatic.com/generate_204`) and itself (`/api/health`, over loopback). Each check is one request on a new connection, so it is the same every time: the name lookup, the connection, TLS and the answer, to its last byte. An answer within 5 s, of any status below 500, is timed (`check.discord.ms`, `check.internet.ms`); anything else is a failed check (`check.discord.failures`, `check.internet.failures`). The API times its own answer as it times any request (`http.ms`). Nothing is smoothed over: while the API runs, these graphs have a figure in every half minute, so a gap means it didn't run. The last minute's checks also make the overview's Discord and Internet services: the median answer, degraded after a failed check, down after three in a row, and "Checking…" until the first has ended (tests build the API without starting them).
- `GET /admin/metrics` reads any of them over a range, summed into a few hundred buckets on the server: a counter as a rate (of its amounts or of its events) or its peak, a gauge as its average or peak, a timing as p50, p95, p99, average or peak. The last hour is read in half minutes, longer ranges in minutes or hours. Only buckets that ended 8 s ago or more are read (`metricsUntil`, `until` in the answer): by then every process has added its figures (every 5 s), so the last point never reads low and then grows, and on the last hour a new one comes every half minute. The last point is the bucket those figures end in; if that bucket isn't over (the current hour on a week), its rates count only the time read, and it is read from its minutes rather than its hour, whose row still takes figures. The graphs refetch twice per bucket on the last hour (every 7.5 s), and less often on longer ranges. A count (a rate, or events) is 0 in a bucket only if the process that counts it ran then, as its memory sample, taken every 5 s, shows; otherwise it has no data, as a level does, so a stopped API reads as a gap rather than as no requests.
- **PostgreSQL**, sampled by the leading bot every half minute, with the system's figures, from its own statistics views (`PostgresSampler`): connections, queries running, queries waiting for locks, the longest open transaction and dead rows as levels; commits, rollbacks, deadlocks, blocks found in memory or read from disk, rows read and written, temporary files and WAL as what they grew by since the last sample (a total that went down was reset, and is skipped). The slowest statements come from `pg_stat_statements` (migration 0010 creates it where it may; the server must load it with `shared_preload_libraries`), which keeps statements normalized, without their values.
- **Graphs** are drawn by the web app itself, as SVG: thin lines on hairline gridlines, each point at the middle of the time its bucket covers (so the axis reads true, and the last point stands where the figures end), lines broken where there is no data rather than bridged, a point between gaps (a minute with a single request) as a dot, a dot at each line's latest value, a crosshair that reads every line at a time (also with the arrow keys; "no data" where there was none, "so far" on a bucket under way), a legend with each line's figure for the range (the total of a rate, the latest level, the percentile), and the same values as a table. Series colours come in a fixed order checked for colour-blind readers against the card in both themes; lines that mean trouble wear status colours, always with their names. A new range keeps the old graph, faded, until it loads.
- **Alerts** come with `GET /admin/health`, worked out on the server from the same figures and the last hour of metrics (`apps/api/src/admin/alerts.ts`): critical when the bot doesn't answer, Discord doesn't answer the API's last three checks (a single alert, "the server can't reach the internet", when the internet's don't either), or staging is 95% full; warnings when someone asked for a new password (§7.1), the bot isn't leading, the media service doesn't answer (none set up is no alert) or, answering, failed 5 asks in the last hour, staging passes 80%, uploads gave up, the oldest waits 15 minutes, deletions keep failing, or in the last hour 5 posts failed, 20 requests got 429, 10 CDN reads failed, 3 file reads broke off while sending, 3 plays stopped on a failed read as their players reported (a warning at most: anyone with a link can send reports, 60 in 10 minutes from an address), 1 file read in 20 took 5 s or more to its first byte (over 20 reads at least), or 5 requests ended in a server error. For PostgreSQL: connections at 80% of `max_connections` (critical at 95%), a transaction open 10 minutes, a query waiting 30 s for a lock, or a deadlock in the last hour.
- `#dfs-log` is kept for events worth a message (backups, rate-limit storms, staging near full); nothing posts there yet, and the alerts are on Admin → Overview.

---

## 17. Testing Strategy

| Level | Scope |
|---|---|
| Unit | Crypto round-trips and tamper detection (including flipped header bytes and frames moved between object types or versions), frame parsing, pack assembly/offsets (property test: a pack never exceeds `BLOB_MAX_BYTES`), chunk math (range → chunks), name normalization, tree cycle detection |
| Contract | One HTTP-level suite (`packages/contract`) of every rule of §5–§7 the UI relies on: names, cycles, trash, pagination, quotas, uploads, versions, shares, admin, media. It runs against the mock API's handlers (MSW, in Node) and against the real API (on local storage, and on a Discord kept in memory), so the mock and the API can't drift |
| Integration | API + Postgres (Testcontainers) + `LocalBlobStore`: full upload/download/trash/purge flows, packing and compaction, quota accounting, concurrent renames, SSE events across two API instances, and a **recovery drill**: rebuild an empty DB from the blob store alone (the journal; with snapshots, once built, snapshot + journal) and diff it against the source DB |
| Media | The media service against files ffmpeg makes in the test (MP4 with H.264 and AAC, MKV with HEVC and AC-3, AVI with MPEG-4, which no browser plays, MP3 with tags and a cover, FLAC): media info, subtitles and covers; the media routes in the contract suite, on the mock and the API (with a stand-in media service). ffmpeg runs in the media image (Testcontainers), as in production; what needs no ffmpeg, such as reading ffprobe's answers, is tested on its own |
| Scale *(not built)* | Seed 1M nodes and check that listing, search, and move latencies stay within budget (p95 < 100 ms for list and search) |
| Discord contract | `DiscordBlobStore` against `#storage-03` in the `DFS Dev` category (opt-in, real token; D25; `pnpm --filter @dfs/storage check:discord`): upload, Range read on the CDN, URL refresh, delete, and a repeated `nonce` answered with the first message |
| Fault injection | A `ChaosBlobStore` wrapper: random 429s, 5xx, timeouts, dropped responses after a successful post (to test idempotency and the reconciler). `BLOB_STORE=chaos` (in the root `.env` or the environment of `pnpm dev`) runs the bot on it, and `check:engine` (in `apps/web`) drives the real upload engine against that stack while failing requests, losing answers and cutting the connection mid-file |
| Stack checks | `check:end-to-end` (in `apps/api`), against a running stack: 1,000 small files and a 1 GB file up, synced and back byte for byte, then 12 clients uploading versions of the same names at once |
| E2E *(not built)* | Playwright: a first sign-in with a temporary password, upload a folder of 1,000 files, preview a video with seeking, share link, restore from trash. Today these are done by hand in a browser (docs/TESTING.md) and, for uploads, by the two stack checks above |

---

## 18. Milestones

```mermaid
flowchart LR
    M0["M0 · Foundations<br/>monorepo, dev compose,<br/>DB schema + migrations,<br/>config, health endpoints"] --> M2["M2 · API core<br/>on local storage: password sign-in,<br/>nodes, versions, uploads,<br/>Range download, shares, live events"]
    M3["M3 · Web UI<br/>done against the mock API,<br/>then previews and players"] -.->|"switches to the real API"| M2
    M2 --> M1["M1 · Storage engine on Discord<br/>bot, packer, CDN URLs"]
    M1 --> DEP["First deployment<br/>Compose + Caddy on Fedora,<br/>test data only"]
    DEP --> M4["M4 · Durability<br/>GC, compaction, journal, recover tool<br/>(scrubber, DB backups: not built)"]
    M4 --> M5["M5 · Finish<br/>real data, previews and players,<br/>admin search (not built), hardening"]
    M5 --> M6["M6 · Planned<br/>large-file cap, device tokens,<br/>WebDAV mount, locked folders,<br/>desktop backup app"]
    M6 --> F["Future<br/>thumbnails, E2EE, parity blobs,<br/>dedup, two-way sync, split hosts"]
```

The numbers are the original milestones; the arrows are the order of work (D19): the API comes before Discord storage, so the finished UI runs against a real server early, and the first deployment happens once Discord storage works (D23).

**MVP = M0, M2, M1 and the UI.** Users can log in, upload a large file or a folder with thousands of small files, see them sync to Discord, browse, and stream content back.

### 18.1 Status and future work

**Done (2026-10-04):** the web UI, built first against the mock API (D14). It covers the screens of §10.1 except Preview: drive with drag-to-move and ZIP downloads, upload panel and engine, trash, shared links, the public share page, settings, and the admin area, with live events and the motion described in §10. The mock implements the §9 contract in the browser, and its spec tests (`apps/web/src/mocks/db.test.ts`) encode the rules the real API must follow.

**Done (2026-10-04):** M0 and M2. The API runs the whole §9 contract on local storage, the bot moves encrypted frames into the local blob store, and the web app works end to end against it (`VITE_API_MOCKS=off`). It was checked with the contract suite on both targets and the stack checks of §17.

**Done (2026-10-05):** M1. Blobs are stored in Discord, small files packed, CDN links signed by the bot and frames cached on the API's disk. Its watch for messages deleted in Discord went again with D31.

**Done (2026-10-06):** the admin console. Metrics in Postgres (D29) with the API's own graphs and alerts; tabs for monitoring, access, storage control through tasks for the leading bot, PostgreSQL and the system's settings.

**Done (2026-10-06):** the first deployment. DFS runs at `https://dfs.xlestudio.it` on the Contabo VPS: Caddy with a Let's Encrypt certificate, the API, the bot with the gateway and the `DFS` channels, and PostgreSQL, in Docker, sent from the development PC by `docker/deploy.sh`. [DEPLOY.md](DEPLOY.md) is the runbook. It held test data only until the recovery drill passed (D23).

**Done (2026-10-07):** M4, durability, but for the scrubber and nightly snapshots, both left for later by the user: the GC, the journal on Discord, `dfs recover` and its drill (passed against production's Discord on 2026-10-07, the milestone's exit: real data is allowed), and, from 2026-10-08, compaction. Without a snapshot, recovery replays the whole journal from its first batch (§8).

**Done (2026-10-08):** previews of images, PDFs, text and code (§10.3, D33), in the drive and on the share page.

**Done (2026-10-08 to 10):** audio and video (§6.7, §10.4, D34, D35): the media service (media info, subtitles, covers), direct play in a video player and an audio bar with folder queues, on links as in the drive, with resuming offered rather than assumed, why a video is slow, and stream links to open what the browser can't play in the device's player or VLC. Nothing is converted on the server; a remux was built and dropped.

**Next** (M6, planned 2026-10-11, D38–D41), in this order (the user's choice, 2026-10-12): the cap on files larger than staging and staging reservations (§6.1, D38), which all three need, since the mount and the backup app make large uploads routine and locking a folder re-encrypts what goes in through staging; device tokens (§7.6), which both sign in with; the network drive (§6.8); locked folders (§7.7); and the desktop backup app (§6.9). Then seek thumbnails (§6.7; `tools/dfs-reencode` for the user's own videos is made), nightly snapshots and the scrubber, when the user wants them.

**Settled, not built: uploads larger than staging** (found 2026-10-07; the user's decision, 2026-10-11, D38). An upload's frames stay in staging until it completes, because only completion hands them to the bot. Until D38 is built, a file larger than `STAGING_MAX_BYTES` (30 GiB in production) fills staging with its own frames and can never finish; meanwhile every upload, anyone's, waits on `503 staging_full`, and since a failed upload's page keeps its session alive, staging stays full until that page closes and the lease gives it up (§6.1). Two large uploads at once can block each other the same way. Of the two ways out, the user chose to refuse a file larger than staging and reserve staging per upload as it starts (§6.1), over letting the bot post a receiving upload's frames as they arrive (no cap, but abandoned uploads leave posted blobs for the GC).

**Web UI, still to do:**

- **Seek thumbnails** (§6.7).
- **Inline rename** in lists (a dialog today), and **select-all across pages** of a large folder (today Ctrl+A selects the loaded rows; needs a server-side "whole folder except" selection for bulk actions).
- **Admin search** across users (`GET /admin/search`).
- **Downloads left on the share page:** it refetches the count right after a download starts, which against the real API can be before the server counted it; decrement it optimistically instead.
- **Thumbnails** in the grid (D13).
- **End-to-end tests** with Playwright (§17), including the motion and drag-and-drop flows that unit tests can't see.

**Later:** the non-goals of §1.2 that may come: end-to-end encryption, parity blobs, deduplication, two-way sync, split hosts.

---

## 19. Decisions Log

| # | Question | Decision | Where reflected |
|---|---|---|---|
| D1 | Chunk size / boost level | **20 MiB** attachment limit (unboosted). Blobs are at most 20 MiB − 64 KiB. Discord raised its free limit from 10 to 20 MB in August 2026; on 2026-10-08 the bot posted exactly 20 MiB, and 20 MiB + 1 byte was refused (413, code 40005). Files stored under the 10 MiB limit keep their chunk size. Larger chunks halve the messages per file, but a cold read's first byte, and a cold seek, wait for a whole 20 MiB frame: it arrives in about 3 s through the development machine's link, in 0.6–0.95 s at the VPS (measured 2026-10-08, §6.2). | §2, §6.2, §7.3, §15 |
| D2 | Exposure | **Only the web UI is public.** API, bot, and DB are internal with no published ports, and the edge proxies an allowlist of routes. | §3, §7.5 |
| D3 | Server-side copy | **Not supported.** | §1.2, §9 |
| D4 | Admin visibility | **Admins can see other users' file names, folder trees, sizes, and usage** (read-only metadata) for moderation. Content stays off-limits through the UI and API. | §7.2, §7.4, §9, §10 |
| D5 | Mirroring to a second store | **No.** Discord is the only blob store. | §1.2, §14 |
| D6 | Topology | **Everything on the same VPS**, running **Fedora Linux**. Development happens locally on Windows for now. | §3.2, §13 |
| D7 | Scale | **Few users, many files.** Built for scalability: small-file packing, batched journal, keyset pagination, eventually consistent folder stats, stateless API. | §2, §6.6, §8, §12 |
| D8 | How does recovery find the snapshot without the DB? | Each backup pointer carries an **encrypted manifest** (chunk locations, wrapped DEK). The journal records blob locations, its IDs follow commit order, and the high-water mark is read inside the dump's own snapshot. Backups are always solo blobs, compaction journals a move only after the new pack is stored, and retired master keys are kept. | §4, §6.6, §7.3, §8, §15 |
| D9 | What does the frame's GCM tag authenticate? | The AAD covers the **frame header plus a typed context** (file chunk, journal batch, backup manifest, with one type reserved for thumbnails); a format 2 segment's adds its index and whether it is the last (D37). Wrapped DEKs are bound to their version. | §6.5, §7.3 |
| D10 | Blob size invariant | `BLOB_MAX_BYTES` (20 MiB − 64 KiB) is a hard cap. `CHUNK_SIZE` is 20 MiB − 128 KiB, so a frame always fits, and the packer adds a frame only if it fits. | §2, §6.6, §7.3, §12.2, §15 |
| D11 | Live events with several API replicas | Postgres **`LISTEN/NOTIFY`**, sent in the same transaction as the change, with one listener connection per API instance. | §6.1, §9, §12.1 |
| D12 | Share link routing | `/s/:token` is an **SPA route**, and its data comes from `/api/s/*`. The edge proxies only `/api/*`. | §3, §7.2, §7.5, §9, §10.1 |
| D13 | Thumbnails | **Deferred to after v1.** The grid shows file-type icons. The planned design (an extra encrypted frame per image version) has AAD type `0x02` reserved, so adding it needs no format change. | §1.2, §7.3, §10.1, §18 |
| D14 | Build order | **UI first, against a mock API.** MSW serves the §9 contract in the browser during development, so the web app is built and tested before the API and bot exist. | §10, §13.1, §14 |
| D15 | Live connection: SSE or WebSockets? | **SSE**, with typed payloads. Traffic is one-way (the browser talks back over plain HTTP), SSE shares the API's HTTP/2 connection through Caddy, and it fits the `LISTEN/NOTIFY` fan-out (D11). A 25 s ping catches dead connections. | §6.1, §9, §10 |
| D16 | Drag-to-move | **A small pointer-event controller** instead of `@dnd-kit`. Folders spring open mid-drag and remount the list, so the drag must outlive the list it started in; one animation-frame loop with direct DOM writes keeps it fast without a dependency. | §10 |
| D17 | Downloading several items | `POST /archive {ids}` returns a **short-lived, single-use link** that streams the ZIP. The browser downloads it natively (progress, no memory buffering), and state-changing requests stay JSON with a CSRF header. | §6.2, §9 |
| D18 | Public share access | `GET /s/:token` answers `{locked: true}` until a password-protected link is unlocked, so a link reveals nothing without its password. Locked and wrong-password answers are `403`, dead links `410` with a reason, and `401` stays reserved for "sign in to the app". | §7.5, §9, §10.1 |
| D19 | Backend build order | **API first, Discord later:** M0, then M2 on `LocalBlobStore` (files already encrypted as DFS1 frames, the bot running as a worker without Discord), then M1. The finished UI runs against a real server one milestone sooner; the Discord work is unchanged, only later. | §18 |
| D20 | Uploading onto an existing name | **A new version** of that file (matched by `name_key`), switching over only when the upload completes; a matching folder is a `409`. Renames and moves still refuse clashes. The web app asks first: replace, keep both (renamed) or skip. | §5.1, §6.1, §9 |
| D21 | Signing in during development | **Superseded by D27.** Was a development-only sign-in (`DEV_LOGIN=1`) to avoid needing Discord. Password sign-in doesn't use Discord, so development signs in like production, and `dfs owner` makes its first account. | §7.1, §13.1 |
| D22 | Running the backend's TypeScript | **Node runs the sources directly** (type stripping): no build step for api, bot and packages. Imports name their `.ts` files, there are no path aliases at runtime, and those packages are typechecked with Node's module rules. | §13, §14.1, §14.2 |
| D23 | First deployment | **Once Discord storage works** (after M1), as a private instance with test data only, until the M4 recovery drill passes. | §18 |
| D24 | Old versions and the quota | **They count** until purged, like the trash, so the quota measures everything a user keeps. Since D42 none is kept past the upload that replaces it; while a new version uploads, it reserves its size beside the current one. | §5.1, §6.1 |
| D25 | Discord for development | **The production server and bot**, with development in its own `DFS Dev` category, REST only (no gateway). Each environment works only in the channels registered in its own database. Rate limits are shared, so load tests never use Discord. | §4, §6.1, §13.1, §15, §17 |
| D26 | Code hosting and checks | **A private GitHub repository, no CI.** `pnpm check` runs locally before pushing. The VPS was to pull with a read-only deploy key; at the first deployment the owner chose otherwise (2026-10-06): the VPS has no access to the repository, and `docker/deploy.sh` sends it the committed code (§13.2). | §13.2 |
| D27 | Who may sign in | **People an admin made an account for**, with a username and a temporary password. They choose their own password at their first sign-in, which activates the account. No one needs a Discord account: Discord is only storage, and the server is private to the owner. Replaces Discord sign-in (OAuth) from earlier drafts. | §5, §7.1, §9, §10.1, §15 |
| D28 | Admins and the owner | **Set in DFS** on the Users page. The owner is created on the server with `dfs owner`, is always an admin, and can't be demoted, disabled or reset from the app; the same command recovers the owner's password. | §5.1, §7.1, §9 |
| D29 | Where metrics live | **In Postgres**, in a table of half-minute, minute and hour buckets that every process adds to, read by the admin's own graphs. Not Prometheus and Grafana: two more services to run, secure and back up on one VPS, and a second sign-in, for a few dozen series that Postgres keeps in a few hundred thousand rows. | §5, §9, §16 |
| D30 | Sending a file | **One request per file**, streamed from disk, which the API cuts into parts as it arrives; progress from XMLHttpRequest's upload events. Parts sent four at a time showed progress only as each part finished, so the bar jumped and the speed fell to nothing between them; one stream keeps the connection busy and its progress true. Resuming starts at the first part missing, and the parts' hashes are checked at completion. Small files keep their single `PUT`. | §3.2, §6.1, §6.5, §10.2 |
| D31 | Messages deleted outside DFS | **They don't happen** (the user's decision, 2026-10-07): only the bot reaches DFS's channels, so no one else can delete a storage message. There is no watch for deletions, no `lost` state for blobs or versions, no tamper alert and no recovery of a lost blob from the CDN's cache. Discord itself losing data is left to the scrubber, if built. | §2, §5.2, §6.5, §8, §11 |
| D32 | Which packs compaction merges | **Those that hold little:** live bytes under `COMPACT_THRESHOLD` of a full pack, whatever their own size, a week old, two or more into one (the user's decision, 2026-10-07). A live/size ratio would leave the small packs a lone upload seals, each a whole message, and rewriting one pack alone saves none. Deleted files' bytes leave Discord only when their pack is merged. | §6.6 |
| D33 | Previews | **Images, PDFs, text and code first**; audio and video after, as their own part, with a dedicated player and streaming (the user's decision, 2026-10-08). PDFs through pdf.js, the same on every browser, Android's included, without loosening the rules against framing; text through a read-only CodeMirror, Markdown formatted and JSON pretty-printed. Viewing a shared file never counts toward its download limit; only Download does. No version history: a file has only its current version (D42). Office documents stay out. | §1.2, §6.2, §7.5, §9, §10.3 |
| D34 | Audio and video streaming | **Direct play when the browser decodes the file; otherwise another player (the device's own first, then VLC), through a stream link, from one Open in… menu; nothing is converted on the server** (the user's decisions: 2026-10-08, direct play, remux and transcode, then, the VPS having 6 cores, no video hardware and other work, no transcoding; 2026-10-10, the remux dropped once built, for VLC). What the browser can't play (a picture it can't decode, a file it can't open) says so, with Open in… (another player) and Download; what it plays in part (without its sound, picture subtitles or other sound tracks) plays with a warning that offers another player. A stream link is a share link's address for another player, public and lasting as the link does (the user's decision, 2026-10-10: "they're just shared links"); the device's own player where a page can open it (Android), then VLC; others an entry in a list. HDR plays as the browser plays it, tone-mapped by it on an SDR screen, and DFS makes no SDR copy. ffmpeg runs in a media service that holds no secret and reads only the files it is asked to examine. Shared links play the same way. Media info is examined once per version and not journaled. Seek thumbnails come later, as important. | §3.1, §6.7, §7.4, §9, §15 |
| D35 | Audio and video players | **A video player in the viewer, and an audio player bar** that plays on while the user browses, with the folder as its queue (the user's decision, 2026-10-08): own controls and keys, Media Session, subtitles inside or beside the file, chapters, and where each user stopped kept on the server. No "next video" (the user's decision, 2026-10-09). A music library and gapless playback are not planned now. | §10.4 |
| D36 | Starting storage over | When the chunk size went to 20 MiB, the user chose to delete every file stored in 10 MiB chunks rather than keep both, keeping the accounts (2026-10-08). `dfs reset-storage` deletes files, blobs, the storage channels and the journal, keeps accounts, folders, links to folders and the audit log, and journals those again from batch 1, so recovery stays complete; a test recovers from that journal and compares the databases. Only the operator runs it, with the API and the bot stopped (docs/DEPLOY.md). | §8, §15 |
| D37 | Reading part of a chunk | **Chunks are sealed in segments of 256 KiB, each with its own tag (frame format 2)**, so the API streams from Discord by `Range` only the segments a request covers, checking each before sending it on (the user's decision, 2026-10-09, given it is as fast as sending bytes unchecked, which it is). Sending unchecked bytes was the other way, faster to build, but a range that stops before the end of a chunk would never be checked, so DFS's own bugs (a read at the wrong offset, a frame mapped wrong after compaction), disk errors and a CDN serving wrong bytes would go out silently. A cold seek's first byte went from 2.7–3.0 s to 0.4–0.5 s through the development machine's link (0.14–0.19 s behind Caddy, from cache-warm Discord). Format 1 stays for journal batches and is still read; code from before format 2 can't read files stored after it, so deploys can't roll back past it. Production had no files when it came (D36). | §6.2, §7.3 |
| D38 | Files larger than staging | **Capped at staging's size, and a stream reserves staging for what it has yet to send** (the user's decision, 2026-10-11, of the two ways §18.1 held open). An upload that has started always has room to finish, one that can't get room waits before sending anything, and the oldest waiting goes first. The other way, posting a receiving upload's frames to Discord as they arrive, would have had no cap, but would have left posted blobs of uploads given up for the GC. The cap is 30 GiB in production (`STAGING_MAX_BYTES`). Planned, not built. | §6.1, §6.8, §6.9, §18.1 |
| D39 | Mounting the drive | **WebDAV, served by the API at `/dav`**, signed in with a device token and never the account password (planned 2026-10-11). macOS and Linux mount it without installing anything, and rclone better on every system; Windows' own client, deprecated by Microsoft since November 2023, is a convenience while it lasts, so on Windows the mount is rclone's (2026-10-12). It goes through the edge and TLS DFS already has. Deleting moves to the trash, except an editor's scratch files made in the last 10 minutes; writing onto a name is a new version (D20), and renaming over a file keeps that file's node, links and positions; there is no `COPY` (D3); locks are there for Finder and Office; locked folders show empty. SMB and a FUSE client of DFS's own were set aside. Planned, not built. | §1.2, §3.2, §6.8, §7.6 |
| D40 | Desktop app | **One-way backup, a mirror without history** (the user's decisions, 2026-10-11): an Electron tray app for Windows that uploads what changes in chosen folders, moves what was renamed or moved, sends what was deleted to the trash, touches only what it put in the drive, restores on demand, and pauses when a run would replace or trash more than 50 files and 10% of a source. A replaced file is replaced, as everywhere in DFS: keeping replaced versions 30 days was offered and declined. At each full scan it checks its index against the drive and sends again what the drive lacks or holds older, which also recovers uploads a server crash forgot (D43). Two-way sync is a non-goal: it needs a feed of changes and conflict handling. Planned, not built. | §1.2, §6.9, §7.6 |
| D41 | Locked folders | **Sealed with a code** (the user's decision, 2026-10-11, over a gate the API alone enforces and over end-to-end encryption in the browser): one lock code per account, of 6 characters or more (a PIN will do, though a longer code resists offline guessing with the master key far better), with a recovery key; inside a locked folder, names, types and data keys are encrypted under a key only the code or the recovery key opens, so a stolen database with the master key, admins and DFS itself can't read them while it is locked. The server sees the code and the files while a folder is open, in one browser, until 15 minutes pass with nothing done inside. No links, search, mount or backup inside; a forgotten code and recovery key lose the contents. Files already in DFS are re-encrypted as they go in, their old frames deleted from Discord, and admins' audit entries about them lose their names (the user's decisions, 2026-10-11): re-wrapping keys alone would have left them readable to anyone with the master key and the journal. Only their earlier names stay, in journal batches under the master key. Planned, not built. | §1.2, §7.2, §7.4, §7.7, §8 |
| D42 | Replacing a shared file | **Its share links are deleted** (the user's decisions, 2026-10-11: "to avoid accidentally sharing something that wasn't intended to be shared"; deleted at once, rather than kept in the owner's list as dead links), over keeping the version replaced while a link served it (D24, D33, from 2026-10-07) and over links following the file. Replacing a file purges the version it replaces as the upload completes, so a file has only its current version, and deletes the file's links in the same transaction; its owner makes a new link to share the file as it is now. A folder link shows the updated file (the user's decision), as it shows files added to the folder. Edits saved through the mount and changes the backup app sends replace files too, so they delete those files' links (§6.8, §6.9). | §1.2, §5.1, §6.1, §7.5 |
| D43 | Completing uploads | **Without waiting for the disk** (`synchronous_commit = off` for a completion's transaction; the user's choice, 2026-10-12), over sending small files several to a request, completed in one transaction (built, then dropped by the user: a failure resends a whole batch, a pause restarts its batch, files finish in bursts, more quota held ahead). On production, small files completed about 26 a second, each queued on the user's row and the journal lock while its commit waited for the disk, about 25 ms each in turn: some 40 a second at most, whatever the bandwidth. The cost: a crash of Postgres or the VPS can forget about the last second of completions, whose files come back as unfinished uploads to send again. Devices' uploads complete the same way (the user's choice, 2026-10-12, over making them wait for the disk): the backup app checks its index against the drive at each full scan and sends again what was forgotten, and a mount, which can't, accepts that rare loss. | §6.1, §6.8, §6.9, §8 |
| D44 | Finishing an upload | **Drop the folder again** (the user's choice, 2026-10-12, after a large folder's failures were hard to find and retry): files already uploaded, the same size and modification date, are recognized by the server and skipped without asking, so only what isn't there goes; a report in the panel says what became of each file, and downloads as CSV. Over keeping uploads or their report beyond the page (uploads live in their page, 2026-10-07). | §6.1, §10.2 |

No question is open.
